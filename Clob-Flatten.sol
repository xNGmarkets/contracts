// Sources flattened with hardhat v2.26.3 https://hardhat.org

// SPDX-License-Identifier: MIT

// File contracts/interfaces/IMoveAdapter.sol

// IMoveAdapter.sol
// Original license: SPDX_License_Identifier: MIT
pragma solidity ^0.8.20;

interface IMoveAdapter {
    // move `token` from `from` to `to` for `amount`
    function move(address token, address from, address to, uint256 amount) external;
}


// File contracts/interfaces/IOracleHub.sol

// Original license: SPDX_License_Identifier: MIT
pragma solidity ^0.8.24;

interface IOracleHub {
    struct PricePayload {
        uint256 priceE6;
        uint64 seq;
        uint64 ts;
        bytes32 hcsMsgId;
    }
    struct BandPayload {
        uint256 midE6;
        uint32 widthBps;
        uint64 ts;
    }

    function getPrice(
        address asset
    ) external view returns (PricePayload memory);

    function getBand(address asset) external view returns (BandPayload memory);

    function maxStaleness() external view returns (uint64);
}


// File contracts/Clob.sol

// Original license: SPDX_License_Identifier: MIT
pragma solidity ^0.8.20;

/**
 * xNG — Minimal CLOB (Market/Limit) with Dynamic-Band & Staleness guards.
 *
 * Settlement model: DIRECT-SETTLE (non-custodial)
 *  - Adapter never holds balances. It only moves tokens buyer→seller and buyer→feeSink using transferFrom.
 *  - Users must approve the adapter for the required amounts (USDC for buyer; xNGX for seller).
 *  - On Hedera HTS via EVM addresses: users (and the fee sink) must be associated (and KYC’d if enforced).
 *
 * **Invariants & Units**
 *  - USDC and all xNGX tokens use 6 decimals (1e6)
 *  - Prices are in USD * 1e6 (pxE6). Example: $4.17 → 4_170_000
 *  - Quantities (qty) are in asset base units (1e6). Example: 100 tokens → 100_000_000
 *  - Notional = (qty * pxE6) / 1e6  → USD * 1e6
 */


contract Clob {
    // ========= Types =========
    enum VenueState {
        Paused,
        Continuous,
        CallAuction
    }
    enum Side {
        Buy,
        Sell
    }

    struct Order {
        address trader; // msg.sender
        address asset; // xNGX token
        Side side; // buy or sell
        bool isMarket; // market vs limit
        uint128 qty; // asset units (6 dp)
        uint128 pxE6; // USD * 1e6 (ignored for market)
        uint64 ts; // place timestamp
        bool active; // open on book
    }

    struct BestPx {
        uint128 bidE6;
        uint128 askE6;
    }

    // ========= Storage =========
    address public owner;
    address public immutable USDC; // quote token (6 dp)
    IOracleHub public oracle;
    IMoveAdapter public adapter;
    address public feeSink; // receives fees in USDC

    // NEW: FX asset (OracleHub asset that carries NGN per USD, scaled 1e6)
    address public fxAsset;
    event FxAssetSet(address fxAsset);

    // per-asset config
    mapping(address => uint16) public feeBps; // 1 = 1bp
    mapping(address => VenueState) public venue;

    // order book
    Order[] public orders;
    mapping(address => uint256[]) public bids; // order ids (may include inactive; filter on read)
    mapping(address => uint256[]) public asks; // order ids (may include inactive; filter on read)

    // events
    event OwnerTransferred(address indexed newOwner);
    event VenueSet(address indexed asset, VenueState state);
    event FeeSinkSet(address indexed sink);
    event FeeBpsSet(address indexed asset, uint16 feeBps);
    event OrderPlaced(
        uint256 id,
        address indexed trader,
        address indexed asset,
        Side side,
        bool isMarket,
        uint128 qty,
        uint128 pxE6
    );
    event OrderCanceled(uint256 id, address indexed trader);
    event Trade(
        address indexed asset,
        uint256 buyId,
        uint256 sellId,
        address indexed buyer,
        address indexed seller,
        uint128 qty,
        uint128 pxE6,
        uint128 notionalE6,
        uint128 feeE6
    );

    // ========= Reentrancy guard / Modifiers =========
    uint256 private _status = 1;
    modifier nonReentrant() {
        require(_status == 1, "reentrant");
        _status = 2;
        _;
        _status = 1;
    }
    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    // ========= Constructor =========
    constructor(
        address _owner,
        address _oracle,
        address _adapter,
        address _usdc,
        address _feeSink
    ) {
        require(
            _owner != address(0) &&
                _oracle != address(0) &&
                _adapter != address(0) &&
                _usdc != address(0) &&
                _feeSink != address(0),
            "zero"
        );
        owner = _owner;
        oracle = IOracleHub(_oracle);
        adapter = IMoveAdapter(_adapter);
        USDC = _usdc;
        feeSink = _feeSink;
    }

    // ========= Admin =========
    function setVenue(address asset, VenueState state) external onlyOwner {
        venue[asset] = state;
        emit VenueSet(asset, state);
    }

    function setFeeSink(address sink) external onlyOwner {
        require(sink != address(0), "zero");
        feeSink = sink;
        emit FeeSinkSet(sink);
    }

    function setFeeBps(address asset, uint16 bps) external onlyOwner {
        require(bps <= 1000, "fee>10%");
        feeBps[asset] = bps;
        emit FeeBpsSet(asset, bps);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        owner = newOwner;
        emit OwnerTransferred(newOwner);
    }

    /// @notice NEW: set FX asset used for NGN→USD conversion via OracleHub
    function setFxAsset(address _fxAsset) external onlyOwner {
        require(_fxAsset != address(0), "fx:zero");
        fxAsset = _fxAsset;
        emit FxAssetSet(_fxAsset);
    }

    // ========= Views / Helpers =========
    function ordersLength() external view returns (uint256) {
        return orders.length;
    }

    // --- NGN→USD conversion using FX asset from OracleHub (NEW) ---
    /// @dev Convert NGN (e6) to USD (e6) using NGN per USD (e6)
    function _toUsdE6(
        uint256 ngnPxE6,
        uint256 ngnPerUsdE6
    ) internal pure returns (uint256) {
        // usd = ngn * 1e6 / (ngn per usd)
        return (ngnPxE6 * 1_000_000) / ngnPerUsdE6;
    }

    /// @notice NEW: Read equity band (NGN) + FX, return USD band
    function _freshBandUSD(
        address asset
    ) internal view returns (uint256 loUsdE6, uint256 hiUsdE6, uint64 ts) {
        IOracleHub.BandPayload memory b = oracle.getBand(asset);
        require(b.midE6 > 0, "no band");
        uint64 maxS = oracle.maxStaleness();
        require(
            block.timestamp <= uint256(b.ts) + uint256(maxS),
            "stale/oracle"
        );

        // FX as an OracleHub asset: midE6 = NGN per 1 USD (e6)
        IOracleHub.BandPayload memory fxB = oracle.getBand(fxAsset);
        require(fxB.midE6 > 0, "no fx");
        require(block.timestamp <= uint256(fxB.ts) + uint256(maxS), "stale/fx");

        uint256 midUsdE6 = _toUsdE6(uint256(b.midE6), uint256(fxB.midE6));
        uint256 delta = (midUsdE6 * uint256(b.widthBps)) / 10_000; // keep equity width
        loUsdE6 = midUsdE6 - delta;
        hiUsdE6 = midUsdE6 + delta;
        ts = b.ts <= fxB.ts ? b.ts : fxB.ts; // effective "as-of"
    }

    /// @notice CHANGED: band returned in USD after NGN→USD conversion
    function bandRange(
        address asset
    ) public view returns (uint256 lo, uint256 hi, uint64 ts) {
        require(fxAsset != address(0), "fx:not set");
        (lo, hi, ts) = _freshBandUSD(asset);
    }

    /// @dev Oracle freshness guard (equity band only; FX checked in _freshBandUSD)
    function isFresh(uint64 ts) public view returns (bool) {
        uint64 maxS = oracle.maxStaleness();
        return (block.timestamp <= uint256(ts) + uint256(maxS));
    }

    // Best-of-book (derived from open orders)
    function best(address asset) public view returns (BestPx memory) {
        BestPx memory bp;
        uint256[] storage B = bids[asset];
        uint256[] storage A = asks[asset];

        for (uint256 i = 0; i < B.length; i++) {
            Order storage o = orders[B[i]];
            if (!o.active || o.asset != asset || o.side != Side.Buy) continue;
            if (o.pxE6 > bp.bidE6) bp.bidE6 = o.pxE6;
        }
        for (uint256 j = 0; j < A.length; j++) {
            Order storage o2 = orders[A[j]];
            if (!o2.active || o2.asset != asset || o2.side != Side.Sell)
                continue;
            if (bp.askE6 == 0 || o2.pxE6 < bp.askE6) bp.askE6 = o2.pxE6;
        }
        return bp;
    }

    /// IDs only (kept for compatibility)
    function ordersOf(
        address asset,
        bool isBids
    ) external view returns (uint256[] memory) {
        return isBids ? bids[asset] : asks[asset];
    }

    // ======= Rich read helpers for UIs (NEW) =======
    /// @notice Return the full order struct for a given id (copy from storage)
    function getOrder(uint256 id) external view returns (Order memory o) {
        o = orders[id];
    }

    /// @notice Return ACTIVE bids and asks (structs) for a given asset
    function getOrderBook(
        address asset
    )
        external
        view
        returns (Order[] memory bidOrders, Order[] memory askOrders)
    {
        // count actives first (so we can allocate tight arrays)
        uint256 bc;
        uint256 ac;
        uint256[] storage B = bids[asset];
        uint256[] storage A = asks[asset];

        for (uint256 i = 0; i < B.length; i++) {
            Order storage o = orders[B[i]];
            if (o.active && o.asset == asset && o.side == Side.Buy) bc++;
        }
        for (uint256 j = 0; j < A.length; j++) {
            Order storage o2 = orders[A[j]];
            if (o2.active && o2.asset == asset && o2.side == Side.Sell) ac++;
        }

        bidOrders = new Order[](bc);
        askOrders = new Order[](ac);

        uint256 bi;
        uint256 ai;
        for (uint256 i2 = 0; i2 < B.length; i2++) {
            Order storage ob = orders[B[i2]];
            if (ob.active && ob.asset == asset && ob.side == Side.Buy) {
                bidOrders[bi++] = ob;
            }
        }
        for (uint256 j2 = 0; j2 < A.length; j2++) {
            Order storage oa = orders[A[j2]];
            if (oa.active && oa.asset == asset && oa.side == Side.Sell) {
                askOrders[ai++] = oa;
            }
        }
    }

    /// @notice Return all ACTIVE open orders for a user (ids + structs)
    function getOpenOrders(
        address user
    ) external view returns (uint256[] memory ids, Order[] memory os) {
        // first pass: count
        uint256 cnt;
        for (uint256 i = 0; i < orders.length; i++) {
            Order storage o = orders[i];
            if (o.active && o.trader == user) cnt++;
        }
        ids = new uint256[](cnt);
        os = new Order[](cnt);

        // second pass: fill
        uint256 k;
        for (uint256 i2 = 0; i2 < orders.length; i2++) {
            Order storage o2 = orders[i2];
            if (o2.active && o2.trader == user) {
                ids[k] = i2;
                os[k] = o2;
                k++;
            }
        }
    }

    // ======= PAGINATION =======
    /**
     * @notice Page through an asset’s order book *one side at a time*.
     * @param asset   xNGX token
     * @param side    0 = Buy, 1 = Sell
     * @param cursor  Array index cursor into bids[asset] or asks[asset] (not orderId)
     * @param limit   Max number of active orders to return (defaults to 50 if 0)
     * @return ordersOut Active orders (struct copies)
     * @return nextCursor Next array index to continue from (== length when exhausted)
     */
    function getOrderBookPage(
        address asset,
        uint8 side,
        uint256 cursor,
        uint256 limit
    ) external view returns (Order[] memory ordersOut, uint256 nextCursor) {
        require(side <= 1, "side");
        uint256[] storage arr = (side == 0) ? bids[asset] : asks[asset];
        uint256 n = arr.length;
        if (cursor > n) cursor = n;
        if (limit == 0) limit = 50;

        // count up to 'limit'
        uint256 count;
        uint256 i = cursor;
        while (i < n && count < limit) {
            Order storage o = orders[arr[i]];
            if (o.active && o.asset == asset && uint8(o.side) == side) count++;
            i++;
        }

        ordersOut = new Order[](count);

        // fill
        uint256 k;
        i = cursor;
        while (i < n && k < count) {
            Order storage o2 = orders[arr[i]];
            if (o2.active && o2.asset == asset && uint8(o2.side) == side) {
                ordersOut[k++] = o2;
            }
            i++;
        }

        nextCursor = i;
    }

    /**
     * @notice Page through all ACTIVE open orders for a user by scanning the global orders array.
     * @param user     Trader address
     * @param cursor   Starting orderId to scan from (0..orders.length)
     * @param limit    Max number to return (defaults to 50 if 0)
     * @return idsOut      Order IDs (active only)
     * @return ordersOut   Order structs (active only)
     * @return nextCursor  Next orderId to continue from (== length when exhausted)
     */
    function getOpenOrdersPage(
        address user,
        uint256 cursor,
        uint256 limit
    )
        external
        view
        returns (
            uint256[] memory idsOut,
            Order[] memory ordersOut,
            uint256 nextCursor
        )
    {
        uint256 n = orders.length;
        if (cursor > n) cursor = n;
        if (limit == 0) limit = 50;

        // count
        uint256 count;
        uint256 i = cursor;
        while (i < n && count < limit) {
            Order storage o = orders[i];
            if (o.active && o.trader == user) count++;
            i++;
        }

        idsOut = new uint256[](count);
        ordersOut = new Order[](count);

        // fill
        uint256 k;
        i = cursor;
        while (i < n && k < count) {
            Order storage o2 = orders[i];
            if (o2.active && o2.trader == user) {
                idsOut[k] = i;
                ordersOut[k] = o2;
                k++;
            }
            i++;
        }

        nextCursor = i;
    }

    // ========= Order entry =========
    function place(
        address asset,
        Side side,
        bool isMarket,
        uint128 qty,
        uint128 pxE6
    ) external returns (uint256 id) {
        require(qty > 0, "qty");
        require(venue[asset] == VenueState.Continuous, "venue off");

        (uint256 lo, uint256 hi, uint64 ts) = bandRange(asset);
        require(isFresh(ts), "stale/halt");
        if (!isMarket) {
            require(pxE6 >= lo && pxE6 <= hi, "band");
        }

        id = orders.length;
        orders.push(
            Order({
                trader: msg.sender,
                asset: asset,
                side: side,
                isMarket: isMarket,
                qty: qty,
                pxE6: pxE6,
                ts: uint64(block.timestamp),
                active: true
            })
        );

        if (side == Side.Buy) {
            bids[asset].push(id);
        } else {
            asks[asset].push(id);
        }

        emit OrderPlaced(id, msg.sender, asset, side, isMarket, qty, pxE6);
    }

    function cancel(uint256 id) external {
        Order storage o = orders[id];
        require(o.active, "inactive");
        require(o.trader == msg.sender, "not owner");
        o.active = false;
        emit OrderCanceled(id, o.trader);
    }

    // ========= Matching =========
    function matchBest(
        address asset,
        uint256 maxMatches
    ) external nonReentrant {
        require(venue[asset] == VenueState.Continuous, "venue off");
        (uint256 lo, uint256 hi, uint64 ts) = bandRange(asset);
        require(isFresh(ts), "stale/halt");

        uint256[] storage B = bids[asset];
        uint256[] storage A = asks[asset];

        uint256 matches;
        for (uint256 i = 0; i < B.length && matches < maxMatches; i++) {
            uint256 buyId = B[i];
            Order storage buy = orders[buyId];
            if (!buy.active) continue;

            for (uint256 j = 0; j < A.length && matches < maxMatches; j++) {
                uint256 sellId = A[j];
                Order storage sell = orders[sellId];
                if (!sell.active) continue;
                if (sell.asset != asset || buy.asset != asset) continue;

                // block self-trade
                if (buy.trader == sell.trader) continue;

                uint128 execPxE6 = _executablePx(buy, sell);
                if (execPxE6 == 0) continue; // not crossed
                require(execPxE6 >= lo && execPxE6 <= hi, "band");

                uint128 qty = buy.qty <= sell.qty ? buy.qty : sell.qty;
                _settleTrade(asset, buyId, sellId, qty, execPxE6);
                matches++;
            }
        }
    }

    // crossing rule
    function _executablePx(
        Order storage buy,
        Order storage sell
    ) internal view returns (uint128) {
        if (buy.isMarket && sell.isMarket) return 0;
        if (buy.isMarket) return sell.pxE6;
        if (sell.isMarket) return buy.pxE6;
        if (buy.pxE6 < sell.pxE6) return 0; // not crossed
        return sell.pxE6; // price-time: execute at resting (sell) price
    }

    // settlement
    function _settleTrade(
        address asset,
        uint256 buyId,
        uint256 sellId,
        uint128 qty,
        uint128 pxE6
    ) internal {
        Order storage buy = orders[buyId];
        Order storage sell = orders[sellId];

        uint128 notionalE6 = uint128(
            (uint256(qty) * uint256(pxE6)) / 1_000_000
        );
        uint16 fee = feeBps[asset];
        uint128 feeE6 = uint128((uint256(notionalE6) * uint256(fee)) / 10_000);

        // USDC: buyer→seller (net), buyer→feeSink (fee)
        adapter.move(USDC, buy.trader, sell.trader, notionalE6 - feeE6);
        if (feeE6 > 0) adapter.move(USDC, buy.trader, feeSink, feeE6);

        // asset: seller→buyer
        adapter.move(asset, sell.trader, buy.trader, qty);

        // reduce/close
        buy.qty -= qty;
        sell.qty -= qty;
        if (buy.qty == 0) buy.active = false;
        if (sell.qty == 0) sell.active = false;

        emit Trade(
            asset,
            buyId,
            sellId,
            buy.trader,
            sell.trader,
            qty,
            pxE6,
            notionalE6,
            feeE6
        );
    }
}
