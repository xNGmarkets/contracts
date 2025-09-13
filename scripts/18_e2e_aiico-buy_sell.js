// scripts/e2e_aiico_cross.js
// One-shot test: Operator sells 100 AIICO, User1 buys, then matchBest.
//
// Env needed (you already have these):
//  RPC_URL=https://testnet.hashio.io/api
//  CHAIN_ID=296
//  CLOB_CONTRACT=0x...
//  ORACLEHUB_CONTRACT=0x...
//  DIRECT_SETTLE_ADAPTER=0x4a4078Fe786E20476d1cA1c87Cd491bD16c3fE48
//  USDC_CONTRACT=0x000000000000000000000000000000000067e4af
//  USDC_CONTRACT_ID=0.0.6808751
//  AIICO=0x000000000000000000000000000000000067de98
//
//  ACCOUNT_ID=0.0.6781385
//  ACCOUNT_EVM=0x2015f2fcd836fa590ea66291453a287a5e23c8dc     (Operator)
//  OPERATOR_PRIVATE_KEY=0x61de4b0e...3f3e224                     (hex, with or without 0x OK)
//
//  USER_1_ACCOUNT_ID=0.0.6834746
//  USER_1_EVM=0x1c23de7...9A5676B
//  USER_1_PRIVATE_KEY=ac004ce7...c3fc4ec                         (raw hex ok)
//
//  FEE_SINK_ACCOUNT_ID=0.0.6834752
//  FEE_SINK_EVM=0xC70525cC7D0491102A259DCc702F45dc8Fae204d
//  FEE_SINK_KEY=e2d9fd24...76b77764                               (raw hex ok)

require("dotenv").config();
const { ethers } = require("ethers");
const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  TokenAssociateTransaction,
} = require("@hashgraph/sdk");

// ===== ABIs =====
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const ORACLE_ABI = [
  "function maxStaleness() view returns (uint64)",
  "function getBand(address asset) view returns (uint128 midE6, uint16 widthBps, uint64 ts)",
];

const CLOB_ABI = [
  "function feeBps() view returns (uint16)",
  "function place(address asset, uint8 side, bool isMarket, uint128 qty, uint128 pxE6) returns (uint256)",
  "function matchBest(address asset, uint256 maxMatches) external",
  "event Placed(uint256 indexed id, address indexed asset, address indexed trader, uint8 side, bool isMarket, uint128 qty, uint128 pxE6)",
  "event Trade(address indexed asset, uint256 indexed buyId, uint256 indexed sellId, address buyer, address seller, uint128 qty, uint128 pxE6, uint256 notionalE6, uint256 feeE6)",
];

// ===== Env & addresses =====
const RPC_URL = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID
  ? parseInt(process.env.CHAIN_ID, 10)
  : 296;

const ADDR = {
  CLOB: process.env.CLOB_CONTRACT,
  ORACLE: process.env.ORACLEHUB_CONTRACT,
  ADAPTER: process.env.DIRECT_SETTLE_ADAPTER,
  USDC: process.env.USDC_CONTRACT,
  USDC_ID: process.env.USDC_CONTRACT_ID,
  AIICO: process.env.AIICO,
};
for (const [k, v] of Object.entries(ADDR))
  if (!v) throw new Error(`Missing env: ${k}`);

const OP = {
  ID: process.env.ACCOUNT_ID,
  EVM: process.env.ACCOUNT_EVM,
  KEY: (
    process.env.OPERATOR_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    ""
  ).replace(/^0x/, ""),
};
const U1 = {
  ID: process.env.USER_1_ACCOUNT_ID,
  EVM: process.env.USER_1_EVM,
  KEY: (process.env.USER_1_PRIVATE_KEY || "").replace(/^0x/, ""),
};
const SINK = {
  ID: process.env.FEE_SINK_ACCOUNT_ID,
  EVM: process.env.FEE_SINK_EVM,
  KEY: (process.env.FEE_SINK_KEY || "").replace(/^0x/, ""),
};
if (!OP.ID || !OP.KEY) throw new Error("Missing operator account env");
if (!U1.ID || !U1.KEY) throw new Error("Missing USER_1 account env");
if (!SINK.ID || !SINK.KEY) throw new Error("Missing FEE_SINK env");

console.log(OP, U1);

// ===== Helpers =====
const ONE_E6 = 1_000_000n;
const SIDE = { Buy: 0, Sell: 1 };

function toTokenId(x) {
  if (!x) throw new Error("toTokenId: empty");
  if (x.startsWith("0x")) return TokenId.fromEvmAddress(0, 0, x);
  return TokenId.fromString(x);
}

async function associate(accountIdStr, privHex, tokenIds) {
  const accountId = AccountId.fromString(accountIdStr);
  const key = PrivateKey.fromStringECDSA(privHex);
  const client = Client.forTestnet().setOperator(accountId, key);

  const uniq = Array.from(new Set(tokenIds.map((t) => t.toString()))).map(
    TokenId.fromString
  );

  const tx = new TokenAssociateTransaction()
    .setAccountId(accountId)
    .setTokenIds(uniq);

  // IMPORTANT: don't chain .sign(...).execute(). Await sign first (it returns a Promise)
  await tx.freezeWith(client);
  const signed = await tx.sign(key);
  const resp = await signed.execute(client);
  const rec = await resp.getReceipt(client);
  return rec.status.toString();
}

async function ensureAssociated() {
  console.log("\nAssociations (HTS) …");
  try {
    // Sink ↔ USDC
    try {
      const st = await associate(SINK.ID, SINK.KEY, [toTokenId(ADDR.USDC_ID)]);
      console.log(`  • Sink ${SINK.ID} ↔ USDC ${ADDR.USDC_ID} : ${st}`);
    } catch (e) {
      const m = String(e?.message || e);
      if (m.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
        console.log(`  • Already associated: ${SINK.ID} ↔ ${ADDR.USDC_ID}`);
      } else throw e;
    }

    // Operator ↔ AIICO
    try {
      const st = await associate(OP.ID, OP.KEY, [toTokenId(ADDR.AIICO)]);
      console.log(`  • Operator ${OP.ID} ↔ AIICO : ${st}`);
    } catch (e) {
      const m = String(e?.message || e);
      if (m.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
        console.log(`  • Already associated: ${OP.ID} ↔ AIICO`);
      } else throw e;
    }

    // User1 ↔ USDC + AIICO
    try {
      const st = await associate(U1.ID, U1.KEY, [
        toTokenId(ADDR.USDC_ID),
        toTokenId(ADDR.AIICO),
      ]);
      console.log(`  • User1 ${U1.ID} ↔ {USDC,AIICO} : ${st}`);
    } catch (e) {
      const m = String(e?.message || e);
      if (m.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
        console.log(`  • Already associated: ${U1.ID} ↔ {USDC,AIICO}`);
      } else throw e;
    }
  } catch (e) {
    console.error("FATAL (associate):", e);
    process.exit(1);
  }
}

async function ensureAllowance(token, ownerWallet, spender, minAmount, label) {
  const t = token.connect(ownerWallet);
  const current = await t.allowance(ownerWallet.address, spender);
  // if (current >= minAmount) {
  //   console.log(`  • ${label} allowance OK (${current.toString()})`);
  //   return;
  // }
  // Some ERC20s require zero-first
  try {
    // console.log("current", current);
    // if (current > 0n) {
    //   console.log(`  • Reset ${label} allowance → 0`);
    //   const tx0 = await t.approve(spender, 0n);
    //   await tx0.wait();
    // }
    const _approve = 1000000 * 10 ** 6; //Lets use 1M default approval
    console.log(`  • Approve ${label} → ${_approve.toString()}`);
    console.log("Spender", spender);
    const tx = await t.approve(spender, _approve); //minAmount
    await tx.wait();
  } catch (e) {
    console.error(`  ✗ approve(${label}) failed:`, e);
    throw e;
  }
}

function fmt6(n) {
  return (Number(n) / 1e6).toFixed(6);
}
function fmtUSD(nE6) {
  return `$${(Number(nE6) / 1e6).toFixed(6)}`;
}

(async () => {
  console.log("=== xNGX: One-shot cross test (Operator SELL ↔ User1 BUY) ===");

  await ensureAssociated();

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wOp = new ethers.Wallet("0x" + OP.KEY, provider);
  const wU1 = new ethers.Wallet("0x" + U1.KEY, provider);

  const usdc = new ethers.Contract(ADDR.USDC, ERC20_ABI, provider);
  const aiico = new ethers.Contract(ADDR.AIICO, ERC20_ABI, provider);
  const clob = new ethers.Contract(ADDR.CLOB, CLOB_ABI, provider);
  const oracle = new ethers.Contract(ADDR.ORACLE, ORACLE_ABI, provider);

  const [usdcDec, aiicoDec] = await Promise.all([
    usdc.decimals(),
    aiico.decimals(),
  ]);
  if (usdcDec !== 6)
    console.warn(`WARN: USDC decimals reported ${usdcDec}, expected 6`);
  if (aiicoDec !== 6)
    console.warn(`WARN: AIICO decimals reported ${aiicoDec}, expected 6`);

  // Read band for price & freshness
  const { midE6, widthBps, ts } = await oracle.getBand(ADDR.AIICO);
  const maxStale = await oracle.maxStaleness();
  const now = Math.floor(Date.now() / 1000);
  const fresh = now <= Number(ts) + Number(maxStale);
  console.log(`\nVenue & band …`);
  console.log(
    `  • AIICO mid = $${(Number(midE6) / 1e6).toFixed(
      6
    )} | widthBps=${widthBps} | fresh ${fresh ? "✓" : "✗"}`
  );
  if (!fresh) {
    console.log(
      "  • Band is stale — this would block matching; update oracle first."
    );
    process.exit(1);
  }

  // Balances before
  const [opUSD0, opAII0, u1USD0, u1AII0] = await Promise.all([
    usdc.balanceOf(wOp.address),
    aiico.balanceOf(wOp.address),
    usdc.balanceOf(wU1.address),
    aiico.balanceOf(wU1.address),
  ]);
  console.log(`Pre balances:`);
  console.log(`  • Operator USDC=${fmt6(opUSD0)}  AIICO=${fmt6(opAII0)}`);
  console.log(`  • User1    USDC=${fmt6(u1USD0)}  AIICO=${fmt6(u1AII0)}`);

  // Parameters
  const qtyE6 = 100n * ONE_E6; // 100 AIICO (6dp)
  const pxE6 = BigInt(midE6); // use mid; guaranteed inside band
  const notionalE6 = (qtyE6 * pxE6) / ONE_E6;

  const feeBps = BigInt(await clob.feeBps()); // e.g. 20
  const feeE6 = (notionalE6 * feeBps) / 10000n;
  const needUSDC = notionalE6 + feeE6;

  console.log(`\nAllowances …`);
  // Buyer (User1) must approve USDC to adapter for notional + fee
  await ensureAllowance(
    usdc,
    wU1,
    ADDR.ADAPTER,
    needUSDC,
    "USDC (User1 → Adapter)"
  );
  // Seller (Operator) must approve AIICO to adapter for qty
  await ensureAllowance(
    aiico,
    wOp,
    ADDR.ADAPTER,
    qtyE6,
    "AIICO (Operator → Adapter)"
  );

  // return;

  // Events
  const iface = new ethers.Interface(CLOB_ABI);
  const placedTopic = iface.getEvent("Placed").topicHash;
  const tradeTopic = iface.getEvent("Trade").topicHash;
  const startBlock = await provider.getBlockNumber();

  // 1) Operator places SELL
  console.log(`\nPlacing orders …`);
  console.log(`  • Operator SELL qty=${fmt6(qtyE6)} @ ${fmtUSD(pxE6)}`);
  const txS = await clob
    .connect(wOp)
    .place(ADDR.AIICO, SIDE.Sell, false, qtyE6, pxE6);
  const rcS = await txS.wait();
  let sellId = null;
  for (const lg of rcS.logs) {
    if (lg.topics[0] === placedTopic) {
      const ev = iface.parseLog(lg);
      sellId = ev.args.id.toString();
    }
  }
  console.log(
    `    - place tx: ${rcS.hash}${sellId ? ` (sellId=${sellId})` : ""}`
  );

  // 2) User1 places BUY at same qty/price
  console.log(`  • User1 BUY   qty=${fmt6(qtyE6)} @ ${fmtUSD(pxE6)}`);
  const txB = await clob
    .connect(wU1)
    .place(ADDR.AIICO, SIDE.Buy, false, qtyE6, pxE6);
  const rcB = await txB.wait();
  let buyId = null;
  for (const lg of rcB.logs) {
    if (lg.topics[0] === placedTopic) {
      const ev = iface.parseLog(lg);
      buyId = ev.args.id.toString();
    }
  }
  console.log(`    - place tx: ${rcB.hash}${buyId ? ` (buyId=${buyId})` : ""}`);

  // 3) Match
  console.log(`\nMatching …`);
  try {
    const txM = await clob.connect(wOp).matchBest(ADDR.AIICO, 10);
    const rcM = await txM.wait();
    console.log(`  • matchBest tx: ${rcM.hash}`);
  } catch (e) {
    console.log(e);
    // If anything fails here, it is almost always association/KYC/allowance/venue/band
    console.error("  ✗ matchBest failed:", e?.reason || e?.message || e);
  }

  // 4) Scan for trades
  const endBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: ADDR.CLOB,
    topics: [tradeTopic],
    fromBlock: startBlock,
    toBlock: endBlock,
  });
  if (logs.length === 0) {
    console.log(
      "  • No Trade events found (check band freshness, venue=Continuous, and allowances)."
    );
  } else {
    for (const lg of logs) {
      const ev = iface.parseLog(lg);
      const {
        asset,
        buyId: bId,
        sellId: sId,
        buyer,
        seller,
        qty,
        pxE6: pE6,
        notionalE6: nE6,
        feeE6: fE6,
      } = ev.args;
      console.log(
        `  • TRADE asset=${asset} buyId=${bId} sellId=${sId} buyer=${buyer} seller=${seller} qty=${fmt6(
          qty
        )} px=${fmtUSD(pE6)} notional=${fmtUSD(nE6)} fee=${fmtUSD(fE6)}`
      );
    }
  }

  // 5) Post balances
  const [opUSD1, opAII1, u1USD1, u1AII1] = await Promise.all([
    usdc.balanceOf(wOp.address),
    aiico.balanceOf(wOp.address),
    usdc.balanceOf(wU1.address),
    aiico.balanceOf(wU1.address),
  ]);
  console.log(`\nPost balances:`);
  console.log(`  • Operator USDC=${fmt6(opUSD1)}  AIICO=${fmt6(opAII1)}`);
  console.log(`  • User1    USDC=${fmt6(u1USD1)}  AIICO=${fmt6(u1AII1)}`);

  console.log("\nDone.");
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
