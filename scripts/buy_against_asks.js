// Take top ASKs across all assets: associate users + operator, approve USDC, place limit BUYS at best ask,
// then run matchBest() to settle. Skips stale bands.
// Usage:
//   RPC_URL=... CHAIN_ID=296 CLOB_CONTRACT=0x... ORACLEHUB_CONTRACT=0x... DIRECT_SETTLE_ADAPTER=0x...
//   USDC_CONTRACT=0x... USDC_CONTRACT_ID=0.0.x
//   AIICO=0x... MTNN=0x... TOTALNG=0x... UBA=0x... GTCO=0x... ZENITHBANK=0x... ARADEL=0x... CORNERST=0x... OKOMUOIL=0x... PRESCO=0x... NESTLE=0x... DANGSUGAR=0x...
//   USER_1_ACCOUNT_ID=0.0.x USER_1_PRIVATE_KEY=<hex-no-0x-or-0xhex>
//   USER_2_ACCOUNT_ID=0.0.x USER_2_PRIVATE_KEY=...
//   USER_3_ACCOUNT_ID=0.0.x USER_3_PRIVATE_KEY=...
//   ACCOUNT_ID=0.0.x OPERATOR_PRIVATE_KEY=0x...   (operator = seller of your existing asks)
// Run: node scripts/take_top_asks.js

require("dotenv").config();
const { ethers } = require("ethers");
const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  TokenAssociateTransaction,
} = require("@hashgraph/sdk");

// ---------- Config ----------
const RPC_URL = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 296;

const ADDR = {
  CLOB: process.env.CLOB_CONTRACT,
  ORACLE: process.env.ORACLEHUB_CONTRACT,
  ADAPTER: process.env.DIRECT_SETTLE_ADAPTER,
  USDC: process.env.USDC_CONTRACT,        // EVM addr (for allowance)
  USDC_ID: process.env.USDC_CONTRACT_ID,  // 0.0.x (for HTS association)
  // Assets (EVM)
  MTNN: process.env.MTNN,
  UBA: process.env.UBA,
  GTCO: process.env.GTCO,
  ZENITHBANK: process.env.ZENITHBANK,
  ARADEL: process.env.ARADEL,
  TOTALNG: process.env.TOTALNG,
  AIICO: process.env.AIICO,
  CORNERST: process.env.CORNERST,
  OKOMUOIL: process.env.OKOMUOIL,
  PRESCO: process.env.PRESCO,
  NESTLE: process.env.NESTLE,
  DANGSUGAR: process.env.DANGSUGAR,
};
for (const [k, v] of Object.entries(ADDR)) if (!v) throw new Error(`Missing env: ${k}`);

// Buyers (users) & operator (seller side of existing asks)
const USERS = [
  { id: process.env.USER_1_ACCOUNT_ID, pk: process.env.USER_1_PRIVATE_KEY, label: "USER_1" },
  { id: process.env.USER_2_ACCOUNT_ID, pk: process.env.USER_2_PRIVATE_KEY, label: "USER_2" },
  { id: process.env.USER_3_ACCOUNT_ID, pk: process.env.USER_3_PRIVATE_KEY, label: "USER_3" },
];
for (const u of USERS) if (!u.id || !u.pk) throw new Error(`Missing env for ${u.label}`);

const OPERATOR_ID = process.env.ACCOUNT_ID;              // seller that posted asks (operator)
const OPERATOR_PK = process.env.OPERATOR_PRIVATE_KEY;    // hex (with/without 0x is fine here)
if (!OPERATOR_ID || !OPERATOR_PK) throw new Error("Missing env: ACCOUNT_ID / OPERATOR_PRIVATE_KEY");

// ---------- ABIs ----------
const CLOB_ABI = [
  "function ordersLength() view returns (uint256)",
  "function orders(uint256) view returns (address trader,address asset,uint8 side,bool isMarket,uint128 qty,uint128 pxE6,uint64 ts,bool active)",
  "function place(address asset, uint8 side, bool isMarket, uint128 qty, uint128 pxE6) external returns (uint256)",
  "function matchBest(address asset, uint256 maxMatches) external",
  "function feeBps() view returns (uint16)",
  "event Placed(uint256 indexed id, address indexed asset, address indexed trader, uint8 side, bool isMarket, uint128 qty, uint128 pxE6)",
  "event Trade(address indexed asset, uint256 indexed buyId, uint256 indexed sellId, address buyer, address seller, uint128 qty, uint128 pxE6, uint256 notionalE6, uint256 feeE6)"
];
const ORACLE_ABI = [
  "function getBand(address asset) external view returns (uint128 midE6, uint16 widthBps, uint64 ts)",
  "function maxStaleness() external view returns (uint64)"
];
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ---------- Helpers ----------
const ONE_E6 = 1_000_000n;
const SIDE_BUY = 0;

const ASSETS = [
  ["MTNN", ADDR.MTNN],
  ["UBA", ADDR.UBA],
  ["GTCO", ADDR.GTCO],
  ["ZENITHBANK", ADDR.ZENITHBANK],
  ["ARADEL", ADDR.ARADEL],
  ["TOTALNG", ADDR.TOTALNG],
  ["AIICO", ADDR.AIICO],
  ["CORNERST", ADDR.CORNERST],
  ["OKOMUOIL", ADDR.OKOMUOIL],
  ["PRESCO", ADDR.PRESCO],
  ["NESTLE", ADDR.NESTLE],
  ["DANGSUGAR", ADDR.DANGSUGAR],
];

function normalizePkForEthers(pk) {
  return pk.startsWith("0x") ? pk : "0x" + pk;
}
function normalizePkForSDK(pk) {
  return pk.startsWith("0x") ? pk.slice(2) : pk;
}
function toTokenIdFromAny(x) {
  if (!x) throw new Error("empty token id");
  if (x.startsWith("0x")) return TokenId.fromEvmAddress(0, 0, x);
  return TokenId.fromString(x);
}
function bn(x) { return BigInt(x.toString()); }
function toFloatE6(x) { return Number(x) / 1e6; }

function bandFresh(now, ts, maxStale) {
  return BigInt(now) <= BigInt(ts) + BigInt(maxStale);
}

// Associate one account to a set of TokenIds
async function htsAssociateMany(accountIdStr, privHex, tokenIds) {
  const acct = AccountId.fromString(accountIdStr);
  const priv = PrivateKey.fromStringECDSA(normalizePkForSDK(privHex));

  const client = Client.forTestnet().setOperator(acct, priv);

  // Dedup + limit size (SDK allows many; Hedera precheck rejects repeated IDs)
  const uniq = Array.from(new Set(tokenIds.map(t => t.toString()))).map(s => TokenId.fromString(s));

  const tx = new TokenAssociateTransaction()
    .setAccountId(acct)
    .setTokenIds(uniq);

  const frozen = tx.freezeWith(client);
  const signed = await frozen.sign(priv);
  const resp = await signed.execute(client);
  const rec = await resp.getReceipt(client);
  console.log(`  • Associated ${accountIdStr} to ${uniq.map(t=>t.toString()).join(", ")} => ${rec.status.toString()}`);
}

async function ensureUserAssociations() {
  console.log("Associating USERS to USDC + each asset they might buy…");
  const usdcId = toTokenIdFromAny(ADDR.USDC_ID);

  const perUserTokenIds = new Map(); // idStr -> Set<TokenId>
  for (const u of USERS) perUserTokenIds.set(u.id, new Set([usdcId]));

  for (const [, evm] of ASSETS) {
    const tid = toTokenIdFromAny(evm);
    for (const u of USERS) perUserTokenIds.get(u.id).add(tid);
  }

  for (const u of USERS) {
    try {
      await htsAssociateMany(u.id, u.pk, Array.from(perUserTokenIds.get(u.id)));
    } catch (e) {
      const msg = `${e?.message || e}`;
      if (msg.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
        console.log(`  • Already associated: ${u.id}`);
      } else {
        throw e;
      }
    }
  }
}

async function ensureOperatorAssociatedUSDC() {
  console.log("Associating OPERATOR to USDC (to receive USDC when selling) …");
  try {
    await htsAssociateMany(OPERATOR_ID, OPERATOR_PK, [toTokenIdFromAny(ADDR.USDC_ID)]);
  } catch (e) {
    const msg = `${e?.message || e}`;
    if (msg.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
      console.log(`  • Already associated: ${OPERATOR_ID}`);
    } else {
      throw e;
    }
  }
}

async function ensureAllowance(usdc, ownerWallet, spender, minE6) {
  const current = bn(await usdc.allowance(ownerWallet.address, spender));
  if (current >= minE6) return;
  const tx = await usdc.connect(ownerWallet).approve(spender, minE6);
  const rc = await tx.wait();
  console.log(`  • approve(${spender}, ${minE6.toString()}) tx=${rc.hash}`);
}

function pickBuyerFor(idx) {
  // simple round-robin
  const u = USERS[idx % USERS.length];
  return u;
}

// ---------- Main ----------
(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);

  // Ethers wallets for users
  const wallets = USERS.map(u => new ethers.Wallet(normalizePkForEthers(u.pk), provider));

  const clobRO = new ethers.Contract(ADDR.CLOB, CLOB_ABI, provider);
  const clob = new ethers.Contract(ADDR.CLOB, CLOB_ABI, wallets[0]); // signer not really used except for place/match
  const oracleRO = new ethers.Contract(ADDR.ORACLE, ORACLE_ABI, provider);
  const usdcRO = new ethers.Contract(ADDR.USDC, ERC20_ABI, provider);

  const feeBps = bn(await clobRO.feeBps());
  const maxStale = Number(await oracleRO.maxStaleness());
  console.log(`feeBps = ${feeBps}  |  maxStaleness = ${maxStale}s\n`);

  // 0) Make sure associations exist (users to USDC+assets; operator to USDC)
  await ensureUserAssociations();
  await ensureOperatorAssociatedUSDC();

  // 1) Snapshot order book
  const total = Number(await clobRO.ordersLength());
  const orders = [];
  for (let i = 0; i < total; i++) {
    const o = await clobRO.orders(i);
    if (!o.active) continue;
    orders.push({
      id: i,
      trader: o.trader,
      asset: o.asset,
      side: Number(o.side) === 0 ? "BUY" : "SELL",
      isMarket: o.isMarket,
      qty: bn(o.qty),
      pxE6: bn(o.pxE6),
      ts: Number(o.ts),
    });
  }

  // Build best-ask map
  const byAsset = new Map(); // assetLower -> bestAsk { id, pxE6, qty }
  for (const [symbol, evm] of ASSETS) {
    const key = evm.toLowerCase();
    const sells = orders.filter(o => o.asset.toLowerCase() === key && o.side === "SELL");
    if (!sells.length) continue;
    sells.sort((a, b) => (a.pxE6 === b.pxE6 ? a.ts - b.ts : Number(a.pxE6 - b.pxE6))); // lowest px first, time-priority
    byAsset.set(key, { symbol, evm, id: sells[0].id, pxE6: sells[0].pxE6, qty: sells[0].qty });
  }

  if (byAsset.size === 0) {
    console.log("No SELL orders on book — nothing to take.");
    return;
  }

  const iface = new ethers.Interface(CLOB_ABI);
  const startBlock = await provider.getBlockNumber();

  let assetIdx = 0;
  for (const [, best] of byAsset.entries()) {
    const { symbol, evm: asset, id: askId, pxE6, qty } = best;

    // 2) Check band freshness (skip stale)
    const band = await oracleRO.getBand(asset);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!bandFresh(nowSec, Number(band.ts), maxStale)) {
      console.log(`=== ${symbol} (${asset}) ===\n  • Band stale — skipping`);
      assetIdx++;
      continue;
    }

    console.log(`=== ${symbol} (${asset}) ===`);
    console.log(
      `  • Best ASK: px=$${toFloatE6(pxE6).toFixed(6)} qty=${toFloatE6(qty).toFixed(6)} (orderId=${askId})`
    );

    // 3) Compute required USDC (+ fee)
    const notionalE6 = (qty * pxE6) / ONE_E6;
    const needE6 = (notionalE6 * (10000n + feeBps)) / 10000n;

    // Pick a buyer (round-robin)
    const buyer = pickBuyerFor(assetIdx);
    const buyerWallet = new ethers.Wallet(normalizePkForEthers(buyer.pk), provider);

    // Balances & allowance
    const balE6 = bn(await usdcRO.balanceOf(buyerWallet.address));
    console.log(
      `  • Need USDC ≈ $${toFloatE6(notionalE6).toFixed(6)} (+ fees)\n` +
      `    - Buyer ${buyerWallet.address} balance=$${toFloatE6(balE6).toFixed(6)} need=$${toFloatE6(needE6).toFixed(6)} ${balE6 >= needE6 ? "✅" : "❌"}`
    );
    if (balE6 < needE6) {
      console.log("  • Insufficient USDC — skipping");
      assetIdx++;
      continue;
    }

    // 4) Ensure allowance to adapter
    await ensureAllowance(usdcRO, buyerWallet, ADDR.ADAPTER, needE6);

    // 5) Place LIMIT BUY exactly at ask px/qty
    console.log(
      `  • ${buyerWallet.address} placing BUY qty=${toFloatE6(qty).toFixed(6)} @ $${toFloatE6(pxE6).toFixed(6)}`
    );
    const placeTx = await clob.connect(buyerWallet).place(asset, SIDE_BUY, false, qty, pxE6);
    const placeRc = await placeTx.wait();
    let placedId = null;
    for (const lg of placeRc.logs) {
      try {
        const ev = iface.parseLog(lg);
        if (ev && ev.name === "Placed") placedId = ev.args.id?.toString?.();
      } catch {}
    }
    console.log(`  • place tx: ${placeRc.hash}${placedId ? `\n  • Placed orderId=${placedId}` : ""}`);

    // 6) Try to match (guard stale/band inside again at match time)
    try {
      const mtx = await clob.connect(buyerWallet).matchBest(asset, 25); // tries to cross as much as possible
      const mrc = await mtx.wait();
      console.log(`  • matchBest tx: ${mrc.hash}`);
    } catch (e) {
      const msg = e?.reason || e?.shortMessage || e?.message || String(e);
      console.log(`  ✗ matchBest failed: ${msg}`);
      console.log(
        "    Hint: this usually means adapter.move() failed — check HTS associations/KYC for:\n" +
        "      - Buyer (USDC + asset)\n" +
        "      - Seller (operator) must be associated to USDC to RECEIVE\n" +
        "      - Fee sink must be associated to USDC to RECEIVE fees\n" +
        "    Also ensure band still allows the execution price."
      );
    }

    assetIdx++;
  }

  // 7) Print trades since startBlock
  const tradeTopic = clob.interface.getEvent("Trade").topicHash;
  const endBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: ADDR.CLOB,
    topics: [tradeTopic],
    fromBlock: startBlock,
    toBlock: endBlock,
  });

  if (logs.length === 0) {
    console.log("\nNo Trade events found.");
  } else {
    console.log("\nTrades:");
    for (const lg of logs) {
      try {
        const ev = iface.parseLog(lg);
        const { asset, buyId, sellId, buyer, seller, qty, pxE6, notionalE6, feeE6 } = ev.args;
        console.log(
          `  • asset=${asset} buyId=${buyId} sellId=${sellId} ` +
          `qty=${toFloatE6(qty).toFixed(6)} px=$${toFloatE6(pxE6).toFixed(6)} ` +
          `notional=$${toFloatE6(notionalE6).toFixed(6)} fee=$${toFloatE6(feeE6).toFixed(6)}`
        );
      } catch {}
    }
  }

  console.log("\nDone.");
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
