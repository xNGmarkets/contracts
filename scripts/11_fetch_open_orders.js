// scripts/fetch_open_orders.js
// Usage:
//   node scripts/fetch_open_orders.js
// Optional env:
//   RPC_URL=https://testnet.hashio.io/api
//   CHAIN_ID=296
//   CLOB_CONTRACT=0xYourClobAddress
//   // Filter to these assets (comma-separated checksummed/0x addresses). If omitted, all assets.
//   ASSETS=0x...de91,0x...de93
//
// Output: prints a summary and writes ./open_orders.json

const { ethers } = require("ethers");
const fs = require("fs");

const RPC_URL = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 296;
const CLOB_ADDR = process.env.CLOB_CONTRACT; // required

if (!CLOB_ADDR) {
  console.error("❌ Missing CLOB_CONTRACT in env");
  process.exit(1);
}

// ---- Address → Ticker map (lowercased keys) ----
const ADDRESS_TO_TICKER = {
  "0x000000000000000000000000000000000067de91": "MTNN",
  "0x000000000000000000000000000000000067de93": "UBA",
  "0x000000000000000000000000000000000067de94": "GTCO",
  "0x000000000000000000000000000000000067de95": "ZENITHBANK",
  "0x000000000000000000000000000000000067de96": "ARADEL",
  "0x000000000000000000000000000000000067de97": "TOTALNG",
  "0x000000000000000000000000000000000067de98": "AIICO",
  "0x000000000000000000000000000000000067de99": "CORNERST",
  "0x000000000000000000000000000000000067de9a": "OKOMUOIL",
  "0x000000000000000000000000000000000067de9b": "PRESCO",
  "0x000000000000000000000000000000000067de9c": "NESTLE",
  "0x000000000000000000000000000000000067de9d": "DANGSUGAR",
};

// Optional asset filter
const ASSETS_RAW = (process.env.ASSETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ASSET_FILTER = new Set(ASSETS_RAW.map((a) => a.toLowerCase()));

// Minimal ABI for views we need
const CLOB_ABI = [
  "function ordersLength() view returns (uint256)",
  "function orders(uint256) view returns (address trader,address asset,uint8 side,bool isMarket,uint128 qty,uint128 pxE6,uint64 ts,bool active)",
];

// Helpers
const toNum = (bn) => Number(bn); // safe for our ranges (pxE6, qty up to 1e12)
const pxToFloat = (pxE6) => toNum(pxE6) / 1e6;     // USD
const qtyToFloat = (q) => toNum(q) / 1e6;          // asset units (6dp)
const sideName = (u8) => (Number(u8) === 0 ? "BUY" : "SELL");

// Grouping by asset
function byAsset() {
  return { buys: [], sells: [] };
}

// Sorters: price-time priority
function sortBuys(a, b) {
  if (a.pxE6 !== b.pxE6) return b.pxE6 - a.pxE6; // higher price first
  return a.ts - b.ts; // older first
}
function sortSells(a, b) {
  if (a.pxE6 !== b.pxE6) return a.pxE6 - b.pxE6; // lower price first
  return a.ts - b.ts; // older first
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const clob = new ethers.Contract(CLOB_ADDR, CLOB_ABI, provider);

  const total = toNum(await clob.ordersLength());
  console.log(`ℹ️  ordersLength = ${total}`);

  const MAX_TO_SCAN = total; // adjust if you want a cap
  const BATCH = 250; // JSON-RPC batching window

  const book = new Map(); // key: assetLower, value: { buys:[], sells:[] }

  for (let start = 0; start < Math.min(MAX_TO_SCAN, total); start += BATCH) {
    const end = Math.min(start + BATCH, total);
    const calls = [];
    for (let i = start; i < end; i++) calls.push(clob.orders(i));
    const results = await Promise.all(calls);

    results.forEach((o, idx) => {
      const id = start + idx;
      if (!o.active) return;

      const asset = o.asset;
      const assetLower = asset.toLowerCase();

      // Optional asset filter
      if (ASSET_FILTER.size > 0 && !ASSET_FILTER.has(assetLower)) return;

      const side = sideName(o.side);
      const entry = {
        id,
        trader: o.trader,
        asset,
        side,
        isMarket: o.isMarket,
        qtyE6: toNum(o.qty),
        pxE6: toNum(o.pxE6),
        ts: toNum(o.ts),
        qty: qtyToFloat(o.qty),
        px: pxToFloat(o.pxE6),
      };

      if (!book.has(assetLower)) book.set(assetLower, byAsset());
      const grp = book.get(assetLower);
      if (side === "BUY") grp.buys.push(entry);
      else grp.sells.push(entry);
    });
  }

  // Sort & print
  const out = {};
  for (const [assetLower, grp] of book.entries()) {
    grp.buys.sort(sortBuys);
    grp.sells.sort(sortSells);

    out[assetLower] = {
      buys: grp.buys,
      sells: grp.sells,
      summary: {
        buyLevels: grp.buys.length,
        sellLevels: grp.sells.length,
        topBid: grp.buys[0] ? grp.buys[0].px : null,
        topAsk: grp.sells[0] ? grp.sells[0].px : null,
      },
      name: ADDRESS_TO_TICKER[assetLower] || "UNKNOWN",
    };

    // Console summary (ticker in brackets before address)
    const name = out[assetLower].name;
    console.log("\n==============================================");
    console.log(`Asset: [${name}] ${assetLower}`);
    if (grp.buys.length) {
      console.log("Top 5 BUY (px, qty, id):");
      grp.buys.slice(0, 5).forEach((o) =>
        console.log(`  $${o.px.toFixed(4)} | ${o.qty.toFixed(6)} | #${o.id}`)
      );
    } else {
      console.log("No BUY orders");
    }
    if (grp.sells.length) {
      console.log("Top 5 SELL (px, qty, id):");
      grp.sells.slice(0, 5).forEach((o) =>
        console.log(`  $${o.px.toFixed(4)} | ${o.qty.toFixed(6)} | #${o.id}`)
      );
    } else {
      console.log("No SELL orders");
    }
  }

  // Persist JSON
  fs.writeFileSync("./open_orders.json", JSON.stringify(out, null, 2));
  console.log(`\n✅ Wrote ./open_orders.json`);
})();
