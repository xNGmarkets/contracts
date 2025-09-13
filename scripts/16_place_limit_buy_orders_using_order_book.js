// scripts/take_best_asks.js
// Buy-to-match the best open ASK for each asset using USER1/2/3.
// Fixes unit mismatch: compares USDC balances & approvals strictly in base units.
//
// Env:
//  RPC_URL=https://testnet.hashio.io/api
//  CHAIN_ID=296
//  CLOB_CONTRACT=0x...
//  USDC_CONTRACT=0x000000000000000000000000000000000067e4af
//  DIRECT_SETTLE_ADAPTER=0x...
//  USER_1_PRIVATE_KEY=0x...
//  USER_2_PRIVATE_KEY=0x...
//  USER_3_PRIVATE_KEY=0x...
//
// Run: node scripts/take_best_asks.js

const { ethers } = require("ethers");

// -------- Config --------
const RPC_URL = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 296;
const CLOB_ADDR = process.env.CLOB_CONTRACT;
const USDC_ADDR = process.env.USDC_CONTRACT;
const ADAPTER_ADDR = process.env.DIRECT_SETTLE_ADAPTER;

if (!CLOB_ADDR || !USDC_ADDR || !ADAPTER_ADDR) {
  throw new Error("Missing one of CLOB_CONTRACT / USDC_CONTRACT / DIRECT_SETTLE_ADAPTER in env");
}

// Round-robin buyers
const USERS = [
  { keyEnv: "USER_1_PRIVATE_KEY", label: "User1" },
  { keyEnv: "USER_2_PRIVATE_KEY", label: "User2" },
  { keyEnv: "USER_3_PRIVATE_KEY", label: "User3" },
];

// Assets (ticker, evm)
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

// -------- ABIs --------
const CLOB_ABI = [
  "function ordersLength() view returns (uint256)",
  "function orders(uint256) view returns (address trader,address asset,uint8 side,bool isMarket,uint128 qty,uint128 pxE6,uint64 ts,bool active)",
  "function feeBps() view returns (uint16)",
  "function place(address asset, uint8 side, bool isMarket, uint128 qty, uint128 pxE6) returns (uint256)",
  "event Placed(uint256 indexed id, address indexed asset, address indexed trader, uint8 side, bool isMarket, uint128 qty, uint128 pxE6)",
  "event Trade(address indexed asset, uint256 indexed buyId, uint256 indexed sellId, address buyer, address seller, uint128 qty, uint128 pxE6, uint256 notionalE6, uint256 feeE6)"
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)"
];

// -------- Helpers --------
const SIDE_BUY = 0;
const ONE_E6 = 1_000_000n;

const toNum = (bn) => Number(bn);
const pxToFloat = (pxE6) => toNum(pxE6) / 1e6;
const qtyToFloat = (qE6) => toNum(qE6) / 1e6;

const divCeil = (a, b) => (a + (b - 1n)) / b;

// price-time priority sort for sells (lowest px first, then older)
function sortSells(a, b) {
  if (a.pxE6 !== b.pxE6) return a.pxE6 - b.pxE6;
  return a.ts - b.ts;
}

async function ensureAllowance(usdc, ownerAddr, spender, minNeededBase) {
  const cur = await usdc.allowance(ownerAddr, spender);
  if (cur >= minNeededBase) return null;
  const tx = await usdc.approve(spender, minNeededBase);
  const rc = await tx.wait();
  return rc.hash;
}

async function main() {
  // Provider & contracts
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const clob = new ethers.Contract(CLOB_ADDR, CLOB_ABI, provider);
  const feeBps = BigInt(await clob.feeBps());

  // Users
  const wallets = [];
  for (const u of USERS) {
    const pk = process.env[u.keyEnv];
    if (!pk) throw new Error(`Missing ${u.keyEnv}`);
    wallets.push({ ...u, wallet: new ethers.Wallet(pk, provider) });
  }

  // USDC
  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);
  const usdcDecimals = await usdc.decimals();
  if (usdcDecimals !== 6) {
    console.warn(`⚠️ USDC decimals = ${usdcDecimals} (script assumes 6)`);
  }

  console.log(`Operator ready. CLOB=${CLOB_ADDR}  USDC=${USDC_ADDR}  Adapter=${ADAPTER_ADDR}`);
  console.log(`feeBps = ${feeBps.toString()} (fees taken in USDC)`);

  const ordersTotal = Number(await clob.ordersLength());

  // Pre-pull all orders once (simple approach)
  const BATCH = 300;
  const rawOrders = [];
  for (let start = 0; start < ordersTotal; start += BATCH) {
    const end = Math.min(start + BATCH, ordersTotal);
    const calls = [];
    for (let i = start; i < end; i++) calls.push(clob.orders(i));
    const chunk = await Promise.all(calls);
    chunk.forEach((o, idx) => rawOrders.push({ id: start + idx, o }));
  }

  // Build best ask per asset
  const byAsset = new Map(); // key lowercased asset -> best sell order
  for (const { id, o } of rawOrders) {
    if (!o.active) continue;
    const side = Number(o.side); // 0=Buy,1=Sell
    if (side !== 1) continue; // only sells
    const asset = o.asset.toLowerCase();
    const entry = {
      id,
      asset: o.asset,
      trader: o.trader,
      qtyE6: BigInt(o.qty),
      pxE6: BigInt(o.pxE6),
      ts: Number(o.ts),
    };
    const prev = byAsset.get(asset);
    if (!prev) byAsset.set(asset, entry);
    else {
      // take lower price or older
      const better =
        entry.pxE6 < prev.pxE6 || (entry.pxE6 === prev.pxE6 && entry.ts < prev.ts);
      if (better) byAsset.set(asset, entry);
    }
  }

  // Event iface for orderId parsing
  const iface = new ethers.Interface(CLOB_ABI);

  // Round-robin buyer index
  let rr = 0;

  for (const [ticker, asset] of ASSETS) {
    const key = asset.toLowerCase();
    const bestAsk = byAsset.get(key);

    console.log(`\n=== ${ticker} (${asset}) ===`);
    if (!bestAsk) {
      console.log("  • No open SELL orders");
      continue;
    }
    console.log(
      `  • Best ASK: px=$${pxToFloat(bestAsk.pxE6).toFixed(6)} qty=${qtyToFloat(bestAsk.qtyE6).toFixed(6)} (orderId=${bestAsk.id})`
    );

    // Choose buyer
    const buyer = wallets[rr % wallets.length];
    rr++;
    const buyerAddr = await buyer.wallet.getAddress();

    // USDC balance (BASE units)
    const haveBase = BigInt(await usdc.balanceOf(buyerAddr));

    // We try to take full ask; but cap by available USDC (incl. fee)
    const pxE6 = bestAsk.pxE6;
    const qtyWantedE6 = bestAsk.qtyE6;

    // notionalE6 = qtyE6 * pxE6 / 1e6  => (USD * 1e6)
    const notionalE6 = (qtyWantedE6 * pxE6) / ONE_E6;

    // feeE6 = notionalE6 * feeBps / 10000
    const feeE6 = (notionalE6 * feeBps) / 10000n;

    // Total USDC needed in base units = ceil( (notionalE6 + feeE6) / 1e6 )
    const needBaseFull = divCeil(notionalE6 + feeE6, ONE_E6);

    // If insufficient, reduce quantity we take
    let qtyBuyE6 = qtyWantedE6;
    if (haveBase < needBaseFull) {
      // Max notionalE6 we can support given haveBase & fee:
      // notionalE6 * (1 + feeBps/10000) <= haveBase * 1e6
      const grossBudgetE12 = haveBase * ONE_E6;
      const maxNotionalE6 = (grossBudgetE12 * 10000n) / (10000n + feeBps);

      // qtyE6 = floor(maxNotionalE6 / pxE6) * 1e6 (because qtyE6 has 6dp)
      const q = (maxNotionalE6 * ONE_E6) / pxE6; // stays in E6 units
      if (q <= 0n) {
        console.log(
          `  • Insufficient USDC: have ${Number(haveBase) / 1e6} need ~${Number(needBaseFull) / 1e6} — skipping`
        );
        continue;
      }
      qtyBuyE6 = q <= qtyWantedE6 ? q : qtyWantedE6;
    }

    // Recompute exact base-unit need for final qty
    const notionalE6_final = (qtyBuyE6 * pxE6) / ONE_E6;
    const feeE6_final = (notionalE6_final * feeBps) / 10000n;
    const needBase = divCeil(notionalE6_final + feeE6_final, ONE_E6);

    // Log balances in BOTH forms to avoid confusion
    console.log(
      `  • Buyer=${buyer.label} ${buyerAddr}\n` +
      `    USDC have: ${Number(haveBase)/1e6} (base=${haveBase.toString()})\n` +
      `    USDC need: ${Number(needBase)/1e6} (base=${needBase.toString()})`
    );
    if (haveBase < needBase) {
      console.log("  • Still insufficient after capping qty — skipping");
      continue;
    }

    // Ensure allowance to adapter
    const usdcWithBuyer = usdc.connect(buyer.wallet);
    const curAllow = BigInt(await usdcWithBuyer.allowance(buyerAddr, ADAPTER_ADDR));
    if (curAllow < needBase) {
      const txh = await ensureAllowance(usdcWithBuyer, buyerAddr, ADAPTER_ADDR, needBase);
      console.log(`  • approve -> ${txh}`);
    } else {
      console.log(`  • allowance ok: ${Number(curAllow)/1e6} USDC`);
    }

    // Place LIMIT BUY at ask price to cross
    const clobWithBuyer = clob.connect(buyer.wallet);
    try {
      const tx = await clobWithBuyer.place(asset, SIDE_BUY, false, qtyBuyE6, pxE6);
      const rc = await tx.wait();

      // Extract Placed event (order id)
      let placedId = null;
      for (const lg of rc.logs) {
        try {
          const ev = iface.parseLog(lg);
          if (ev.name === "Placed") {
            placedId = ev.args.id?.toString?.() ?? null;
            break;
          }
        } catch {}
      }

      console.log(
        `  • Placed BUY qty=${qtyToFloat(qtyBuyE6).toFixed(6)} @ $${pxToFloat(pxE6).toFixed(6)} ` +
        `tx=${rc.hash}${placedId ? ` (orderId=${placedId})` : ""}`
      );
    } catch (err) {
      console.error(`  ✗ place() failed: ${err.reason || err.message || err}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
