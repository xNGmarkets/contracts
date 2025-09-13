// Debug CLOB matching readiness across assets
// Usage:
//   FIX_ALLOWANCES=false DO_MATCH=false node scripts/debug_match_readiness.js
//
// ENV required:
// RPC_URL=https://testnet.hashio.io/api
// CHAIN_ID=296
// CLOB_CONTRACT=0x...
// ORACLEHUB_CONTRACT=0x...
// DIRECT_SETTLE_ADAPTER=0x...
// USDC_CONTRACT=0x000000000000000000000000000000000067e4af
// USDC_CONTRACT_ID=0.0.6808751
// FEE_SINK_ACCOUNT_ID=0.0.6834752
//
// OPERATOR_ACCOUNT_ID=0.0.6781385
// OPERATOR_EVM=0x2015f2fcd836fa590ea66291453a287a5e23c8dc
// OPERATOR_PRIVATE_KEY=61de4b0e... (raw hex)  OR  DER string
//
// USER_1_ACCOUNT_ID=0.0.6834746
// USER_1_EVM=0x1c23de72CE08bce7899B6B3ce8f0D4FEB9A5676B
// USER_1_PRIVATE_KEY=ac004c... (raw hex)
//
// USER_2_ACCOUNT_ID=...
// USER_2_EVM=...
// USER_2_PRIVATE_KEY=...
//
// USER_3_ACCOUNT_ID=...
// USER_3_EVM=...
// USER_3_PRIVATE_KEY=...
//
// Optional toggles:
// FIX_ALLOWANCES=true   # will approve(0)->approve(max) where short
// DO_MATCH=true         # will call matchBest(asset, 10)
//
// Assets to check (set via env):
// MTNN, UBA, GTCO, ZENITHBANK, ARADEL, TOTALNG, AIICO, CORNERST, OKOMUOIL, PRESCO, NESTLE, DANGSUGAR

require("dotenv").config();
const { ethers } = require("ethers");
const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  AccountInfoQuery,
  TokenInfoQuery,
} = require("@hashgraph/sdk");

// ---------- Config ----------
const RPC_URL = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID
  ? parseInt(process.env.CHAIN_ID, 10)
  : 296;

const ADDR = {
  CLOB: process.env.CLOB_CONTRACT,
  ORACLE: process.env.ORACLEHUB_CONTRACT,
  ADAPTER: process.env.DIRECT_SETTLE_ADAPTER,
  USDC: process.env.USDC_CONTRACT,
};
const IDS = {
  USDC: process.env.USDC_CONTRACT_ID, // 0.0.x
  FEE_SINK: process.env.FEE_SINK_ACCOUNT_ID,
  OPERATOR: process.env.OPERATOR_ACCOUNT_ID,
  USER1: process.env.USER_1_ACCOUNT_ID,
  USER2: process.env.USER_2_ACCOUNT_ID,
  USER3: process.env.USER_3_ACCOUNT_ID,
};
const KEYS = {
  OPERATOR: process.env.OPERATOR_PRIVATE_KEY || process.env.PRIVATE_KEY, // both supported
  USER1: process.env.USER_1_PRIVATE_KEY,
  USER2: process.env.USER_2_PRIVATE_KEY,
  USER3: process.env.USER_3_PRIVATE_KEY,
};
const EVMS = {
  OPERATOR: process.env.OPERATOR_EVM,
  USER1: process.env.USER_1_EVM,
  USER2: process.env.USER_2_EVM,
  USER3: process.env.USER_3_EVM,
};

const FIX_ALLOWANCES = String(process.env.FIX_ALLOWANCES || "false") === "true";
const DO_MATCH = String(process.env.DO_MATCH || "false") === "true";

// Assets map (ticker -> evm)
const ASSETS = [
  //   ["MTNN", process.env.MTNN],
  //   ["UBA", process.env.UBA],
  //   ["GTCO", process.env.GTCO],
  //   ["ZENITHBANK", process.env.ZENITHBANK],
  //   ["ARADEL", process.env.ARADEL],
  //   ["TOTALNG", process.env.TOTALNG],
  ["AIICO", process.env.AIICO],
  //   ["CORNERST", process.env.CORNERST],
  //   ["OKOMUOIL", process.env.OKOMUOIL],
  //   ["PRESCO", process.env.PRESCO],
  //   ["NESTLE", process.env.NESTLE],
  //   ["DANGSUGAR", process.env.DANGSUGAR],
].filter(([_, a]) => !!a);

// ---------- Minimal ABIs ----------
const CLOB_ABI = [
  "function USDC() view returns (address)",
  "function adapter() view returns (address)",
  "function feeSink() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function venue(address) view returns (uint8)", // 0=Paused,1=Continuous,2=CallAuction
  "function best(address) view returns (uint128 bidE6, uint128 askE6)",
  "function ordersLength() view returns (uint256)",
  "function orders(uint256) view returns (address trader,address asset,uint8 side,bool isMarket,uint128 qty,uint128 pxE6,uint64 ts,bool active)",
  "function matchBest(address asset, uint256 maxMatches) external",
  "event Trade(address indexed asset, uint256 indexed buyId, uint256 indexed sellId, address buyer, address seller, uint128 qty, uint128 pxE6, uint256 notionalE6, uint256 feeE6)",
];
const ORACLE_ABI = [
  "function getBand(address asset) view returns (uint128 midE6, uint16 widthBps, uint64 ts)",
  "function maxStaleness() view returns (uint64)",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// ---------- Helpers ----------
const ONE_E6 = 1_000_000n;
const fmtUsd = (e6) => (Number(e6) / 1e6).toFixed(6);
const fmtQty = (e6) => (Number(e6) / 1e6).toFixed(6);
const nowSec = () => Math.floor(Date.now() / 1000);

function sideName(u8) {
  return Number(u8) === 0 ? "BUY" : "SELL";
}

function toTokenId(x) {
  if (!x) throw new Error("TokenId input empty");
  if (x.startsWith("0x")) return TokenId.fromEvmAddress(0, 0, x);
  return TokenId.fromString(x);
}

// robust PK parser: ECDSA raw-hex (with/without 0x) OR DER string
function parsePriv(pkStr) {
  if (!pkStr) throw new Error("Missing private key");
  const s = pkStr.trim();
  const hex = s.replace(/^0x/, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return PrivateKey.fromStringECDSA("0x" + hex);
  }
  // assume DER-format
  return PrivateKey.fromString(s);
}

async function htsRel(client, accountIdStr, tokenIdStrOrEvm) {
  const accountId = AccountId.fromString(accountIdStr);
  const tId = toTokenId(tokenIdStrOrEvm);
  const info = await new AccountInfoQuery()
    .setAccountId(accountId)
    .execute(client);
  const rel = info.tokenRelationships.get(tId.toString());
  return rel || null;
}
async function tokenInfo(client, tokenIdStrOrEvm) {
  const tId = toTokenId(tokenIdStrOrEvm);
  return new TokenInfoQuery().setTokenId(tId).execute(client);
}

async function scanTopOfBook(clob, assetAddr) {
  const total = Number(await clob.ordersLength());
  let bestBid = null,
    bestAsk = null,
    bestBidId = null,
    bestAskId = null,
    bestBidQty = null,
    bestAskQty = null;
  for (let i = 0; i < total; i++) {
    const o = await clob.orders(i);
    if (!o.active) continue;
    if (o.asset.toLowerCase() !== assetAddr.toLowerCase()) continue;
    const px = BigInt(o.pxE6.toString());
    const qty = BigInt(o.qty.toString());
    if (Number(o.side) === 0) {
      if (bestBid === null || px > bestBid) {
        bestBid = px;
        bestBidId = i;
        bestBidQty = qty;
      }
    } else {
      if (bestAsk === null || px < bestAsk) {
        bestAsk = px;
        bestAskId = i;
        bestAskQty = qty;
      }
    }
  }
  return { bestBid, bestAsk, bestBidId, bestAskId, bestBidQty, bestAskQty };
}

async function approveIfNeeded(token, owner, spender, need, label) {
  const cur = BigInt((await token.allowance(owner, spender)).toString());
  if (cur >= need) return { changed: false, current: cur };
  if (!FIX_ALLOWANCES)
    return {
      changed: false,
      current: cur,
      note: `insufficient (need ${need}, have ${cur})`,
    };

  console.log(`  • ${label}: allowance short — approve(0) then approve(max)…`);
  try {
    const tx0 = await token.approve(spender, 0);
    await tx0.wait();
  } catch (_) {}
  const tx1 = await token.approve(spender, ethers.MaxUint256);
  const rc1 = await tx1.wait();
  return { changed: true, current: ethers.MaxUint256, tx: rc1.hash };
}

(async () => {
  // basic env checks
  for (const [k, v] of Object.entries(ADDR))
    if (!v) throw new Error(`Missing env ${k}`);
  for (const [k, v] of Object.entries(IDS))
    if (!v) throw new Error(`Missing env ${k}`);
  for (const [k, v] of Object.entries(KEYS))
    if (!v) throw new Error(`Missing env ${k}`);
  if (ASSETS.length === 0) throw new Error("No assets provided via env");

  // Ethers provider + wallets (read-only unless FIX_ALLOWANCES)
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const op = new ethers.Wallet(
    KEYS.OPERATOR.startsWith("0x") ? KEYS.OPERATOR : `0x${KEYS.OPERATOR}`,
    provider
  );
  const w1 = new ethers.Wallet(
    KEYS.USER1.startsWith("0x") ? KEYS.USER1 : `0x${KEYS.USER1}`,
    provider
  );

  const clob = new ethers.Contract(ADDR.CLOB, CLOB_ABI, provider);
  const oracle = new ethers.Contract(ADDR.ORACLE, ORACLE_ABI, provider);
  const usdc = new ethers.Contract(
    ADDR.USDC,
    ERC20_ABI,
    FIX_ALLOWANCES ? w1 : provider
  );

  // Hedera client (operator pays for queries)
  let client;
  try {
    client = Client.forTestnet().setOperator(
      AccountId.fromString(IDS.OPERATOR),
      parsePriv(process.env.OPERATOR_PRIVATE_KEY || process.env.PRIVATE_KEY)
    );
  } catch (e) {
    console.log(
      "WARN: Could not init Hedera client with operator key:",
      e.message
    );
  }

  console.log("\n=== CLOB wiring ===");
  const clobUSDC = await clob.USDC();
  const clobAdapter = await clob.adapter();
  const clobFeeSink = await clob.feeSink();
  const feeBps = Number(await clob.feeBps());
  console.log(
    "USDC matches:",
    clobUSDC.toLowerCase() === ADDR.USDC.toLowerCase(),
    clobUSDC
  );
  console.log(
    "Adapter matches:",
    clobAdapter.toLowerCase() === ADDR.ADAPTER.toLowerCase(),
    clobAdapter
  );
  console.log("Fee sink (on CLOB):", clobFeeSink);
  console.log("feeBps:", feeBps);

  // USDC meta
  const usdcDec = await usdc.decimals().catch(() => 6);

  console.log(usdcDec, typeof usdcDec);

  if (Number(usdcDec) !== 6)
    console.warn(`WARN: USDC decimals reported ${usdcDec}, expected 6`);

  // Fee sink association (tolerate signature issues and continue)
  if (client) {
    try {
      const rel = await htsRel(client, IDS.FEE_SINK, IDS.USDC);
      console.log(
        `FeeSink associated to USDC: ${!!rel}  | kyc=${
          rel?.isKycGranted ?? "?"
        }`
      );
    } catch (e) {
      console.log("FeeSink USDC relationship check failed:", e.message);
      console.log(
        "  → Verify OPERATOR_ACCOUNT_ID really corresponds to OPERATOR_PRIVATE_KEY (key type & account)."
      );
    }
  }

  const maxStale = Number(await oracle.maxStaleness());
  console.log("Oracle maxStaleness (s):", maxStale);

  const ordersLen = Number(await clob.ordersLength());
  console.log("ordersLength =", ordersLen);

  for (const [sym, asset] of ASSETS) {
    console.log(`\n=== ${sym} (${asset}) ===`);

    const venue = Number(await clob.venue(asset));
    console.log(
      "Venue:",
      venue === 1 ? "Continuous" : venue === 0 ? "Paused" : "CallAuction"
    );

    const band = await oracle.getBand(asset);
    const midE6 = BigInt(band.midE6.toString());
    const widthBps = Number(band.widthBps);
    const ts = Number(band.ts);
    const fresh = nowSec() <= ts + maxStale;
    console.log(
      `Band: mid=$${fmtUsd(midE6)} widthBps=${widthBps} ts=${ts} fresh=${
        fresh ? "✓" : "✗"
      }`
    );

    const { bestBid, bestAsk, bestBidQty, bestAskQty, bestBidId, bestAskId } =
      await scanTopOfBook(clob, asset);
    if (bestBid !== null)
      console.log(
        `Best BID: px=$${fmtUsd(bestBid)} qty=${fmtQty(
          bestBidQty
        )} (orderId=${bestBidId})`
      );
    else console.log("Best BID: —");
    if (bestAsk !== null)
      console.log(
        `Best ASK: px=$${fmtUsd(bestAsk)} qty=${fmtQty(
          bestAskQty
        )} (orderId=${bestAskId})`
      );
    else console.log("Best ASK: —");
    if (bestBid !== null && bestAsk !== null) {
      console.log(
        "Crossable now:",
        bestBid >= bestAsk ? "YES (bid ≥ ask)" : "no"
      );
    }

    // Buyer: USER1 , Seller: OPERATOR (typical)
    const buyerAddr = EVMS.USER1;
    const sellerAddr = EVMS.OPERATOR;

    const assetErc = new ethers.Contract(
      asset,
      ERC20_ABI,
      FIX_ALLOWANCES ? op : provider
    );
    const [balBuyerUSDC, balSellerAsset] = await Promise.all([
      usdc.balanceOf(buyerAddr),
      assetErc.balanceOf(sellerAddr),
    ]);
    console.log(
      `Balances: Buyer USDC=$${fmtUsd(
        BigInt(balBuyerUSDC.toString())
      )} | Seller ${sym}=${fmtQty(BigInt(balSellerAsset.toString()))}`
    );

    // HTS relationships (+KYC)
    if (client) {
      const [relBuyerUSDC, relBuyerAsset, relSellerAsset] = await Promise.all([
        htsRel(client, IDS.USER1, IDS.USDC).catch(() => null),
        htsRel(client, IDS.USER1, asset).catch(() => null),
        htsRel(client, IDS.OPERATOR, asset).catch(() => null),
      ]);
      console.log(
        `Assoc/KYC: Buyer↔USDC=${!!relBuyerUSDC} kyc=${
          relBuyerUSDC?.isKycGranted ?? "?"
        } | Buyer↔${sym}=${!!relBuyerAsset} kyc=${
          relBuyerAsset?.isKycGranted ?? "?"
        } | Seller↔${sym}=${!!relSellerAsset} kyc=${
          relSellerAsset?.isKycGranted ?? "?"
        }`
      );

      // If token enforces KYC, ensure granted
      const tInfo = await tokenInfo(client, asset).catch(() => null);
      if (tInfo?.kycKey) {
        if (!relBuyerUSDC?.isKycGranted)
          console.log("  • ⚠ Buyer USDC KYC not granted");
        if (!relBuyerAsset?.isKycGranted)
          console.log(`  • ⚠ Buyer ${sym} KYC not granted`);
        if (!relSellerAsset?.isKycGranted)
          console.log(`  • ⚠ Seller ${sym} KYC not granted`);
      }
    }

    // Required USDC for top ask (qty * pxE6 / 1e6) + fee
    if (bestAsk !== null) {
      const needNotionalE6 = (bestAskQty * bestAsk) / ONE_E6;
      const feeE6 = (needNotionalE6 * BigInt(feeBps)) / 10000n;
      const needUSDC = needNotionalE6 + feeE6;

      const [allowBuyerUSDC, allowSellerAsset] = await Promise.all([
        usdc.allowance(buyerAddr, ADDR.ADAPTER),
        assetErc.allowance(sellerAddr, ADDR.ADAPTER),
      ]);
      const aB = BigInt(allowBuyerUSDC.toString());
      const aS = BigInt(allowSellerAsset.toString());

      console.log(
        `Need: notional=$${fmtUsd(needNotionalE6)} fee=$${fmtUsd(
          feeE6
        )} total=$${fmtUsd(needUSDC)}`
      );
      console.log(
        `Allowances: Buyer USDC→Adapter=${fmtUsd(
          aB
        )} | Seller ${sym}→Adapter=${fmtQty(aS)}`
      );

      if (aB < needUSDC) {
        const res = await approveIfNeeded(
          usdc.connect(w1),
          buyerAddr,
          ADDR.ADAPTER,
          needUSDC,
          "Buyer USDC"
        );
        if (res.note) console.log("  •", res.note);
        if (res.tx) console.log("  • approve tx:", res.tx);
      }
      if (aS < bestAskQty) {
        const res = await approveIfNeeded(
          assetErc.connect(op),
          sellerAddr,
          ADDR.ADAPTER,
          bestAskQty,
          `Seller ${sym}`
        );
        if (res.note) console.log("  •", res.note);
        if (res.tx) console.log("  • approve tx:", res.tx);
      }
    }

    // Guard summary (mirrors CLOB checks)
    const issues = [];
    if (venue !== 1) issues.push("venue != Continuous");
    if (!fresh) issues.push("oracle stale");
    // balances/allowances sanity only if ask present
    if (bestAsk !== null) {
      const needNotionalE6 = (bestAskQty * bestAsk) / ONE_E6;
      const feeE6 = (needNotionalE6 * BigInt(feeBps)) / 10000n;
      const needUSDC = needNotionalE6 + feeE6;
      if (BigInt(balBuyerUSDC.toString()) < needUSDC)
        issues.push("buyer USDC balance short");
      if (BigInt(balSellerAsset.toString()) < bestAskQty)
        issues.push("seller asset balance short");
    }
    console.log(
      "Guards:",
      issues.length ? "✗ " + issues.join("; ") : "✓ all clear"
    );

    // Optionally attempt matchBest
    if (DO_MATCH) {
      try {
        const clobW = clob.connect(op); // anyone can call matching
        const tx = await clobW.matchBest(asset, 10);
        const rc = await tx.wait();
        console.log("matchBest tx:", rc.hash);
        const iface = new ethers.Interface(CLOB_ABI);
        for (const lg of rc.logs) {
          try {
            const ev = iface.parseLog(lg);
            if (ev?.name === "Trade") {
              const { buyId, sellId, qty, pxE6, notionalE6, feeE6 } = ev.args;
              console.log(
                `TRADE: ${sym} buyId=${buyId} sellId=${sellId} qty=${fmtQty(
                  BigInt(qty)
                )} px=$${fmtUsd(BigInt(pxE6))} notional=$${fmtUsd(
                  BigInt(notionalE6)
                )} fee=$${fmtUsd(BigInt(feeE6))}`
              );
            }
          } catch (_) {}
        }
      } catch (e) {
        console.log(
          "matchBest revert:",
          e.reason || e.shortMessage || e.message
        );
      }
    }
  }

  console.log("\nDone.");
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
