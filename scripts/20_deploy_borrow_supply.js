require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const BorrowSupplyV1 = await ethers.getContractFactory("BorrowSupplyV1");

  const borrowSupplyV1Contract = await BorrowSupplyV1.deploy(
    process.env.USDC_CONTRACT,
    process.env.ORACLEHUB_CONTRACT
  );

  await borrowSupplyV1Contract.waitForDeployment();

  const deployedAddress = await borrowSupplyV1Contract.getAddress();

  console.log(deployedAddress);
}

main();
