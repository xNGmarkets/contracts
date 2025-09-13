require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const Clob = await ethers.getContractFactory("Clob");
  const [deployer] = await ethers.getSigners();
  const owner = await deployer.getAddress();

  const clob = await Clob.deploy(
    owner,
    "0xc51076c08596D3007DC4673bb8E64BAc2B2eBd19", //owner
    "0x4a4078Fe786E20476d1cA1c87Cd491bD16c3fE48", //oracle
    "0x000000000000000000000000000000000067e4af", //adapter
    "0x000000000000000000000000000000000067e65e" //fee sink
  );
  await clob.waitForDeployment();

  const deployedAddress = await clob.getAddress();

  console.log(deployedAddress);
}

main();
