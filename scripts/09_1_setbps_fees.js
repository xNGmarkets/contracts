import { ethers } from "ethers";

// ===== CONFIG =====
const RPC_URL = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID
  ? parseInt(process.env.CHAIN_ID, 10)
  : 296;
const CLOB = process.env.CLOB_CONTRACT; // your CLOB contract address
const OWNER_KEY = process.env.OPERATOR_PRIVATE_KEY || process.env.PRIVATE_KEY; // must be CLOB owner

// 2% = 200 bps
const NEW_FEE_BPS = 200;

const ASSETS = [
  "0x000000000000000000000000000000000067de91", // MTNN
  "0x000000000000000000000000000000000067de93", // UBA
  "0x000000000000000000000000000000000067de94", // GTCO
  "0x000000000000000000000000000000000067de95", // ZENITHBANK
  "0x000000000000000000000000000000000067de96", // ARADEL
  "0x000000000000000000000000000000000067de97", // TOTALNG
  "0x000000000000000000000000000000000067de98", // AIICO
  "0x000000000000000000000000000000000067de99", // CORNERST
  "0x000000000000000000000000000000000067de9a", // OKOMUOIL
  "0x000000000000000000000000000000000067de9b", // PRESCO
  "0x000000000000000000000000000000000067de9c", // NESTLE
  "0x000000000000000000000000000000000067de9d", // DANGSUGAR
];

// ===== CLOB ABI (only what we need) =====
const CLOB_ABI = [
  "function setFeeBps(address asset, uint16 bps) external",
  "function feeBps(address asset) view returns (uint16)",
];

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(OWNER_KEY, provider);
  const clob = new ethers.Contract(CLOB, CLOB_ABI, wallet);

  console.log(
    "Setting feeBps = %d for %d assets...\n",
    NEW_FEE_BPS,
    ASSETS.length
  );

  for (let i = 0; i < ASSETS.length; i++) {
    const asset = ASSETS[i];
    try {
      const tx = await clob.setFeeBps(asset, NEW_FEE_BPS);
      await tx.wait();
      const updated = await clob.feeBps(asset);
      console.log(
        `${i + 1}. ${asset} → feeBps=${updated.toString()} (tx: ${tx.hash})`
      );
    } catch (e) {
      console.error(`${i + 1}. Failed for ${asset}:`, e.message);
    }
  }

  console.log("\nDone ✅");
})();
