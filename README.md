# xNG


- Stock Tokens are represented in the form xNGX-{ticker}
- Stock Tokens are native HTS Tokens

```
scripts/oracle_set_price.ts

import { ethers } from "hardhat";

async function main() {
  const oracle = await ethers.getContractAt("OracleHub", process.env.ORACLE_HUB!);

  // Example payload for xNGX-MTNN (use the *HTS token EVM address* as asset)
  const asset = "0x...HTS_TOKEN_EVM_ADDRESS_FOR_MTNN...";
  const priceE6 = Math.floor(282.45 * 1e6);
  const seq = 1234;                 // strictly increasing per asset
  const ts  = Math.floor(Date.now()/1000);
  const hcsMsgId = "0x0000...";     // optional mirror reference

  const tx = await oracle.setPrice(asset, { priceE6, seq, ts, hcsMsgId });
  await tx.wait();
  console.log("setPrice ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
``

```
scripts/oracle_set_band.ts

import { ethers } from "hardhat";

async function main() {
  const oracle = await ethers.getContractAt("OracleHub", process.env.ORACLE_HUB!);

  // Example band for MTNN: mid=$282.45, width=±1.50%
  const asset = "0x...HTS_TOKEN_EVM_ADDRESS_FOR_MTNN...";
  const midE6 = Math.floor(282.45 * 1e6);
  const widthBps = 150; // ±1.50%
  const ts = Math.floor(Date.now()/1000);

  const tx = await oracle.setBand(asset, { midE6, widthBps, ts });
  await tx.wait();
  console.log("setBand ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
```
