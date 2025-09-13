# xNG — CLOB (Continuous Limit Order Book)

A minimal on-chain order book for xNGX tokenized stocks with **dynamic Band** & **staleness** guards.
Settlement is **direct-settle (non-custodial)** via a tiny adapter (`IMoveAdapter`), so the adapter **never holds funds**—it only moves tokens with `transferFrom`.

> **Decimals & units**
> • All prices use **USD × 1e6** (`pxE6`).
> • USDC and xNGX tokens are assumed to use **6 decimals**.
> • Notional (USD × 1e6) = `qty * pxE6`.


## Table of contents

- [xNG — CLOB (Continuous Limit Order Book)](#xng--clob-continuous-limit-order-book)
  - [Table of contents](#table-of-contents)
  - [Architecture](#architecture)
  - [Key contracts](#key-contracts)
  - [Hedera specifics](#hedera-specifics)
  - [Quick start (ethers v6)](#quick-start-ethers-v6)
  - [API reference](#api-reference)
    - [Admin](#admin)
    - [Views](#views)
    - [Order entry](#order-entry)
    - [Matching](#matching)
  - [Events](#events)
  - [Common errors \& fixes](#common-errors--fixes)
  - [Security notes \& limitations](#security-notes--limitations)

---

## Architecture

```
User ↔ CLOB (Clob.sol) ↔ Adapter (IMoveAdapter) → ERC20.transferFrom(...)
                    ↘ OracleHub (price + band)
```

* **Clob**: places, cancels, matches orders; enforces **venue**, **band** interval, and **oracle freshness**.
* **OracleHub**: stores `BandPayload {midE6, widthBps, ts}` and `PricePayload {priceE6, seq, ts, hcsMsgId}` + `maxStaleness`.
* **Adapter (Direct-Settle)**: executes three peer-to-peer token movements with `transferFrom` (buyer→seller USDC, buyer→fee USDC, seller→buyer xNGX).

---

## Key contracts

* `Clob.sol` — the engine
* `IOracleHub.sol` — interface the Clob reads (`getBand`, `getPrice`, `maxStaleness`)
* `IMoveAdapter.sol` — interface:

  ```solidity
  interface IMoveAdapter {
      function move(address token, address from, address to, uint256 amount) external;
  }
  ```
* `DirectSettleAdapter.sol` — minimal implementation:

  ```solidity
  function move(address token, address from, address to, uint256 amount) external {
      IERC20(token).transferFrom(from, to, amount);
  }
  ```

> We **do not** use a custody adapter. No pooled balances in contracts.

---

**Deploy order**

1. Deploy **OracleHub** (set `maxStaleness` seconds).
2. Deploy **DirectSettleAdapter**.
3. Deploy **Clob** with: `owner`, `oracle`, `adapter`, `USDC`, `feeSink`.
4. Seed **band & price** in `OracleHub` for each asset (and keep them fresh).
5. `setVenue(asset, Continuous)` to open the book.

---

## Hedera specifics

* **Associations** (HTS):

  * **Buyer & Seller**: must be associated to **USDC** and the **xNGX** token they trade (and **KYC’d** if the xNGX enforces KYC).
  * **Fee sink**: must be associated to **USDC**.
  * The **adapter**/**CLOB** do **not** need association in this **direct-settle** model.
* **Approvals** (ERC-20 style):

  * **Buyer** `approve(adapter, notional + fee)` on **USDC**.
  * **Seller** `approve(adapter, qty)` on **xNGX**.
* **Oracles**:

  * `setBand(asset, { midE6, widthBps, ts })`
  * `setPrice(asset, { priceE6, seq, ts, hcsMsgId })`
  * Keep `ts` within `maxStaleness`.
  * `widthBps` is **half-width** in bps (e.g., 150 = ±1.5%).
  * `seq` is a **monotonic** anti-replay counter per asset.

---

## Quick start (ethers v6)

```js
import { ethers } from "ethers";

// 1) Attach contracts
const clob    = new ethers.Contract(CLOB_ADDR,    ClobAbi,    wallet);
const oracle  = new ethers.Contract(ORACLE_ADDR,  OracleAbi,  wallet);
const adapter = new ethers.Contract(ADAPTER_ADDR, AdapterAbi, wallet);

// 2) Seed band & price for ASSET (xNGX token EVM address)
const now = Math.floor(Date.now()/1000);
await oracle.setBand(ASSET, { midE6: 200_000, widthBps: 150, ts: now });       // $0.200000 ±1.5%
await oracle.setPrice(ASSET, { priceE6: 200_000, seq: 1, ts: now, hcsMsgId: "0x"+ "00".repeat(32) });

// 3) Open venue
await clob.setVenue(ASSET, 1); // 0=Paused, 1=Continuous, 2=CallAuction

// 4) User approvals (off-chain UX step)
// Buyer approves USDC to adapter; Seller approves xNGX to adapter.

// 5) Place orders
//   - Side: 0=Buy, 1=Sell
//   - isMarket: true/false
//   - qty: asset units (6dp), pxE6: USD * 1e6 (ignored if isMarket=true)
await clob.place(ASSET, 0, false, 1_000_000n, 200_000n); // limit BUY 1.000000 units @ $0.200000
await clob.place(ASSET, 1, false, 1_000_000n, 200_000n); // limit SELL

// 6) Match
await clob.matchBest(ASSET, 10); // perform up to 10 matches
```

---

## API reference

### Admin

* `setVenue(address asset, VenueState state)`
  `Paused` blocks place/match. `Continuous` allows them. `CallAuction` reserved (off by default).
* `setFeeSink(address)` — USDC fees receiver.
* `setFeeBps(uint16)` — venue fee in bps (cap 1000 = 10%).
* `setOracle(address)` — set `IOracleHub`.
* `setAdapter(address)` — set `IMoveAdapter` (direct-settle).
* `transferOwnership(address)`.

### Views

* `ordersLength() → uint256`
* `best(address asset) → BestPx { bidE6, askE6 }`
* `bandRange(address) → (lo, hi, ts)` — computed from oracle `midE6 ± widthBps`.

### Order entry

* `place(address asset, Side side, bool isMarket, uint128 qty, uint128 pxE6) → id`

  * Requires venue = `Continuous`.
  * Requires **fresh** band (`ts` within `maxStaleness`).
  * For **limit** orders: `pxE6` must be inside `[lo, hi]`.
* `cancel(uint256 id)` — only order owner; makes it inactive.

### Matching

* `matchBest(address asset, uint256 maxMatches)`

  * Enforces venue = `Continuous`, fresh band, and exec price inside band.
  * Calls adapter to move tokens (buyer→seller USDC, buyer→feeSink USDC, seller→buyer xNGX).
  * Emits `Trade`.

---

## Events

* `Placed(id, asset, trader, side, isMarket, qty, pxE6)`
* `Cancelled(id)`
* `Trade(asset, buyId, sellId, buyer, seller, qty, pxE6, notionalE6, feeE6)`
* `VenueSet(asset, state)`
* `FeeSinkSet(sink)`
* `FeeBpsSet(bps)`
* `OracleSet(oracle)`
* `AdapterSet(adapter)`
* `OwnerTransferred(newOwner)`

---

## Common errors & fixes

* **`venue off`** — call `setVenue(asset, 1)` to open the book.
* **`no band` / `stale/halt`** — seed `setBand` / `setPrice` and keep `ts` within `maxStaleness`.
* **`band`** — limit order or exec price is outside `[lo, hi]`.
* **`qty`/`qty0`** — zero quantity provided or computed.
* **Allowance failed in settlement** — remind users to:

  * Buyer: `approve(adapter, notional + fee)` on **USDC**
  * Seller: `approve(adapter, qty)` on **xNGX**
* **Hedera association/KYC** — ensure buyer/seller (and fee sink for USDC) are **associated** (and **KYC-approved** if xNGX enforces it).
* **Hardhat `stack too deep`** — enable `viaIR: true` in `solc.settings`.

---

## Security notes & limitations

* Order book is **array-backed** (O(n²) matching). Fine for MVP/testnet; replace with sorted structures for scale.
* Use a **multisig** or timelock for the owner that calls admin functions.
* Keep the oracle **fresh**; stale data halts matching by design.
* Consider adding per-order **expiry** and **min-fill** for production.
* This engine settles trades **atomically**; if any leg fails, the whole trade reverts (no partial fills without state).

---

If you want, I can include a tiny **sample `DirectSettleAdapter.sol`** and a one-file **deploy script** snippet under a `scripts/` folder to round out the repo.
