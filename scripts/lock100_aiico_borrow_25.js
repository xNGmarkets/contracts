// scripts/user1_lock100_aiico_borrow_25.js
// Usage:
//   RPC_URL=... CHAIN_ID=296 \
//   BORROW_SUPPLY_CONTRACT=0x... \
//   ORACLEHUB_CONTRACT=0x... \
//   USDC_CONTRACT=0x... \
//   AIICO=0x... \
//   FX_ASSET=0x...              # OracleHub asset: midE6 = NGN per 1 USD
//   USER_1_PRIVATE_KEY=0x... \
//   node scripts/user1_lock100_aiico_borrow_25.js

require("dotenv").config();
const { ethers } = require("ethers");

// ---------- ENV ----------
const RPC_URL = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID
  ? parseInt(process.env.CHAIN_ID, 10)
  : 296;

const ADDR = {
  BS: process.env.BORROW_SUPPLY_CONTRACT, // BorrowSupplyV1
  ORACLE: process.env.ORACLEHUB_CONTRACT, // IOracleHub
  USDC: process.env.USDC_CONTRACT,
  AIICO: process.env.AIICO,
  FX: process.env.FX_ASSET, // OracleHub asset for NGN per USD
};

const USER1_PK = process.env.USER_1_PRIVATE_KEY;

for (const [k, v] of Object.entries(ADDR)) {
  if (!v) throw new Error(`Missing env: ${k}`);
}
if (!USER1_PK) throw new Error("Missing env: USER_1_PRIVATE_KEY");

// ---------- ABIs (minimal) ----------
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const ORACLE_ABI = [
  // returns (midE6,widthBps,ts)
  "function getBand(address asset) view returns (uint128 midE6, uint16 widthBps, uint64 ts)",
  "function maxStaleness() view returns (uint64)",
];

const BS_ABI = [
  "function ltvBps() view returns (uint16)",
  "function lockCollateral(address asset, uint256 qtyE6) external",
  "function borrow(uint256 amountE6, address[] lockAssets, uint256[] lockQtyE6) external",
  "function accountPortfolio(address user) view returns (uint256 supplyE6, uint256 borrowE6, uint256 collateralValueE6, uint256 ltvCurrentBps, uint256 maxBorrowE6)",
];

// ---------- Helpers ----------
const ONE_E6 = 1_000_000n;

const fmt6 = (x) => (Number(x) / 1e6).toFixed(6);
const fmtUSD = (xE6) => `$${fmt6(xE6)}`;
const fmtNGN = (xE6) => `₦${fmt6(xE6)}`;
const bn = (x) => BigInt(x.toString());

async function tokenMeta(token, who) {
  const [decRaw, sym, bal] = await Promise.all([
    token.decimals().catch(() => 6),
    token.symbol().catch(() => "?"),
    token.balanceOf(who),
  ]);
  const dec = Number(decRaw);
  return { dec, sym, bal: bn(bal) };
}

async function printBalances(label, usdc, aiico, user, pool) {
  const [uUSDC, uAIICO, pUSDC, pAIICO] = await Promise.all([
    usdc.balanceOf(user),
    aiico.balanceOf(user),
    usdc.balanceOf(pool),
    aiico.balanceOf(pool),
  ]);
  console.log(`${label}
  • User1   USDC=${fmt6(bn(uUSDC))}  AIICO=${fmt6(bn(uAIICO))}
  • Pool    USDC=${fmt6(bn(pUSDC))}  AIICO=${fmt6(bn(pAIICO))}`);
}

async function ensureExactApproval(token, ownerAddr, spender, need) {
  const cur = bn(await token.allowance(ownerAddr, spender));
  if (cur >= need) return;

  // Many HTS proxies require approve(0) → approve(new)
  try {
    const tx0 = await token.approve(spender, 0);
    await tx0.wait();
  } catch (_) {}
  const tx = await token.approve(spender, need);
  const rc = await tx.wait();
  console.log(`  • approve(${need}) done: ${rc.hash}`);
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const user1 = new ethers.Wallet(
    USER1_PK.startsWith("0x") ? USER1_PK : "0x" + USER1_PK,
    provider
  );

  const usdc = new ethers.Contract(ADDR.USDC, ERC20_ABI, user1);
  const aiico = new ethers.Contract(ADDR.AIICO, ERC20_ABI, user1);
  const bs = new ethers.Contract(ADDR.BS, BS_ABI, user1);
  const oracle = new ethers.Contract(ADDR.ORACLE, ORACLE_ABI, provider);

  // Basic token meta
  const [mUSDC, mAIICO] = await Promise.all([
    tokenMeta(usdc, user1.address),
    tokenMeta(aiico, user1.address),
  ]);
  if (mUSDC.dec !== 6)
    console.warn(`WARN: USDC decimals = ${mUSDC.dec}, expected 6`);
  if (mAIICO.dec !== 6)
    console.warn(`WARN: AIICO decimals = ${mAIICO.dec}, expected 6`);

  console.log(
    `\n=== User1 lock 200 AIICO & borrow 25% (USD valuation; logs in USD & NGN) ===`
  );
  console.log(`User1: ${user1.address}`);
  console.log(`BorrowSupply: ${ADDR.BS}`);
  console.log(
    `USDC: ${ADDR.USDC} | AIICO: ${ADDR.AIICO} | FX (NGN/USD): ${ADDR.FX}`
  );

  // Oracle bands & freshness
  const [aiicoBand, fxBand, maxStale] = await Promise.all([
    oracle.getBand(ADDR.AIICO), // midE6_NGN
    oracle.getBand(ADDR.FX), // midE6_NGN_PER_USD
    oracle.maxStaleness(),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const freshEq = now <= Number(aiicoBand.ts) + Number(maxStale);
  const freshFx = now <= Number(fxBand.ts) + Number(maxStale);

  if (!freshEq || !freshFx) {
    console.error(`✗ Stale oracle:
      AIICO ts=${Number(aiicoBand.ts)} fresh=${freshEq}
      FX    ts=${Number(fxBand.ts)} fresh=${freshFx}
      maxStaleness=${Number(maxStale)}s`);
    process.exit(1);
  }

  // Convert NGN mid to USD mid via FX: pxUsdE6 = (midNgnE6 * 1e6) / fxNgnPerUsdE6
  const midNgnE6 = bn(aiicoBand.midE6);
  const fxNgnPerUsdE6 = bn(fxBand.midE6);
  const pxUsdE6 = (midNgnE6 * ONE_E6) / fxNgnPerUsdE6; // USD * 1e6
  const pxNgnE6 = midNgnE6; // NGN * 1e6

  console.log(`Price (from OracleHub):
  • AIICO ≈ ${fmtUSD(pxUsdE6)}  (≈ ${fmtNGN(pxNgnE6)}), width=${
    aiicoBand.widthBps
  } bps (both fresh)`);

  // Intent: deposit (lock) 200 AIICO
  const qtyE6 = 200n * ONE_E6;

  // USD value = qty * USDpx / 1e6; NGN value = qty * NGNpx / 1e6 (for logs)
  const valueUsdE6 = (qtyE6 * pxUsdE6) / ONE_E6;
  const valueNgnE6 = (qtyE6 * pxNgnE6) / ONE_E6;

  // Borrow 25% of USD value
  const borrowE6 = valueUsdE6 / 4n; // 25%

  console.log(`Plan:
  • Lock:       ${fmt6(qtyE6)} AIICO
  • Valuation:  ${fmtUSD(valueUsdE6)}  (≈ ${fmtNGN(valueNgnE6)})
  • Borrow 25%: ${fmtUSD(borrowE6)}  (≈ ${fmtNGN(
    (borrowE6 * fxNgnPerUsdE6) / ONE_E6
  )})`);

  // LTV guard preview
  const ltvBps = await bs.ltvBps();
  if (Number(ltvBps) < 2500) {
    console.warn(
      `WARN: Pool LTV=${ltvBps}bps < 2500bps (25%). Borrow may fail.`
    );
  }

  // Liquidity check
  const poolUSDCBal = bn(await usdc.balanceOf(ADDR.BS));
  if (poolUSDCBal < borrowE6) {
    console.error(
      `✗ Pool USDC liquidity low. Have=${fmtUSD(poolUSDCBal)} need=${fmtUSD(
        borrowE6
      )}`
    );
    process.exit(1);
  }

  // Pre balances & portfolio
  await printBalances("\nPre balances:", usdc, aiico, user1.address, ADDR.BS);
  const port0 = await bs.accountPortfolio(user1.address);
  console.log(`Pre portfolio:
  • supply=${fmtUSD(bn(port0.supplyE6))}  borrow=${fmtUSD(bn(port0.borrowE6))}
  • collateralValue=${fmtUSD(bn(port0.collateralValueE6))}
  • LTV=${Number(port0.ltvCurrentBps)} bps  maxBorrow=${fmtUSD(
    bn(port0.maxBorrowE6)
  )}`);

  // Approve EXACT AIICO for locking
  console.log("\nApprovals …");
  await ensureExactApproval(aiico, user1.address, ADDR.BS, qtyE6);

  // Lock collateral (pulls AIICO from User1 → BS)
  console.log("\nLocking collateral …");
  {
    const tx = await bs.lockCollateral(ADDR.AIICO, qtyE6);
    const rc = await tx.wait();
    console.log(`  • lockCollateral tx: ${rc.hash}`);
  }

  // Borrow USDC (25% USD value)
  console.log("Borrowing USDC …");
  {
    // Already locked, so pass empty arrays to borrow()
    const tx = await bs.borrow(borrowE6, [], []);
    const rc = await tx.wait();
    console.log(`  • borrow tx: ${rc.hash}`);
  }

  // Post balances & portfolio
  await printBalances("\nPost balances:", usdc, aiico, user1.address, ADDR.BS);
  const port1 = await bs.accountPortfolio(user1.address);

  // Log portfolio in USD and NGN equivalents
  const borrowUsdE6 = bn(port1.borrowE6);
  const collUsdE6 = bn(port1.collateralValueE6);
  const maxUsdE6 = bn(port1.maxBorrowE6);

  const borrowNgnE6 = (borrowUsdE6 * fxNgnPerUsdE6) / ONE_E6;
  const collNgnE6 = (collUsdE6 * fxNgnPerUsdE6) / ONE_E6;
  const maxNgnE6 = (maxUsdE6 * fxNgnPerUsdE6) / ONE_E6;

  console.log(`Post portfolio:
  • supply=${fmtUSD(bn(port1.supplyE6))}  borrow=${fmtUSD(
    borrowUsdE6
  )} (≈ ${fmtNGN(borrowNgnE6)})
  • collateralValue=${fmtUSD(collUsdE6)} (≈ ${fmtNGN(collNgnE6)})
  • LTV=${Number(port1.ltvCurrentBps)} bps  maxBorrow=${fmtUSD(
    maxUsdE6
  )} (≈ ${fmtNGN(maxNgnE6)})\n`);

  console.log("Done.");
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
