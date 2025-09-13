// scripts/seed_limit_sells.js
// Place LIMIT SELL orders ($5,000 notional each) for all assets.
// Requires: ethers v6, Node 18+
//
// Env:
// RPC_URL=...
// CHAIN_ID=296
// PRIVATE_KEY=0x...         (operator that holds preminted tokens)
// CLOB_CONTRACT=0x...
// ORACLEHUB_CONTRACT=0x...
// DIRECT_SETTLE_ADAPTER=0x...   (spender for asset transfers on match)
//
// Notes:
// - CLOB expects qty in asset "base units" (decimals), usually 6 on HTS.
// - Script queries decimals() per token and converts $5,000 into qtyUnits.
// - Seller must have balance >= qtyUnits and must have token association/KYC done.
//
// Usage:
// node scripts/seed_limit_sells.js

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ===================== CONFIG =====================

// Fixed order notional in USD
const USD_NOTIONAL = 5000;

// If true, only logs what would happen (no transactions)
const DRY_RUN = false;

// Assets (ticker, EVM)
const ASSETS = [
  ["MTNN",       "0x000000000000000000000000000000000067de91"],
  ["UBA",        "0x000000000000000000000000000000000067de93"],
  ["GTCO",       "0x000000000000000000000000000000000067de94"],
  ["ZENITHBANK", "0x000000000000000000000000000000000067de95"],
  ["ARADEL",     "0x000000000000000000000000000000000067de96"],
  ["TOTALNG",    "0x000000000000000000000000000000000067de97"],
  ["AIICO",      "0x000000000000000000000000000000000067de98"],
  ["CORNERST",   "0x000000000000000000000000000000000067de99"],
  ["OKOMUOIL",   "0x000000000000000000000000000000000067de9a"],
  ["PRESCO",     "0x000000000000000000000000000000000067de9b"],
  ["NESTLE",     "0x000000000000000000000000000000000067de9c"],
  ["DANGSUGAR",  "0x000000000000000000000000000000000067de9d"],
];

// ===================== ABIs (minimal) =====================

const ORACLE_HUB_ABI = [
  // struct BandPayload { uint128 midE6; uint16 widthBps; uint64 ts; }
  "function getBand(address asset) external view returns (tuple(uint128 midE6, uint16 widthBps, uint64 ts))",
  "function maxStaleness() external view returns (uint64)",
];

const CLOB_ABI = [
  // enum Side { Buy=0, Sell=1 }
  // place(address asset, Side side, bool isMarket, uint128 qty, uint128 pxE6) returns (uint256 id)
  "function place(address asset, uint8 side, bool isMarket, uint128 qty, uint128 pxE6) external returns (uint256)",
  "event Placed(uint256 indexed id, address indexed asset, address indexed trader, uint8 side, bool isMarket, uint128 qty, uint128 pxE6)"
];

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)"
];

// ===================== Helpers =====================

const ONE_E6 = 1_000_000n;

function tenPow(n) {
  return 10n ** BigInt(n);
}

function toUint128(bi) {
  if (bi < 0n || bi > (1n << 128n) - 1n) throw new Error("uint128 overflow");
  return bi;
}

function computeBandRange(midE6, widthBps) {
  const delta = (midE6 * BigInt(widthBps)) / 10000n; // bps
  const lo = midE6 - delta;
  const hi = midE6 + delta;
  return { lo, hi };
}

function pickSellPriceInsideBand(midE6, widthBps) {
  // For SELL, bias slightly ABOVE mid (but inside band)
  const { lo, hi } = computeBandRange(midE6, widthBps);
  const span = hi - lo;
  const step = span / 10n; // 10 steps
  let px = midE6 + step;   // one step above mid
  if (px < lo) px = lo;
  if (px > hi) px = hi;
  return px;
}

async function ensureAllowance(token, owner, spender, need) {
  const cur = await token.allowance(owner, spender);
  if (cur >= need) return null;
  const tx = await token.approve(spender, need);
  const rc = await tx.wait();
  return rc.transactionHash;
}

// ===================== Main =====================

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://testnet.hashio.io/api";
  const chainId = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 296;
  const pk = process.env.PRIVATE_KEY;
  const CLOB_ADDR = process.env.CLOB_CONTRACT;
  const ORACLE_ADDR = process.env.ORACLEHUB_CONTRACT;
  const ADAPTER_ADDR = process.env.DIRECT_SETTLE_ADAPTER;

  if (!pk) throw new Error("Missing PRIVATE_KEY");
  if (!CLOB_ADDR) throw new Error("Missing CLOB_CONTRACT");
  if (!ORACLE_ADDR) throw new Error("Missing ORACLEHUB_CONTRACT");
  if (!ADAPTER_ADDR) throw new Error("Missing DIRECT_SETTLE_ADAPTER");

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const wallet = new ethers.Wallet(pk, provider);

  const clob = new ethers.Contract(CLOB_ADDR, CLOB_ABI, wallet);
  const oracle = new ethers.Contract(ORACLE_ADDR, ORACLE_HUB_ABI, provider);

  console.log(`\nOperator: ${wallet.address}`);
  console.log(`CLOB:     ${CLOB_ADDR}`);
  console.log(`Oracle:   ${ORACLE_ADDR}`);
  console.log(`Adapter:  ${ADAPTER_ADDR}`);
  console.log(`Mode:     LIMIT SELL $${USD_NOTIONAL} each\n`);

  const maxStale = await oracle.maxStaleness();
  const iface = new ethers.Interface(CLOB_ABI);
  const notionalE6 = BigInt(USD_NOTIONAL) * ONE_E6;

  for (const [ticker, asset] of ASSETS) {
    console.log(`\n== ${ticker} (${asset}) ==`);
    const token = new ethers.Contract(asset, ERC20_ABI, wallet);

    // 1) Read band & freshness
    const b = await oracle.getBand(asset);
    const midE6 = BigInt(b.midE6);
    const widthBps = Number(b.widthBps);
    const ts = BigInt(b.ts);
    const now = BigInt(Math.floor(Date.now() / 1000));

    if (midE6 === 0n) {
      console.warn(`  • No band on oracle — skipping`);
      continue;
    }
    if (now > ts + BigInt(maxStale)) {
      console.warn(`  • Band stale — skipping`);
      continue;
    }

    const { lo, hi } = computeBandRange(midE6, widthBps);
    const pxE6 = pickSellPriceInsideBand(midE6, widthBps);

    // 2) Qty = (notionalE6 * 10^dec) / pxE6   (base units)
    const dec = await token.decimals();
    const scale = tenPow(dec);
    let qtyUnits = (notionalE6 * scale) / pxE6;
    if (qtyUnits === 0n) qtyUnits = 1n;

    // 3) Check balance; trim if needed
    const bal = await token.balanceOf(wallet.address);
    if (bal < qtyUnits) {
      console.warn(
        `  • Balance too low (${bal.toString()} < ${qtyUnits.toString()}), trimming qty to balance`
      );
      qtyUnits = bal;
      if (qtyUnits === 0n) {
        console.warn(`  • Zero balance — skipping`);
        continue;
      }
    }

    console.log(
      `  • band=[${Number(lo)/1e6}..${Number(hi)/1e6}] mid=${Number(midE6)/1e6} USD, pxE6=${Number(pxE6)/1e6} USD`
    );
    console.log(
      `  • will SELL ≈ $${USD_NOTIONAL} => qty=${qtyUnits.toString()} (dec=${dec})`
    );

    if (DRY_RUN) {
      console.log(`  • DRY_RUN — skipping approve() + place()`);
      continue;
    }

    // 4) Approve adapter to pull asset qty (seller side)
    const txh = await ensureAllowance(token, wallet.address, ADAPTER_ADDR, qtyUnits);
    if (txh) console.log(`  • approve tx: ${txh}`);

    // 5) Place LIMIT SELL (side=1, isMarket=false)
    try {
      const tx = await clob.place(
        asset,
        1,          // Side.Sell
        false,      // isMarket = false
        toUint128(qtyUnits),
        toUint128(pxE6)
      );
      const rc = await tx.wait();

      // Try to parse Placed(id)
      let placedId = null;
      for (const log of rc.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === "Placed") {
            placedId = parsed.args.id?.toString?.() ?? null;
            break;
          }
        } catch (_) {}
      }
      console.log(`  • placed tx: ${rc.transactionHash} ${placedId ? `(orderId=${placedId})` : ""}`);
    } catch (err) {
      console.error(`  ✗ place() failed: ${err.reason || err.message || err}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
