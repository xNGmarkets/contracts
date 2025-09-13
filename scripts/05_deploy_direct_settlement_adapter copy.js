require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const DirectSettleAdapter = await ethers.getContractFactory(
    "DirectSettleAdapter"
  );

  const directSettleAdapterContract = await DirectSettleAdapter.deploy();
  await directSettleAdapterContract.waitForDeployment();

  const deployedAddress = await directSettleAdapterContract.getAddress();

  console.log(deployedAddress);
}

main();
