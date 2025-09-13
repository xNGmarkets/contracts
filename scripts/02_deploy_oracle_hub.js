require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const OracleHub = await ethers.getContractFactory("OracleHub");

  const maxStalenessInSecs = 30 * 60; //30 mins ~ 1800 secs
  const oracleHubContract = await OracleHub.deploy(maxStalenessInSecs);
  await oracleHubContract.waitForDeployment();

  const deployedAddress = await oracleHubContract.getAddress();

  console.log(deployedAddress);
}

main();
