// scripts/cancel_all_my_orders.js
//
// Cancel ALL active orders (buy/sell) placed by:
// - Operator (OPERATOR_PRIVATE_KEY or PRIVATE_KEY)
// - USER_1_PRIVATE_KEY
// - USER_2_PRIVATE_KEY
// - USER_3_PRIVATE_KEY
//
// Env:
//   RPC_URL=https://testnet.hashio.io/api
//   CHAIN_ID=296
//   CLOB_CONTRACT=0xYourClob
//   OPERATOR_PRIVATE_KEY=0x... (or PRIVATE_KEY=0x...)
//   USER_1_PRIVATE_KEY=... (with or without 0x; both ok)
//   USER_2_PRIVATE_KEY=...
//   USER_3_PRIVATE_KEY=...
//
// Optional:
//   ASSETS=0x...de91,0x...de93   (filter: cancel only for these assets)
//   DRY_RUN=1                    (just print, don’t send txs)
//
// Output: logs tx hashes and writes ./cancel_results.json

require("dotenv").config();
const fs = require("fs");
const { ethers } = require("ethers");

const RPC_URL   = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID  = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 296;
const CLOB_ADDR = process.env.CLOB_CONTRACT;

if (!CLOB_ADDR) {
  console.error("❌ Missing CLOB_CONTRACT in env");
  process.exit(1);
}

// Optional asset filter
const ASSETS_RAW = (process.env.ASSETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ASSET_FILTER = new Set(ASSETS_RAW.map((a) => a.toLowerCase()));

const DRY_RUN = !!process.env.DRY_RUN;

// ---------- Minimal ABI ----------
const CLOB_ABI = [
  "function ordersLength() view returns (uint256)",
  "function orders(uint256) view returns (address trader,address asset,uint8 side,bool isMarket,uint128 qty,uint128 pxE6,uint64 ts,bool active)",
  "function cancel(uint256 id) external",
  "event Cancelled(uint256 indexed id)"
];

// ---------- Helpers ----------
function normalizePk(pk) {
  if (!pk) return pk;
  return pk.startsWith("0x") ? pk : "0x" + pk;
}

function toNum(bn) {
  return Number(bn);
}

function fmtAddr(a) {
  return a ? a.toLowerCase() : a;
}

async function collectMyActiveOrders(clob, myAddrsLower) {
  const total = toNum(await clob.ordersLength());
  console.log(`ℹ️  ordersLength = ${total}`);
  const BATCH = 250;

  const mine = []; // { id, trader, asset, side, qty, pxE6, ts }
  for (let start = 0; start < total; start += BATCH) {
    const end = Math.min(start + BATCH, total);
    const calls = [];
    for (let i = start; i < end; i++) calls.push(clob.orders(i));
    const results = await Promise.all(calls);

    results.forEach((o, idx) => {
      const id = start + idx;
      if (!o.active) return;

      const traderL = fmtAddr(o.trader);
      if (!myAddrsLower.has(traderL)) return;

      if (ASSET_FILTER.size > 0 && !ASSET_FILTER.has(fmtAddr(o.asset))) return;

      mine.push({
        id,
        trader: o.trader,
        asset: o.asset,
        side: Number(o.side) === 0 ? "BUY" : "SELL",
        qty: toNum(o.qty) / 1e6,
        px: toNum(o.pxE6) / 1e6,
        ts: toNum(o.ts),
      });
    });
  }
  return mine;
}

async function cancelAllForWallet(clob, wallet, items) {
  const signerAddr = (await wallet.getAddress()).toLowerCase();
  const mine = items.filter((o) => o.trader.toLowerCase() === signerAddr);
  if (mine.length === 0) return [];

  console.log(`\nCancelling ${mine.length} orders for ${wallet.address} …`);
  const iface = new ethers.Interface(CLOB_ABI);
  const out = [];

  for (const o of mine) {
    const label = `#${o.id} ${o.side} ${o.qty.toFixed(6)} @ $${o.px.toFixed(6)} (${o.asset})`;
    try {
      if (DRY_RUN) {
        console.log(`  • DRY_RUN cancel(${o.id})  ${label}`);
        out.push({ id: o.id, hash: null, status: "DRY_RUN" });
        continue;
      }
      const tx = await clob.connect(wallet).cancel(o.id);
      const rc = await tx.wait();
      let cancelled = false;
      for (const lg of rc.logs || []) {
        try {
          const ev = iface.parseLog(lg);
          if (ev?.name === "Cancelled" && Number(ev.args.id) === o.id) {
            cancelled = true;
            break;
          }
        } catch (_) {}
      }
      console.log(`  ✓ cancel(${o.id}) tx: ${rc.hash} ${cancelled ? "[event OK]" : "[event not found]"}`);
      out.push({ id: o.id, hash: rc.hash, status: cancelled ? "OK" : "NO_EVENT" });
    } catch (err) {
      const reason = err?.reason || err?.shortMessage || err?.message || String(err);
      console.log(`  ✗ cancel(${o.id}) failed: ${reason}`);
      out.push({ id: o.id, hash: null, status: "ERROR", error: reason });
    }
  }
  return out;
}

(async () => {
  // Provider & read-only contract
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const clobRO = new ethers.Contract(CLOB_ADDR, CLOB_ABI, provider);

  // Wallets (normalize keys with/without 0x)
  const opPk  = normalizePk(process.env.OPERATOR_PRIVATE_KEY || process.env.PRIVATE_KEY);
  const u1Pk  = normalizePk(process.env.USER_1_PRIVATE_KEY);
  const u2Pk  = normalizePk(process.env.USER_2_PRIVATE_KEY);
  const u3Pk  = normalizePk(process.env.USER_3_PRIVATE_KEY);

  if (!opPk || !u1Pk || !u2Pk || !u3Pk) {
    console.error("❌ Missing one of OPERATOR/USER_1/USER_2/USER_3 private keys in env");
    process.exit(1);
  }

  const opW = new ethers.Wallet(opPk, provider);
  const u1W = new ethers.Wallet(u1Pk, provider);
  const u2W = new ethers.Wallet(u2Pk, provider);
  const u3W = new ethers.Wallet(u3Pk, provider);

  const myAddrsLower = new Set([
    (await opW.getAddress()).toLowerCase(),
    (await u1W.getAddress()).toLowerCase(),
    (await u2W.getAddress()).toLowerCase(),
    (await u3W.getAddress()).toLowerCase(),
  ]);

  console.log(`Operator: ${await opW.getAddress()}`);
  console.log(`User1:    ${await u1W.getAddress()}`);
  console.log(`User2:    ${await u2W.getAddress()}`);
  console.log(`User3:    ${await u3W.getAddress()}`);
  console.log(`CLOB:     ${CLOB_ADDR}`);
  if (ASSET_FILTER.size) {
    console.log(`Filter ASSETS:`, [...ASSET_FILTER].join(", "));
  }
  if (DRY_RUN) console.log(`DRY_RUN = ON (no transactions will be sent)`);

  // 1) Collect all active orders for these 4 traders
  const mine = await collectMyActiveOrders(clobRO, myAddrsLower);
  mine.sort((a, b) => a.id - b.id);

  if (mine.length === 0) {
    console.log("\n✅ No active orders found for these accounts.");
    process.exit(0);
  }

  // Print a quick summary
  console.log(`\nFound ${mine.length} active orders belonging to these wallets:`);
  const byTrader = new Map();
  for (const o of mine) {
    const t = o.trader.toLowerCase();
    if (!byTrader.has(t)) byTrader.set(t, []);
    byTrader.get(t).push(o);
  }
  for (const [t, arr] of byTrader.entries()) {
    console.log(`  - ${t} : ${arr.length} orders`);
  }

  // 2) Send cancels per wallet (sequential per wallet to avoid nonce races)
  const clob = clobRO.connect(opW); // any signer; we'll .connect each wallet when calling
  const results = {
    operator: await cancelAllForWallet(clob, opW, mine),
    user1:    await cancelAllForWallet(clob, u1W, mine),
    user2:    await cancelAllForWallet(clob, u2W, mine),
    user3:    await cancelAllForWallet(clob, u3W, mine),
  };

  fs.writeFileSync("./cancel_results.json", JSON.stringify({ when: Date.now(), results }, null, 2));
  console.log(`\n✅ Wrote ./cancel_results.json`);
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
