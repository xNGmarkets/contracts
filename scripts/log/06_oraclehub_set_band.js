require("dotenv").config();
const { ethers } = require("ethers");

const ABI = [
  "function setBand(address asset,(uint256 midE6,uint32 widthBps,uint64 ts)) external"
];

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.HASHIO);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const oracle   = new ethers.Contract(process.env.ORACLE_HUB, ABI, wallet);

  const asset    = process.env.ASSET;
  const midUsd   = Number(process.env.PRICE_USD || "0.20");
  const widthBps = Number(process.env.BAND_BPS || "150");
  const midE6    = Math.floor(midUsd * 1e6);
  const ts       = BigInt(Math.floor(Date.now()/1000));

  const tx = await oracle.setBand(asset, { midE6, widthBps, ts });
  console.log("setBand tx:", tx.hash);
  await tx.wait();
  console.log("OK setBand", { asset, midE6, widthBps });
})();
