require("dotenv").config();

const { ethers } = require("hardhat");

async function main() {
  const bs = await ethers.getContractAt(
    "BorrowSupplyV1",
    process.env.BORROW_SUPPLY_CONTRACT
  );

  // Put the tokens your contract must hold: USDC + each xNGX you’ll accept as collateral
  const tokens = [
    process.env.USDC_CONTRACT,
    process.env.AIICO,
    process.env.MTNN,
    process.env.UBA,
    process.env.GTCO,
    process.env.ZENITHBANK,
    process.env.ARADEL,
    process.env.TOTALNG,
    process.env.CORNERST,
    process.env.OKOMUOIL,
    process.env.PRESCO,
    process.env.NESTLE,
    process.env.DANGSUGAR,
  ].filter(Boolean);

  console.log("Associating:", tokens);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    console.log(`Associating token ${token}`);

    const tx = await bs.htsAssociate(token);
    const rc = await tx.wait();

    console.log("tx:", rc.hash);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
