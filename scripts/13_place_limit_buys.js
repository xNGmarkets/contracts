// scripts/13_place_limit_buys.js
require("dotenv").config();
const { ethers } = require("ethers");
const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  TokenAssociateTransaction,
} = require("@hashgraph/sdk");

// ---------- Minimal ABIs ----------
const ERC20_ABI = [
  "function approve(address spender, uint256 value) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const ORACLE_ABI = [
  // returns (uint128 midE6, uint16 widthBps, uint64 ts)
  "function getBand(address asset) external view returns (uint128,uint16,uint64)",
];

const CLOB_ABI = [
  "function place(address asset, uint8 side, bool isMarket, uint128 qty, uint128 pxE6) external returns (uint256)",
  "function feeBps() external view returns (uint16)",
  "event Placed(uint256 indexed id, address indexed asset, address indexed trader, uint8 side, bool isMarket, uint128 qty, uint128 pxE6)",
  "event Trade(address indexed asset, uint256 indexed buyId, uint256 indexed sellId, address buyer, address seller, uint128 qty, uint128 pxE6, uint256 notionalE6, uint256 feeE6)",
];

// ---------- Config & helpers ----------
const ONE_E6 = 1_000_000n;
const MULT = BigInt(process.env.CLOB_NOTIONAL_MULTIPLIER || "1000000");

const rpcUrl = process.env.RPC_URL || "https://testnet.hashio.io/api";
const chainId = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 296;

const ADDR = {
  CLOB: process.env.CLOB_CONTRACT,
  ORACLE: process.env.ORACLEHUB_CONTRACT,
  ADAPTER: process.env.DIRECT_SETTLE_ADAPTER,

  USDC_EVM: process.env.USDC_CONTRACT,
  USDC_ID: process.env.USDC_CONTRACT_ID, // "0.0.x" for HTS associate

  // assets (EVM addresses)
  AIICO: process.env.AIICO,
  MTNN: process.env.MTNN,
  TOTALNG: process.env.TOTALNG,
  ZENITHBANK: process.env.ZENITHBANK,
  ARADEL: process.env.ARADEL,
  CORNERST: process.env.CORNERST,
  OKOMUOIL: process.env.OKOMUOIL,
  PRESCO: process.env.PRESCO,
  NESTLE: process.env.NESTLE,
  DANGSUGAR: process.env.DANGSUGAR,
};

// Validate env
for (const k of [
  "CLOB",
  "ORACLE",
  "ADAPTER",
  "USDC_EVM",
  "USDC_ID",
  "AIICO",
  "MTNN",
  "TOTALNG",
  "ZENITHBANK",
  "ARADEL",
  "CORNERST",
  "OKOMUOIL",
  "PRESCO",
  "NESTLE",
  "DANGSUGAR",
]) {
  if (!ADDR[k]) throw new Error(`Missing env: ${k}`);
}

// enum Side { Buy=0, Sell=1 }
const SIDE_BUY = 0;

// BUY intents (also drives associations per user)
const ORDERS = [
  {
    whoKey: "USER_1_PRIVATE_KEY",
    whoId: "USER_1_ACCOUNT_ID",
    assetSym: "AIICO",
    qtyE6: 500n * ONE_E6,
  },
  {
    whoKey: "USER_2_PRIVATE_KEY",
    whoId: "USER_2_ACCOUNT_ID",
    assetSym: "MTNN",
    qtyE6: 100n * ONE_E6,
  },
  {
    whoKey: "USER_3_PRIVATE_KEY",
    whoId: "USER_3_ACCOUNT_ID",
    assetSym: "TOTALNG",
    qtyE6: 75n * ONE_E6,
  },
  {
    whoKey: "USER_1_PRIVATE_KEY",
    whoId: "USER_1_ACCOUNT_ID",
    assetSym: "ZENITHBANK",
    qtyE6: 500n * ONE_E6,
  },
  {
    whoKey: "USER_2_PRIVATE_KEY",
    whoId: "USER_2_ACCOUNT_ID",
    assetSym: "ARADEL",
    qtyE6: 100n * ONE_E6,
  },
  {
    whoKey: "USER_3_PRIVATE_KEY",
    whoId: "USER_3_ACCOUNT_ID",
    assetSym: "CORNERST",
    qtyE6: 75n * ONE_E6,
  },
  {
    whoKey: "USER_1_PRIVATE_KEY",
    whoId: "USER_1_ACCOUNT_ID",
    assetSym: "OKOMUOIL",
    qtyE6: 500n * ONE_E6,
  },
  {
    whoKey: "USER_2_PRIVATE_KEY",
    whoId: "USER_2_ACCOUNT_ID",
    assetSym: "PRESCO",
    qtyE6: 100n * ONE_E6,
  },
  {
    whoKey: "USER_3_PRIVATE_KEY",
    whoId: "USER_3_ACCOUNT_ID",
    assetSym: "NESTLE",
    qtyE6: 75n * ONE_E6,
  },
  {
    whoKey: "USER_3_PRIVATE_KEY",
    whoId: "USER_3_ACCOUNT_ID",
    assetSym: "DANGSUGAR",
    qtyE6: 75n * ONE_E6,
  },
];

const FEE_BUFFER_BPS = 5n;
const bn = (v) => BigInt(v.toString());

// ---- TokenId helpers (dedupe-by-string) ----
function toTokenIdStr(x) {
  if (!x) throw new Error("toTokenIdStr: empty");
  if (x.startsWith("0x")) {
    return TokenId.fromEvmAddress(0, 0, x).toString(); // => "0.0.x"
  }
  return TokenId.fromString(x).toString();
}
function toTokenId(x) {
  return TokenId.fromString(x); // x must already be "0.0.x"
}

// ---- Associate one user to unique TokenIds (chunked) ----
async function associateUserToTokens(userIdStr, userPrivStr, tokenIdStrs) {
  const accountId = AccountId.fromString(userIdStr);
  const priv = PrivateKey.fromStringECDSA(userPrivStr);
  const client = Client.forTestnet().setOperator(accountId, priv);

  const CHUNK = 10; // safe chunk size
  for (let i = 0; i < tokenIdStrs.length; i += CHUNK) {
    const slice = tokenIdStrs.slice(i, i + CHUNK).map(toTokenId);
    const tx = new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds(slice);

    const frozen = tx.freezeWith(client);
    const signed = await frozen.sign(priv);
    const resp = await signed.execute(client);
    const rec = await resp.getReceipt(client);
    console.log(
      `Associated ${accountId.toString()} -> [${slice
        .map((t) => t.toString())
        .join(", ")}] : ${rec.status.toString()}`
    );
  }
}

async function ensureAssociations() {
  console.log("Starting associations…");

  // Build per-user unique token string sets
  const perUser = new Map(); // userIdStr -> { privStr, tokenStrs:Set<"0.0.x"> }

  for (const ord of ORDERS) {
    const userPriv = process.env[ord.whoKey];
    const userId = process.env[ord.whoId];
    if (!userPriv || !userId)
      throw new Error(`Missing env for ${ord.whoKey}/${ord.whoId}`);

    if (!perUser.has(userId))
      perUser.set(userId, { privStr: userPriv, tokenStrs: new Set() });

    const bucket = perUser.get(userId);
    bucket.tokenStrs.add(toTokenIdStr(ADDR.USDC_ID)); // USDC ("0.0.x")
    bucket.tokenStrs.add(toTokenIdStr(ADDR[ord.assetSym])); // asset (via EVM -> "0.0.x")
  }

  // Execute
  for (const [userId, info] of perUser.entries()) {
    const uniques = Array.from(info.tokenStrs.values()); // truly deduped set of "0.0.x"
    try {
      await associateUserToTokens(userId, info.privStr, uniques);
    } catch (e) {
      const msg = `${e?.message || e}`;
      if (msg.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
        console.log(`Already associated: ${userId}`);
      } else if (msg.includes("TOKEN_ID_REPEATED_IN_TOKEN_LIST")) {
        console.warn(
          `Node complained about repeats for ${userId}; re-trying one-by-one…`
        );
        for (const one of uniques) {
          try {
            await associateUserToTokens(userId, info.privStr, [one]);
          } catch (ee) {
            const mm = `${ee?.message || ee}`;
            if (mm.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
              console.log(`Already associated (single): ${userId} ${one}`);
            } else {
              throw ee;
            }
          }
        }
      } else {
        throw e;
      }
    }
  }
}

// ---------- Main flow: associate + place LIMIT BUYs ----------
async function main() {
  // 1) Associate all users to USDC + their target asset (deduped)
  await ensureAssociations();

  // 2) Place LIMIT BUYs
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);

  const wallets = {};
  for (const ord of ORDERS) {
    const pk = process.env[ord.whoKey];
    wallets[ord.whoKey] = new ethers.Wallet(pk, provider);
  }

  const usdc = new ethers.Contract(ADDR.USDC_EVM, ERC20_ABI, provider);
  const oracleRO = new ethers.Contract(ADDR.ORACLE, ORACLE_ABI, provider);
  const clob = new ethers.Contract(ADDR.CLOB, CLOB_ABI, provider);

  const feeBps = bn(await clob.feeBps());
  console.log("CLOB feeBps =", feeBps.toString());

  const placedTopic = clob.interface.getEvent("Placed").topicHash;
  const tradeTopic = clob.interface.getEvent("Trade").topicHash;
  const startBlock = await provider.getBlockNumber();

  for (const ord of ORDERS) {
    const wallet = wallets[ord.whoKey];
    const asset = ADDR[ord.assetSym];

    const [midE6] = await oracleRO.getBand(asset);
    const pxE6 = bn(midE6);
    if (pxE6 <= 0n) throw new Error(`No band price for ${ord.assetSym}`);

    const notionalE6 = (ord.qtyE6 * pxE6) / ONE_E6;
    const approveE6 =
      (notionalE6 * (10000n + feeBps + FEE_BUFFER_BPS)) / 10000n;
    const approveFinal = approveE6 * MULT;

    const usdcWithUser = usdc.connect(wallet);
    const currentAllow = bn(
      await usdcWithUser.allowance(wallet.address, ADDR.ADAPTER)
    );
    if (currentAllow < approveFinal) {
      console.log(
        `[${ord.assetSym}] approving USDC for ${wallet.address} -> ${
          ADDR.ADAPTER
        } : ${approveFinal.toString()}`
      );
      const txA = await usdcWithUser.approve(ADDR.ADAPTER, approveFinal);
      await txA.wait();
    } else {
      console.log(`[${ord.assetSym}] allowance ok: ${currentAllow.toString()}`);
    }

    console.log(
      `[${
        ord.assetSym
      }] placing LIMIT BUY qty=${ord.qtyE6.toString()} @ pxE6=${pxE6.toString()}`
    );
    const tx = await clob
      .connect(wallet)
      .place(asset, SIDE_BUY, false, ord.qtyE6, pxE6);
    const rc = await tx.wait();
    console.log(`[${ord.assetSym}] place tx = ${rc.hash}`);

    let orderId = null;
    for (const log of rc.logs || []) {
      if (log.topics[0] === placedTopic) {
        const ev = clob.interface.parseLog(log);
        orderId = ev.args.id;
        console.log(`[${ord.assetSym}] Placed orderId=${orderId.toString()}`);
      }
    }
    if (orderId === null)
      console.warn(`[${ord.assetSym}] Could not parse Placed event`);
  }

  // 3) Quick scan for fills
  const endBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: ADDR.CLOB,
    topics: [tradeTopic],
    fromBlock: startBlock,
    toBlock: endBlock,
  });
  if (logs.length === 0) {
    console.log("No Trade events found yet (likely no opposing sells).");
  } else {
    for (const lg of logs) {
      const ev = clob.interface.parseLog(lg);
      const { asset, buyId, sellId, buyer, seller, qty, pxE6, notionalE6 } =
        ev.args;
      console.log(
        `TRADE: asset=${asset} buyId=${buyId} sellId=${sellId} buyer=${buyer} seller=${seller} qty=${qty} pxE6=${pxE6} notionalE6=${notionalE6}`
      );
    }
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
