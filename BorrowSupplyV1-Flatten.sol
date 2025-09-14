// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Borrow & Supply — ultra-minimal pool for USDC with xNGX tokens as collateral.
 *
 * Key points
 * - USDC (6dp) is the only cash asset users can supply/withdraw/borrow.
 * - Any xNGX token (6dp) can be pledged as collateral *if* OracleHub has a fresh band price.
 * - Uniform collateral factor (LTV) = 50% by default; liquidation threshold is configurable (default 70%).
 * - Utilization-based interest: Borrow APR = base + slope * utilization.
 * - Supply APY = BorrowAPR * utilization * (1 - reserveFactor).
 * - Per-second interest accrual with global indices (borrowIndex, supplyIndex).
 * - Events for UI history. Portfolio views for lenders & borrowers.
 */

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

interface IERC20 {
    function decimals() external view returns (uint8);

    function balanceOf(address) external view returns (uint256);

    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);

    function approve(address spender, uint256) external returns (bool);

    function transfer(address to, uint256) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256
    ) external returns (bool);
}

library Hts {
    address constant PRECOMPILE = address(0x167);
    int64 constant HTS_SUCCESS = 22;

    function associateSelf(address token) internal returns (int64 rc) {
        (bool ok, bytes memory res) = PRECOMPILE.call(
            abi.encodeWithSignature(
                "associateToken(address,address)",
                address(this),
                token
            )
        );
        require(ok, "HTS associate revert");
        rc = abi.decode(res, (int64));
        require(rc == HTS_SUCCESS, "HTS associate !success");
    }
}

contract BorrowSupplyV1 {
    // -------------------- Constants & Types --------------------
    uint256 private constant ONE_E18 = 1e18;
    uint256 private constant ONE_E6 = 1e6;
    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;

    struct Collat {
        // qty in base units (6dp)
        uint128 qtyE6;
        bool listed; // to help enumeration set bookkeeping
    }

    // -------------------- Admin --------------------
    address public owner;
    IERC20 public immutable USDC;
    IOracleHub public oracle;

    // Risk / economics
    uint16 public ltvBps = 5000; // 50% LTV
    uint16 public liqBps = 7000; // 70% liquidation threshold (for health factor display)
    uint16 public reserveBps = 1000; // 10% of borrow interest to reserves

    // Interest model: APR_bps = base + slope * util_bps / 10000
    uint16 public baseBorrowBps = 200; // 2.00% base
    uint16 public slopeBorrowBps = 1800; // +18.00% at 100% utilization

    // -------------------- Accounting (global) --------------------
    uint256 public totalBorrowsE6; // principal + accrued (USDC*1e6)
    uint256 public totalReservesE6; // accumulated reserves (USDC*1e6)
    uint256 public borrowIndexE18 = ONE_E18; // starts at 1.0
    uint256 public supplyIndexE18 = ONE_E18; // starts at 1.0
    uint64 public lastAccrual; // last block.timestamp we updated indices

    // -------------------- Users --------------------
    // Lender principal (does not include yet-unrealized index growth)
    mapping(address => uint256) public supplyPrincipalE6;
    mapping(address => uint256) public supplyUserIndexE18; // snapshot of supplyIndex at last action

    // Borrower principal (does not include yet-unrealized index growth)
    mapping(address => uint256) public borrowPrincipalE6;
    mapping(address => uint256) public borrowUserIndexE18; // snapshot of borrowIndex at last action

    // Collateral per user per asset (qty in 1e6 units). We also track a simple set for enumeration.
    mapping(address => mapping(address => Collat)) public collat; // user => asset => Collat
    mapping(address => address[]) public collatList; // user => list of assets held as collat

    // -------------------- Events --------------------
    event Supplied(address indexed user, uint256 amountE6);
    event Withdrawn(address indexed user, uint256 amountE6);
    event Borrowed(address indexed user, uint256 amountE6);
    event Repaid(address indexed user, uint256 amountE6);
    event CollateralLocked(
        address indexed user,
        address indexed asset,
        uint256 qtyE6
    );
    event CollateralUnlocked(
        address indexed user,
        address indexed asset,
        uint256 qtyE6
    );
    event Accrued(
        uint256 newBorrowIndexE18,
        uint256 newSupplyIndexE18,
        uint256 totalBorrowsE6,
        uint256 totalReservesE6
    );

    event OracleSet(address oracle);
    event ParamsSet(
        uint16 ltvBps,
        uint16 liqBps,
        uint16 reserveBps,
        uint16 baseBorrowBps,
        uint16 slopeBorrowBps
    );
    event OwnerTransferred(address newOwner);

    // -------------------- Modifiers --------------------
    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor(address _usdc, address _oracle) {
        require(_usdc != address(0) && _oracle != address(0), "zero");
        owner = msg.sender;
        USDC = IERC20(_usdc);
        oracle = IOracleHub(_oracle);

        // Soft sanity (won't brick if non-standard)
        try USDC.decimals() returns (uint8 d) {
            require(d == 6, "USDC != 6dp");
        } catch {}
        lastAccrual = uint64(block.timestamp);
    }

    function htsAssociate(address token) external onlyOwner {
        Hts.associateSelf(token);
    }

    function htsAssociateMany(address[] calldata tokens) external onlyOwner {
        for (uint i = 0; i < tokens.length; i++) {
            Hts.associateSelf(tokens[i]);
        }
    }

    // -------------------- Admin --------------------
    function setOracle(address o) external onlyOwner {
        require(o != address(0), "zero");
        oracle = IOracleHub(o);
        emit OracleSet(o);
    }

    function setParams(
        uint16 _ltvBps,
        uint16 _liqBps,
        uint16 _reserveBps,
        uint16 _baseBorrowBps,
        uint16 _slopeBorrowBps
    ) external onlyOwner {
        require(
            _ltvBps <= 9000 && _liqBps <= 9500 && _ltvBps < _liqBps,
            "bad LTV"
        );
        require(_reserveBps <= 3000, "res high");
        ltvBps = _ltvBps;
        liqBps = _liqBps;
        reserveBps = _reserveBps;
        baseBorrowBps = _baseBorrowBps;
        slopeBorrowBps = _slopeBorrowBps;
        emit ParamsSet(
            ltvBps,
            liqBps,
            reserveBps,
            baseBorrowBps,
            slopeBorrowBps
        );
    }

    function transferOwnership(address n) external onlyOwner {
        require(n != address(0), "zero");
        owner = n;
        emit OwnerTransferred(n);
    }

    // -------------------- Pricing helpers --------------------
    function _freshBand(address asset) internal view returns (uint256 pxE6) {
        IOracleHub.BandPayload memory b = oracle.getBand(asset);
        require(b.midE6 > 0, "no band");
        require(
            block.timestamp <= uint256(b.ts) + uint256(oracle.maxStaleness()),
            "stale"
        );
        return uint256(b.midE6);
    }

    // -------------------- Interest model --------------------
    function _utilBps() internal view returns (uint256 uBps) {
        // utilization = borrows / (cash + borrows)
        uint256 bor = totalBorrowsE6;
        uint256 cash = USDC.balanceOf(address(this));
        if (bor == 0) return 0;
        uBps = (bor * BPS) / (cash + bor);
    }

    function currentBorrowAPR_BPS() public view returns (uint256) {
        uint256 u = _utilBps(); // 0..10000
        return uint256(baseBorrowBps) + (uint256(slopeBorrowBps) * u) / BPS;
    }

    function currentSupplyAPR_BPS() public view returns (uint256) {
        // supply ≈ borrowAPR * utilization * (1 - reserve)
        uint256 u = _utilBps();
        uint256 b = currentBorrowAPR_BPS();
        uint256 gross = (b * u) / BPS;
        return (gross * (BPS - reserveBps)) / BPS;
    }

    function utilization_BPS() external view returns (uint256) {
        return _utilBps();
    }

    // per-second rate in 1e18
    function _ratePerSecE18(uint256 aprBps) internal pure returns (uint256) {
        // APR_bps / 10000 -> APR (1e0). Convert to per-second (1e18 fixed)
        // r_ps = (apr / YEAR); scale to 1e18
        return (aprBps * 1e18) / (BPS * YEAR);
    }

    // -------------------- Accrual --------------------
    function accrue() public {
        uint64 t = uint64(block.timestamp);
        uint64 dt = t - lastAccrual;
        if (dt == 0) return;

        // Borrow rate & interest growth
        uint256 brBps = currentBorrowAPR_BPS();
        uint256 br_ps = _ratePerSecE18(brBps); // 1e18
        uint256 borrowFactorE18 = ONE_E18 + (br_ps * dt); // 1e18 + (1e18*dt) = 1e18 + ~
        if (totalBorrowsE6 > 0) {
            // interest = totalBorrows * (borrowFactor - 1)
            uint256 newBor = (totalBorrowsE6 * borrowFactorE18) / ONE_E18;
            uint256 interest = newBor - totalBorrowsE6;
            // split to reserves
            uint256 toRes = (interest * reserveBps) / BPS;
            totalReservesE6 += toRes;
            totalBorrowsE6 = newBor;
        }
        borrowIndexE18 = (borrowIndexE18 * borrowFactorE18) / ONE_E18;

        // Supply index growth (from supply APR)
        uint256 srBps = currentSupplyAPR_BPS();
        uint256 sr_ps = _ratePerSecE18(srBps);
        uint256 supplyFactorE18 = ONE_E18 + (sr_ps * dt);
        supplyIndexE18 = (supplyIndexE18 * supplyFactorE18) / ONE_E18;

        lastAccrual = t;
        emit Accrued(
            borrowIndexE18,
            supplyIndexE18,
            totalBorrowsE6,
            totalReservesE6
        );
    }

    // -------------------- Lender: supply/withdraw --------------------
    function _accrueLender(address user) internal {
        uint256 p = supplyPrincipalE6[user];
        if (p == 0) {
            supplyUserIndexE18[user] = supplyIndexE18;
            return;
        }
        uint256 uIdx = supplyUserIndexE18[user];
        uint256 delta = supplyIndexE18 - uIdx;
        if (delta == 0) {
            return;
        }
        // compound: add interest to principal
        uint256 interest = (p * delta) / ONE_E18;
        supplyPrincipalE6[user] = p + interest;
        supplyUserIndexE18[user] = supplyIndexE18;
    }

    function supply(uint256 amountE6) external {
        require(amountE6 > 0, "amt");
        accrue();
        _accrueLender(msg.sender);

        require(
            USDC.transferFrom(msg.sender, address(this), amountE6),
            "xferFrom"
        );
        supplyPrincipalE6[msg.sender] += amountE6;
        emit Supplied(msg.sender, amountE6);
    }

    function withdraw(uint256 amountE6) external {
        require(amountE6 > 0, "amt");
        accrue();
        _accrueLender(msg.sender);

        require(supplyPrincipalE6[msg.sender] >= amountE6, "insuff");
        // liquidity check: must have cash
        require(USDC.balanceOf(address(this)) >= amountE6, "illiquid");

        supplyPrincipalE6[msg.sender] -= amountE6;
        require(USDC.transfer(msg.sender, amountE6), "xfer");
        emit Withdrawn(msg.sender, amountE6);
    }

    // View helper: current lender balance with accrued interest (not state-mutating)
    function lenderBalanceE6(address user) external view returns (uint256) {
        if (supplyPrincipalE6[user] == 0) return 0;
        uint256 p = supplyPrincipalE6[user];
        uint256 uIdx = supplyUserIndexE18[user];
        uint256 curIdx = supplyIndexE18;
        // simulate simple accrual to now without state change
        uint64 t = uint64(block.timestamp);
        uint64 dt = t - lastAccrual;
        if (dt > 0) {
            uint256 sr_ps = _ratePerSecE18(currentSupplyAPR_BPS());
            uint256 sf = ONE_E18 + (sr_ps * dt);
            curIdx = (curIdx * sf) / ONE_E18;
        }
        uint256 delta = curIdx - uIdx;
        return p + ((p * delta) / ONE_E18);
    }

    // -------------------- Collateral helpers --------------------
    function _addCollatAsset(address user, address asset) internal {
        if (!collat[user][asset].listed) {
            collat[user][asset].listed = true;
            collatList[user].push(asset);
        }
    }

    function _removeIfZero(address user, address asset) internal {
        if (collat[user][asset].listed && collat[user][asset].qtyE6 == 0) {
            // remove from list (swap&pop)
            address[] storage L = collatList[user];
            for (uint256 i = 0; i < L.length; i++) {
                if (L[i] == asset) {
                    L[i] = L[L.length - 1];
                    L.pop();
                    break;
                }
            }
            collat[user][asset].listed = false;
        }
    }

    function lockCollateral(address asset, uint256 qtyE6) public {
        require(qtyE6 > 0, "qty");
        // sanity decimals (best-effort)
        try IERC20(asset).decimals() returns (uint8 d) {
            require(d == 6, "asset != 6dp");
        } catch {}

        // Pull tokens
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), qtyE6),
            "xferFrom"
        );
        collat[msg.sender][asset].qtyE6 += uint128(qtyE6);
        _addCollatAsset(msg.sender, asset);
        emit CollateralLocked(msg.sender, asset, qtyE6);
    }

    function unlockCollateral(address asset, uint256 qtyE6) public {
        require(qtyE6 > 0, "qty");
        Collat storage c = collat[msg.sender][asset];
        require(c.qtyE6 >= qtyE6, "insuff");
        accrue(); // refresh indices before risk test

        // Simulate after-unlock LTV
        c.qtyE6 -= uint128(qtyE6);
        bool ok = _isSafe(msg.sender);
        c.qtyE6 += uint128(qtyE6);
        require(ok, "ltv");

        // Do it
        c.qtyE6 -= uint128(qtyE6);
        _removeIfZero(msg.sender, asset);
        require(IERC20(asset).transfer(msg.sender, qtyE6), "xfer");
        emit CollateralUnlocked(msg.sender, asset, qtyE6);
    }

    // -------------------- Borrow / Repay --------------------
    function _accrueBorrower(address user) internal {
        uint256 p = borrowPrincipalE6[user];
        if (p == 0) {
            borrowUserIndexE18[user] = borrowIndexE18;
            return;
        }
        uint256 uIdx = borrowUserIndexE18[user];
        uint256 delta = borrowIndexE18 - uIdx;
        if (delta == 0) return;
        uint256 interest = (p * delta) / ONE_E18;
        borrowPrincipalE6[user] = p + interest;
        borrowUserIndexE18[user] = borrowIndexE18;
    }

    function borrow(
        uint256 amountE6,
        address[] calldata lockAssets,
        uint256[] calldata lockQtyE6
    ) external {
        require(amountE6 > 0, "amt");
        require(lockAssets.length == lockQtyE6.length, "len");

        accrue();
        _accrueBorrower(msg.sender);

        // Lock (optional batch lock to avoid extra txs)
        for (uint256 i = 0; i < lockAssets.length; i++) {
            if (lockQtyE6[i] > 0) {
                lockCollateral(lockAssets[i], lockQtyE6[i]);
            }
        }

        // Risk check vs new debt
        uint256 newDebt = borrowPrincipalE6[msg.sender] + amountE6;
        require(newDebt <= _maxBorrowableE6(msg.sender), "exceeds LTV");

        // Liquidity check
        require(USDC.balanceOf(address(this)) >= amountE6, "illiquid");

        // Update borrower + pool
        borrowPrincipalE6[msg.sender] = newDebt;
        borrowUserIndexE18[msg.sender] = borrowIndexE18;
        totalBorrowsE6 += amountE6;

        // Send USDC
        require(USDC.transfer(msg.sender, amountE6), "xfer");
        emit Borrowed(msg.sender, amountE6);
    }

    function repay(uint256 amountE6) external {
        require(amountE6 > 0, "amt");
        accrue();
        _accrueBorrower(msg.sender);

        uint256 owed = borrowPrincipalE6[msg.sender];
        require(owed > 0, "no debt");

        uint256 pay = amountE6 > owed ? owed : amountE6;
        require(USDC.transferFrom(msg.sender, address(this), pay), "xferFrom");

        borrowPrincipalE6[msg.sender] = owed - pay;
        totalBorrowsE6 -= pay;
        emit Repaid(msg.sender, pay);
    }

    // -------------------- Portfolio / Risk views --------------------
    function _collateralValueE6(
        address user
    ) internal view returns (uint256 sumE6) {
        address[] memory L = collatList[user];
        for (uint256 i = 0; i < L.length; i++) {
            address a = L[i];
            uint256 qty = collat[user][a].qtyE6;
            if (qty == 0) continue;
            uint256 px = _freshBand(a); // reverts if stale
            sumE6 += (qty * px) / ONE_E6;
        }
    }

    function _maxBorrowableE6(address user) internal view returns (uint256) {
        uint256 col = _collateralValueE6(user);
        return (col * ltvBps) / BPS;
    }

    function _isSafe(address user) internal view returns (bool) {
        // Health check at *current* principal (post-accrual call expected by mutators)
        uint256 col = _collateralValueE6(user);
        if (col == 0) return borrowPrincipalE6[user] == 0;
        uint256 lim = (col * ltvBps) / BPS;
        return borrowPrincipalE6[user] <= lim;
    }

    function accountPortfolio(
        address user
    )
        external
        view
        returns (
            uint256 supplyE6,
            uint256 borrowE6,
            uint256 collateralValueE6,
            uint256 ltvCurrentBps,
            uint256 maxBorrowE6
        )
    {
        // NOTE: returns *principal snapshots* at last accrual; the UI can call accrue() off-chain or
        // use the lenderBalanceE6 view for supply approximation. Keeping this minimal.
        supplyE6 = supplyPrincipalE6[user];
        borrowE6 = borrowPrincipalE6[user];
        collateralValueE6 = _collateralValueE6(user);
        maxBorrowE6 = (collateralValueE6 * ltvBps) / BPS;
        ltvCurrentBps = collateralValueE6 == 0
            ? 0
            : (borrowE6 * BPS) / collateralValueE6;
    }

    function userCollaterals(
        address user
    ) external view returns (address[] memory assets, uint256[] memory qtyE6) {
        address[] memory L = collatList[user];
        assets = new address[](L.length);
        qtyE6 = new uint256[](L.length);
        for (uint256 i = 0; i < L.length; i++) {
            assets[i] = L[i];
            qtyE6[i] = collat[user][L[i]].qtyE6;
        }
    }
}
