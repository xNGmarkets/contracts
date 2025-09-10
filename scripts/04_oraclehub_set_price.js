require("dotenv").config();
const { ethers } = require("ethers");

const ABI = [
  "function setPrice(address asset,(uint256 priceE6,uint64 seq,uint64 ts,bytes32 hcsMsgId)) external"
];

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.HASHIO);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const oracle   = new ethers.Contract(process.env.ORACLE_HUB, ABI, wallet);

  const asset    = process.env.ASSET;
  const priceUsd = Number(process.env.PRICE_USD || "0.20");
  const priceE6  = Math.floor(priceUsd * 1e6);
  const seq      = BigInt(process.env.SEQ || "1");
  const ts       = BigInt(Math.floor(Date.now()/1000));
  const hcsMsgId = "0x" + "00".repeat(32);

  const tx = await oracle.setPrice(asset, { priceE6, seq, ts, hcsMsgId });
  console.log("setPrice tx:", tx.hash);
  await tx.wait();
  console.log("OK setPrice", { asset, priceE6 });
})();
