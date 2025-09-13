// scripts/match_best_all.js
// Run matching on all assets and log tx hashes (and trade counts).
// Usage:
//   RPC_URL=https://testnet.hashio.io/api \
//   CHAIN_ID=296 \
//   PRIVATE_KEY=0x... \
//   CLOB_CONTRACT=0x... \
//   node scripts/match_best_all.js

import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

// ---------- Config ----------
const MAX_MATCHES = Number(process.env.MAX_MATCHES || 50); // attempts per asset

// Your asset list (EVM addresses)
const ASSETS = [
  ["MTNN", "0x000000000000000000000000000000000067de91"],
  ["UBA", "0x000000000000000000000000000000000067de93"],
  ["GTCO", "0x000000000000000000000000000000000067de94"],
  ["ZENITHBANK", "0x000000000000000000000000000000000067de95"],
  ["ARADEL", "0x000000000000000000000000000000000067de96"],
  ["TOTALNG", "0x000000000000000000000000000000000067de97"],
  ["AIICO", "0x000000000000000000000000000000000067de98"],
  ["CORNERST", "0x000000000000000000000000000000000067de99"],
  ["OKOMUOIL", "0x000000000000000000000000000000000067de9a"],
  ["PRESCO", "0x000000000000000000000000000000000067de9b"],
  ["NESTLE", "0x000000000000000000000000000000000067de9c"],
  ["DANGSUGAR", "0x000000000000000000000000000000000067de9d"],
];

// ---------- Minimal ABI ----------
const CLOB_ABI = [
  "function matchBest(address asset, uint256 maxMatches) external",
  "event Trade(address indexed asset, uint256 indexed buyId, uint256 indexed sellId, address buyer, address seller, uint128 qty, uint128 pxE6, uint256 notionalE6, uint256 feeE6)",
];

// ---------- Main ----------
async function main() {
  const rpcUrl = process.env.RPC_URL || "https://testnet.hashio.io/api";
  const chainId = process.env.CHAIN_ID
    ? parseInt(process.env.CHAIN_ID, 10)
    : 296;
  const pk = process.env.PRIVATE_KEY;
  const CLOB = process.env.CLOB_CONTRACT;

  if (!pk) throw new Error("Missing PRIVATE_KEY");
  if (!CLOB) throw new Error("Missing CLOB_CONTRACT");

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const wallet = new ethers.Wallet(pk, provider);
  const clob = new ethers.Contract(CLOB, CLOB_ABI, wallet);
  const iface = new ethers.Interface(CLOB_ABI);

  console.log(`Operator: ${wallet.address}`);
  console.log(`CLOB:     ${CLOB}`);
  console.log(`MAX_MATCHES per asset: ${MAX_MATCHES}`);

  for (const [ticker, asset] of ASSETS) {
    try {
      console.log(`\n→ Matching ${ticker} (${asset}) …`);
      const tx = await clob.matchBest(asset, MAX_MATCHES);
      console.log(`  submitted: ${tx.hash}`);
      const rc = await tx.wait();

      // Count Trade events in this transaction
      let tradeCount = 0;
      for (const log of rc.logs || []) {
        if (log.address.toLowerCase() !== CLOB.toLowerCase()) continue;
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === "Trade") tradeCount++;
        } catch (_) {}
      }
      console.log(
        `  confirmed: ${rc.transactionHash}  (trades in tx: ${tradeCount})`
      );
    } catch (err) {
      const msg =
        err?.reason || err?.shortMessage || err?.message || String(err);
      console.error(`  ✗ matchBest failed for ${ticker}: ${msg}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
