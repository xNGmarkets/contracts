// scripts/user1_lock100_aiico_borrow_25.js
// Usage:
//   RPC_URL=... CHAIN_ID=296 \
//   BORROW_SUPPLY_CONTRACT=0x... \
//   ORACLEHUB_CONTRACT=0x... \
//   USDC_CONTRACT=0x... \
//   AIICO=0x... \
//   USER_1_PRIVATE_KEY=0x... \
//   node scripts/user1_lock100_aiico_borrow_25.js

require("dotenv").config();
const { ethers } = require("ethers");

// ---------- ENV ----------
const RPC_URL  = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 296;

const ADDR = {
  BS:     process.env.BORROW_SUPPLY_CONTRACT, // BorrowSupplyV1
  ORACLE: process.env.ORACLEHUB_CONTRACT,     // IOracleHub
  USDC:   process.env.USDC_CONTRACT,
  AIICO:  process.env.AIICO,
};

const USER1_PK = process.env.USER_1_PRIVATE_KEY;

for (const [k,v] of Object.entries(ADDR)) {
  if (!v) throw new Error(`Missing env: ${k}`);
}
if (!USER1_PK) throw new Error("Missing env: USER_1_PRIVATE_KEY");

// ---------- ABIs (minimal) ----------
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const ORACLE_ABI = [
  // returns (midE6,widthBps,ts)
  "function getBand(address asset) view returns (uint128,uint16,uint64)",
  "function maxStaleness() view returns (uint64)"
];

const BS_ABI = [
  "function ltvBps() view returns (uint16)",
  "function lockCollateral(address asset, uint256 qtyE6) external",
  "function borrow(uint256 amountE6, address[] lockAssets, uint256[] lockQtyE6) external",
  "function accountPortfolio(address user) view returns (uint256 supplyE6, uint256 borrowE6, uint256 collateralValueE6, uint256 ltvCurrentBps, uint256 maxBorrowE6)"
];

// ---------- Helpers ----------
const ONE_E6 = 1_000_000n;

const fmt6 = (x) => (Number(x) / 1e6).toFixed(6);
const bn   = (x) => BigInt(x.toString());

async function tokenMeta(token, who) {
  const [dec, sym, bal] = await Promise.all([
    token.decimals().catch(()=>6),
    token.symbol().catch(()=>"?"),
    token.balanceOf(who)
  ]);
  return { dec, sym, bal: bn(bal) };
}

async function printBalances(label, usdc, aiico, user, pool) {
  const [uUSDC, uAIICO, pUSDC, pAIICO] = await Promise.all([
    usdc.balanceOf(user), aiico.balanceOf(user),
    usdc.balanceOf(pool), aiico.balanceOf(pool)
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

// ---------- Main ----------
(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const user1 = new ethers.Wallet(USER1_PK, provider);

  const usdc  = new ethers.Contract(ADDR.USDC, ERC20_ABI, user1);
  const aiico = new ethers.Contract(ADDR.AIICO, ERC20_ABI, user1);
  const bs    = new ethers.Contract(ADDR.BS,   BS_ABI,   user1);
  const oracle= new ethers.Contract(ADDR.ORACLE, ORACLE_ABI, provider);

  // Basic token meta
  const [mUSDC, mAIICO] = await Promise.all([
    tokenMeta(usdc, user1.address), tokenMeta(aiico, user1.address)
  ]);
  if (mUSDC.dec !== 6) console.warn(`WARN: USDC decimals = ${mUSDC.dec}, expected 6`);
  if (mAIICO.dec !== 6) console.warn(`WARN: AIICO decimals = ${mAIICO.dec}, expected 6`);

  console.log(`\n=== User1 lock 100 AIICO & borrow 25% of its value ===`);
  console.log(`User1: ${user1.address}`);
  console.log(`BorrowSupply: ${ADDR.BS}`);
  console.log(`USDC: ${ADDR.USDC} | AIICO: ${ADDR.AIICO}`);

  // Oracle price & freshness
  const [midE6, , ts] = await oracle.getBand(ADDR.AIICO);
  const maxStale = Number(await oracle.maxStaleness());
  const fresh = Math.floor(Date.now()/1000) <= Number(ts) + maxStale;
  if (!fresh) {
    console.error(`✗ Oracle stale for AIICO. mid=$${fmt6(bn(midE6))}, ts=${Number(ts)}, maxStaleness=${maxStale}s`);
    process.exit(1);
  }
  console.log(`Price: mid = $${fmt6(bn(midE6))} (fresh)`);

  // Intent: deposit (lock) 100 AIICO
  const qtyE6 = 100n * ONE_E6;

  // Borrow 25% of value in USDC
  // valueE6 = qtyE6 * pxE6 / 1e6
  const valueE6   = (qtyE6 * bn(midE6)) / ONE_E6;
  const borrowE6  = valueE6 / 4n; // 25%
  console.log(`Plan: lock ${fmt6(qtyE6)} AIICO  →  borrow $${fmt6(borrowE6)} USDC`);

  // LTV guard preview
  const ltvBps = await bs.ltvBps();
  if (Number(ltvBps) < 2500) {
    console.warn(`WARN: Pool LTV=${ltvBps}bps < 2500bps (25%). Borrow may fail.`);
  }

  // Liquidity check
  const poolUSDCBal = bn(await usdc.balanceOf(ADDR.BS));
  if (poolUSDCBal < borrowE6) {
    console.error(`✗ Pool has insufficient USDC liquidity. Have=$${fmt6(poolUSDCBal)} need=$${fmt6(borrowE6)}`);
    process.exit(1);
  }

  // Pre balances & portfolio
  await printBalances("\nPre balances:", usdc, aiico, user1.address, ADDR.BS);
  const port0 = await bs.accountPortfolio(user1.address);
  console.log(`Pre portfolio:
  • supply=$${fmt6(bn(port0.supplyE6))}  borrow=$${fmt6(bn(port0.borrowE6))}
  • collateralValue=$${fmt6(bn(port0.collateralValueE6))}
  • LTV=${Number(port0.ltvCurrentBps)} bps  maxBorrow=$${fmt6(bn(port0.maxBorrowE6))}`);

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

  // Borrow USDC (25% value)
  console.log("Borrowing USDC …");
  {
    // We’ve already locked, so pass empty arrays to borrow()
    const tx = await bs.borrow(borrowE6, [], []);
    const rc = await tx.wait();
    console.log(`  • borrow tx: ${rc.hash}`);
  }

  // Post balances & portfolio
  await printBalances("\nPost balances:", usdc, aiico, user1.address, ADDR.BS);
  const port1 = await bs.accountPortfolio(user1.address);
  console.log(`Post portfolio:
  • supply=$${fmt6(bn(port1.supplyE6))}  borrow=$${fmt6(bn(port1.borrowE6))}
  • collateralValue=$${fmt6(bn(port1.collateralValueE6))}
  • LTV=${Number(port1.ltvCurrentBps)} bps  maxBorrow=$${fmt6(bn(port1.maxBorrowE6))}\n`);

  console.log("Done.");
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
