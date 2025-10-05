// scripts/supply_user2_1250_usdc_with_portfolio.js
//
// Usage:
//   RPC_URL=https://testnet.hashio.io/api \
//   CHAIN_ID=296 \
//   BORROW_SUPPLY_CONTRACT=0xYourBorrowSupply \
//   ORACLE_CONTRACT=0xYourOracleHub \
//   USDC_CONTRACT=0x000000000000000000000000000000000067e4af \
//   FX_ASSET=0x00000000000000000000000000000000006a1e8c \
//   USER_2_PRIVATE_KEY=... \
//   node scripts/supply_user2_1250_usdc_with_portfolio.js
//
// Logs USDC + NGN equivalent of collateral and borrow amounts.

require("dotenv").config();
const { ethers } = require("ethers");

const AMOUNT_USDC = "1250"; // 1,250 USDC

// ---- ENV ----
const RPC_URL = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID
  ? parseInt(process.env.CHAIN_ID, 10)
  : 296;
const USDC = process.env.USDC_CONTRACT; // 0x...
const BS_ADDR = process.env.BORROW_SUPPLY_CONTRACT; // 0x...
const ORACLE = process.env.ORACLE_CONTRACT || process.env.ORACLEHUB_CONTRACT; // accept either var
const FX_ASSET =
  process.env.FX_ASSET || "0x00000000000000000000000000000000006a1e8c"; // NGN per USD asset
const U2_PK = process.env.USER_2_PRIVATE_KEY; // 0x...

if (!USDC) throw new Error("Missing USDC_CONTRACT");
if (!BS_ADDR) throw new Error("Missing BORROW_SUPPLY_CONTRACT");
if (!ORACLE) throw new Error("Missing ORACLE_CONTRACT (or ORACLEHUB_CONTRACT)");
if (!U2_PK) throw new Error("Missing USER_2_PRIVATE_KEY");

console.log("Config:");
console.log("  RPC_URL        :", RPC_URL);
console.log("  CHAIN_ID       :", CHAIN_ID);
console.log("  USDC           :", USDC);
console.log("  BORROW_SUPPLY  :", BS_ADDR);
console.log("  ORACLE         :", ORACLE);
console.log("  FX_ASSET       :", FX_ASSET);

// ---- ABIs ----
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const BS_ABI = [
  "function supply(uint256 amountE6) external",
  "function supplyPrincipalE6(address user) view returns (uint256)",
  "function accountPortfolio(address user) view returns (uint256 supplyE6,uint256 borrowE6,uint256 collateralValueE6,uint256 ltvCurrentBps,uint256 maxBorrowE6)",
];

const ORACLE_ABI = [
  "function getBand(address asset) view returns (uint128 midE6,uint16 widthBps,uint64 ts)",
  "function maxStaleness() view returns (uint64)",
];

// ---- run ----
(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const user2 = new ethers.Wallet(
    U2_PK.startsWith("0x") ? U2_PK : "0x" + U2_PK,
    provider
  );

  const usdc = new ethers.Contract(USDC, ERC20_ABI, user2);
  const bs = new ethers.Contract(BS_ADDR, BS_ABI, user2);
  const oracle = new ethers.Contract(ORACLE, ORACLE_ABI, provider);

  const [sym, decRaw] = await Promise.all([
    usdc.symbol().catch(() => "USDC"),
    usdc.decimals().catch(() => 6),
  ]);
  const dec = Number(decRaw);
  if (dec !== 6) console.warn(`WARN: ${sym} has ${dec} decimals (expected 6)`);

  const amountE6 = ethers.parseUnits(AMOUNT_USDC, 6);

  // Before
  const [balBefore, allowBefore, spBefore] = await Promise.all([
    usdc.balanceOf(user2.address),
    usdc.allowance(user2.address, BS_ADDR),
    bs.supplyPrincipalE6(user2.address).catch(() => 0n),
  ]);

  console.log(`\nUser2:           ${user2.address}`);
  console.log(`Supplying:       ${AMOUNT_USDC} ${sym}`);
  console.log(
    `Balance (before): ${(Number(balBefore) / 1e6).toFixed(2)} ${sym}`
  );
  console.log(
    `Allowance (before): ${(Number(allowBefore) / 1e6).toFixed(
      2
    )} ${sym} → BorrowSupply`
  );

  // Approve if needed (exact-approve pattern)
  if (allowBefore < amountE6) {
    if (allowBefore !== 0n) {
      const tx0 = await usdc.approve(BS_ADDR, 0);
      await tx0.wait();
    }
    const tx1 = await usdc.approve(BS_ADDR, amountE6);
    const rc1 = await tx1.wait();
    console.log(`approve tx: ${rc1.hash}`);
  } else {
    console.log(`Allowance already sufficient.`);
  }

  // Supply
  const tx = await bs.supply(amountE6);
  const rc = await tx.wait();
  console.log(`supply tx: ${rc.hash}`);

  // After supply: check portfolio + FX
  const [balAfter, portfolio, fxBand, maxStale] = await Promise.all([
    usdc.balanceOf(user2.address),
    bs.accountPortfolio(user2.address),
    oracle
      .getBand(FX_ASSET)
      .catch(() => ({ midE6: 1500000000n, widthBps: 0, ts: 0n })), // default 1,500 NGN/USD
    oracle.maxStaleness().catch(() => 900n),
  ]);

  const [supplyE6, borrowE6, collatE6, ltvBps, maxBorrowE6] = portfolio;

  // FX rate (NGN per USD), sanity on freshness
  const now = Math.floor(Date.now() / 1000);
  const fxFresh =
    fxBand && now <= Number(fxBand.ts || 0) + Number(maxStale || 0);
  const fxRate = Number(fxBand.midE6 || 1500000000n) / 1e6; // NGN per USD

  console.log("\n=== Portfolio ===");
  console.log(
    `Collateral:   $${(Number(collatE6) / 1e6).toFixed(6)}  (≈ ₦${(
      (Number(collatE6) / 1e6) *
      fxRate
    ).toFixed(2)}) ${fxFresh ? "" : "[FX ~stale/fallback]"}`
  );
  console.log(
    `Borrowed:     $${(Number(borrowE6) / 1e6).toFixed(6)}  (≈ ₦${(
      (Number(borrowE6) / 1e6) *
      fxRate
    ).toFixed(2)})`
  );
  console.log(
    `Max Borrow:   $${(Number(maxBorrowE6) / 1e6).toFixed(6)}  (≈ ₦${(
      (Number(maxBorrowE6) / 1e6) *
      fxRate
    ).toFixed(2)})`
  );
  console.log(
    `Supply:       $${(Number(supplyE6) / 1e6).toFixed(6)}  (≈ ₦${(
      (Number(supplyE6) / 1e6) *
      fxRate
    ).toFixed(2)})`
  );
  console.log(`Health (LTV): ${(Number(ltvBps) / 100).toFixed(2)} %`);

  console.log("\nBalances:");
  console.log(`Balance before: ${(Number(balBefore) / 1e6).toFixed(6)} ${sym}`);
  console.log(`Balance after:  ${(Number(balAfter) / 1e6).toFixed(6)} ${sym}`);
  console.log(`Supplied now:   ${(Number(supplyE6) / 1e6).toFixed(6)} ${sym}`);
  console.log("Done ✅");
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
