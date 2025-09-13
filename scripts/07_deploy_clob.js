require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const Clob = await ethers.getContractFactory("Clob");
  const [deployer] = await ethers.getSigners();
  const owner = await deployer.getAddress();

  const clob = await Clob.deploy(
    owner,
    process.env.ORACLEHUB_CONTRACT,
    process.env.DIRECT_SETTLE_ADAPTER,
    process.env.USDC_CONTRACT,
    process.env.FEE_SINK_EVM //fee sink
  );
  await clob.waitForDeployment();

  const deployedAddress = await clob.getAddress();

  console.log(deployedAddress);
}

main();
