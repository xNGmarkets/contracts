// scripts/set_all_venues.js
// Usage:
//   npx hardhat run scripts/set_all_venues.js --network hedera-testnet
//
// Env needed:
//   CLOB_CONTRACT=0x...       (your deployed Clob.sol)
//   PRIVATE_KEY=0x...         (must be Clob owner)
//   (RPC_URL/CHAIN_ID are taken from hardhat network config)

require("dotenv").config();
const hre = require("hardhat");

const CLOB_ABI = [
  "function setVenue(address asset, uint8 state) external",
  "function venue(address asset) external view returns (uint8)",
  "function owner() external view returns (address)"
];

const VenueState = {
  Paused: 0,
  Continuous: 1,
  CallAuction: 2,
};

// --- Your 12 assets (HTS EVM addresses) ---
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

async function main() {
  const { ethers, network } = hre;

  const clobAddr = process.env.CLOB_CONTRACT;
  if (!clobAddr) {
    throw new Error("Missing CLOB_CONTRACT in .env");
  }

  const [signer] = await ethers.getSigners();
  console.log(`Network: ${network.name}`);
  console.log(`Signer:  ${await signer.getAddress()}`);

  const clob = new ethers.Contract(clobAddr, CLOB_ABI, signer);

  // Sanity check: signer must be owner
  const onChainOwner = await clob.owner();
  if (onChainOwner.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error(
      `Signer is not Clob owner.\n  owner: ${onChainOwner}\n  signer: ${await signer.getAddress()}`
    );
  }

  const results = [];

  for (const asset of ASSETS) {
    try {
      const before = await clob.venue(asset);
      if (Number(before) === VenueState.Continuous) {
        console.log(`✓ Already Continuous: ${asset}`);
        results.push({ asset, before: Number(before), after: Number(before), tx: null, changed: false });
        continue;
      }

      const tx = await clob.setVenue(asset, VenueState.Continuous);
      console.log(`→ setVenue(Continuous) sent for ${asset}. tx=${tx.hash}`);
      const rec = await tx.wait();

      const after = await clob.venue(asset);
      const ok = Number(after) === VenueState.Continuous;
      console.log(`   confirmed: state=${Number(after)} (${ok ? "Continuous" : "Unexpected"})`);

      results.push({ asset, before: Number(before), after: Number(after), tx: tx.hash, changed: true });
    } catch (err) {
      console.error(`✗ Failed for ${asset}:`, err.message || err);
      results.push({ asset, error: String(err.message || err) });
    }
  }

  console.log("\nSummary:");
  for (const r of results) {
    if (r.error) {
      console.log(`  - ${r.asset}  ERROR: ${r.error}`);
    } else if (r.changed) {
      console.log(`  - ${r.asset}  ${r.before} → ${r.after}  tx=${r.tx}`);
    } else {
      console.log(`  - ${r.asset}  unchanged (already Continuous)`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
