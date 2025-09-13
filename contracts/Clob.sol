// SPDX-License-Identifier: MIT
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
 *  - USDC and all xNGX tokens use 6 decimals (1 token = 1e6 base units)
 *  - Prices are in USD * 1e6 (pxE6). Example: $4.17 → 4_170_000
 *  - Quantities (qty) are in asset base units (1e6). Example: 100 tokens → 100_000_000
 *  - **Notional is computed as (qty * pxE6) / 1e6** to keep result in USD * 1e6
 *  - Fees are taken in USDC (quote), not from asset quantity
 *
 * Notes:
 *  - Band enforced at entry AND at match time; stale oracle halts matching.
 */

import {IOracleHub} from "./interfaces/IOracleHub.sol";
import {IMoveAdapter} from "./interfaces/IMoveAdapter.sol";

contract Clob {
    // ============ Types ============
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
        address trader; // EOA placing the order
        address asset; // xNGX token (HTS EVM address ok)
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

    // ============ Storage ============
    address public owner;
    address public immutable USDC; // quote token (6 dp)
    IOracleHub public oracle;
    IMoveAdapter public adapter;
    address public feeSink; // receives fees in USDC
    uint16 public feeBps = 20; // 0.20% (20 bps)

    mapping(address => VenueState) public venue; // per-asset venue state
    mapping(address => uint256[]) public bids; // asset => orderIds
    mapping(address => uint256[]) public asks; // asset => orderIds
    Order[] public orders; // orderId = index

    // Reentrancy guard (simple)
    uint256 private _lock = 1;
    modifier nonReentrant() {
        require(_lock == 1, "reentrancy");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ============ Events ============
    event Placed(
        uint256 indexed id,
        address indexed asset,
        address indexed trader,
        Side side,
        bool isMarket,
        uint128 qty,
        uint128 pxE6
    );
    event Cancelled(uint256 indexed id);
    event Trade(
        address indexed asset,
        uint256 indexed buyId,
        uint256 indexed sellId,
        address buyer,
        address seller,
        uint128 qty,
        uint128 pxE6,
        uint256 notionalE6,
        uint256 feeE6
    );
    event VenueSet(address indexed asset, VenueState state);
    event FeeSinkSet(address sink);
    event FeeBpsSet(uint16 bps);
    event OracleSet(address oracle);
    event AdapterSet(address adapter);
    event OwnerTransferred(address indexed newOwner);

    // ============ Modifiers ============
    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    // ============ Constructor ============
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

    // ============ Admin ============
    function setVenue(address asset, VenueState state) external onlyOwner {
        venue[asset] = state;
        emit VenueSet(asset, state);
    }

    function setFeeSink(address sink) external onlyOwner {
        require(sink != address(0), "zero");
        feeSink = sink;
        emit FeeSinkSet(sink);
    }

    function setFeeBps(uint16 bps) external onlyOwner {
        require(bps <= 1000, "fee too high"); // cap at 10%
        feeBps = bps;
        emit FeeBpsSet(bps);
    }

    function setOracle(address o) external onlyOwner {
        require(o != address(0), "zero");
        oracle = IOracleHub(o);
        emit OracleSet(o);
    }

    function setAdapter(address a) external onlyOwner {
        require(a != address(0), "zero");
        adapter = IMoveAdapter(a);
        emit AdapterSet(a);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        owner = newOwner;
        emit OwnerTransferred(newOwner);
    }

    // ============ Views ============
    function ordersLength() external view returns (uint256) {
        return orders.length;
    }

    /// @notice Returns current band range for an asset using oracle mid/width
    function bandRange(
        address asset
    ) public view returns (uint256 lo, uint256 hi, uint64 ts) {
        IOracleHub.BandPayload memory b = oracle.getBand(asset);
        require(b.midE6 > 0, "no band");
        uint256 delta = (uint256(b.midE6) * uint256(b.widthBps)) / 10000; // bps
        lo = b.midE6 - delta;
        hi = b.midE6 + delta;
        ts = b.ts;
    }

    /// @dev Oracle freshness guard
    function isFresh(uint64 ts) public view returns (bool) {
        uint64 maxS = oracle.maxStaleness();
        return (block.timestamp <= uint256(ts) + uint256(maxS));
    }

    /// @notice Best bid/ask snapshot by linear scan (sufficient for MVP)
    function best(address asset) external view returns (BestPx memory bp) {
        uint256[] storage B = bids[asset];
        uint256[] storage A = asks[asset];
        uint128 bestBid;
        uint128 bestAsk;
        for (uint256 i = 0; i < B.length; i++) {
            Order storage o = orders[B[i]];
            if (o.active && o.pxE6 > bestBid) bestBid = o.pxE6;
        }
        for (uint256 j = 0; j < A.length; j++) {
            Order storage o = orders[A[j]];
            if (o.active && (bestAsk == 0 || o.pxE6 < bestAsk))
                bestAsk = o.pxE6;
        }
        bp = BestPx(bestBid, bestAsk);
    }

    // ============ Order entry ============
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
        emit Placed(id, asset, msg.sender, side, isMarket, qty, pxE6);
    }

    function cancel(uint256 id) external {
        Order storage o = orders[id];
        require(o.active, "inactive");
        require(o.trader == msg.sender, "not owner");
        o.active = false;
        emit Cancelled(id);
    }

    // ============ Matching ============
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

                // Prevent self-trade
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

    function _executablePx(
        Order storage buy,
        Order storage sell
    ) internal view returns (uint128 pxE6) {
        if (!buy.active || !sell.active) return 0;
        if (buy.asset != sell.asset) return 0;

        if (buy.isMarket && sell.isMarket) {
            IOracleHub.BandPayload memory b = oracle.getBand(buy.asset);
            return uint128(b.midE6);
        }
        if (buy.isMarket && !sell.isMarket) return sell.pxE6;
        if (!buy.isMarket && sell.isMarket) return buy.pxE6;

        if (buy.pxE6 >= sell.pxE6) {
            // Maker price execution (older order sets price)
            return (buy.ts >= sell.ts) ? sell.pxE6 : buy.pxE6;
        }
        return 0;
    }

    function _settleTrade(
        address asset,
        uint256 buyId,
        uint256 sellId,
        uint128 qty,
        uint128 pxE6
    ) internal {
        Order storage buy = orders[buyId];
        Order storage sell = orders[sellId];
        require(buy.active && sell.active, "inactive");
        require(qty > 0, "qty0");

        // === Correct notional math ===
        // qty and pxE6 are both scaled by 1e6, so divide by 1e6 to keep result in USD*1e6
        uint256 notionalE6 = (uint256(qty) * uint256(pxE6)) / 1e6;
        uint256 feeE6 = (notionalE6 * feeBps) / 10000; // bps

        // DIRECT-SETTLE (adapter only transferFroms; holds no balances)
        //  - USDC from buyer → seller, and buyer → feeSink
        adapter.move(USDC, buy.trader, sell.trader, notionalE6);
        adapter.move(USDC, buy.trader, feeSink, feeE6);

        //  - Asset from seller → buyer
        adapter.move(asset, sell.trader, buy.trader, qty);

        // Reduce open quantities / close if filled
        buy.qty -= qty;
        if (buy.qty == 0) buy.active = false;
        sell.qty -= qty;
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
