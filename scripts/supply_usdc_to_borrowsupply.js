// scripts/supply_user2_1250_usdc.js
// Usage:
//   RPC_URL=https://testnet.hashio.io/api \
//   CHAIN_ID=296 \
//   BORROW_SUPPLY_CONTRACT=0xYourBorrowSupply \
//   USDC_CONTRACT=0x000000000000000000000000000000000067e4af \
//   USER_2_PRIVATE_KEY=... \
//   node scripts/supply_user2_1250_usdc.js
//
// Notes:
// - Approves EXACT amount (handles the common HTS 0->new allowance pattern).
// - Exits with helpful hints if a transferFrom fails (likely association/KYC).

require("dotenv").config();
const { ethers } = require("ethers");

// ---- config (change AMOUNT_USDC if needed) ----
const AMOUNT_USDC = "1250"; // 1,250 USDC

const RPC_URL   = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID  = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 296;
const USDC      = process.env.USDC_CONTRACT;
const BS_ADDR   = process.env.BORROW_SUPPLY_CONTRACT;
const U2_PK     = process.env.USER_2_PRIVATE_KEY;

if (!USDC)   throw new Error("Missing USDC_CONTRACT");
if (!BS_ADDR)throw new Error("Missing BORROW_SUPPLY_CONTRACT");
if (!U2_PK)  throw new Error("Missing USER_2_PRIVATE_KEY");

// ---- ABIs (minimal) ----
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const BS_ABI = [
  "function supply(uint256 amountE6) external",
  "function supplyPrincipalE6(address user) view returns (uint256)"
];

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const user2 = new ethers.Wallet(U2_PK.startsWith("0x") ? U2_PK : "0x"+U2_PK, provider);

  const usdc = new ethers.Contract(USDC, ERC20_ABI, user2);
  const bs   = new ethers.Contract(BS_ADDR, BS_ABI, user2);

  const [sym, dec] = await Promise.all([
    usdc.symbol().catch(()=> "USDC"),
    usdc.decimals().catch(()=> 6)
  ]);
  if (dec !== 6) console.warn(`WARN: ${sym} has ${dec} decimals (expected 6)`);

  const amountE6 = ethers.parseUnits(AMOUNT_USDC, 6);

  // Read balances / allowance
  const [balBefore, allowBefore, spBefore] = await Promise.all([
    usdc.balanceOf(user2.address),
    usdc.allowance(user2.address, BS_ADDR),
    bs.supplyPrincipalE6(user2.address).catch(()=> 0n)
  ]);

  console.log(`User2:  ${user2.address}`);
  console.log(`USDC:   ${USDC} (${sym}, ${dec}dp)`);
  console.log(`Pool:   ${BS_ADDR}`);
  console.log(`Supplying: ${AMOUNT_USDC} ${sym} (${amountE6.toString()} base units)`);
  console.log(`Balance:   ${(Number(balBefore)/1e6).toFixed(6)} ${sym}`);
  console.log(`Allowance: ${(Number(allowBefore)/1e6).toFixed(6)} ${sym} → BorrowSupply`);
  console.log(`Supply P (before): ${(Number(spBefore)/1e6).toFixed(6)} ${sym}`);

  // Ensure allowance == needed (exact approve pattern; handle non-zero -> zero -> new)
  if (allowBefore < amountE6) {
    if (allowBefore !== 0n) {
      console.log(`Allowance short and non-zero; approving 0 first…`);
      const tx0 = await usdc.approve(BS_ADDR, 0);
      await tx0.wait();
    }
    console.log(`Approving ${AMOUNT_USDC} ${sym} for BorrowSupply…`);
    const tx1 = await usdc.approve(BS_ADDR, amountE6);
    const rc1 = await tx1.wait();
    console.log(`approve tx: ${rc1.hash}`);
  } else {
    console.log(`Allowance already sufficient.`);
  }

  // Call supply(amountE6)
  try {
    console.log(`Calling supply(${amountE6.toString()})…`);
    const tx = await bs.supply(amountE6);
    const rc = await tx.wait();
    console.log(`supply tx: ${rc.hash}`);
  } catch (e) {
    console.error(`✗ supply() reverted: ${e.reason || e.shortMessage || e.message}`);
    console.error(
      `Hints: ensure User2 and the BorrowSupply contract are HTS-associated (and KYC if enforced) to USDC.`
    );
    process.exit(1);
  }

  // Read after
  const [balAfter, spAfter] = await Promise.all([
    usdc.balanceOf(user2.address),
    bs.supplyPrincipalE6(user2.address).catch(()=> 0n)
  ]);
  console.log(`Balance (after): ${(Number(balAfter)/1e6).toFixed(6)} ${sym}`);
  console.log(`Supply P (after): ${(Number(spAfter)/1e6).toFixed(6)} ${sym}`);
  console.log(`Done.`);
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
