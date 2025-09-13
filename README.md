# xNG


## Smart Contract Layout
```
contracts/
  ├─ Clob.sol                      # Minimal Central Limit Order Book (CLOB) w/ band guards + fixed notional math
  ├─ DirectSettleAdapter.sol       # Non‑custodial adapter; only transferFrom - Stateless
  └─ interfaces/
       ├─ IOracleHub.sol           # Oracle interface (getBand / maxStaleness)
       └─ IMoveAdapter.sol         # Adapter interface (move)
```


```
xNGX-MTNN -> tokenId=0.0.6807185 evm=000000000000000000000000000000000067de91
xNGX-UBA -> tokenId=0.0.6807187 evm=000000000000000000000000000000000067de93
xNGX-GTCO -> tokenId=0.0.6807188 evm=000000000000000000000000000000000067de94
xNGX-ZENITHBANK -> tokenId=0.0.6807189 evm=000000000000000000000000000000000067de95
xNGX-ARADEL -> tokenId=0.0.6807190 evm=000000000000000000000000000000000067de96
xNGX-TOTALNG -> tokenId=0.0.6807191 evm=000000000000000000000000000000000067de97
xNGX-AIICO -> tokenId=0.0.6807192 evm=000000000000000000000000000000000067de98
xNGX-CORNERST -> tokenId=0.0.6807193 evm=000000000000000000000000000000000067de99
xNGX-OKOMUOIL -> tokenId=0.0.6807194 evm=000000000000000000000000000000000067de9a
xNGX-PRESCO -> tokenId=0.0.6807195 evm=000000000000000000000000000000000067de9b
xNGX-NESTLE -> tokenId=0.0.6807196 evm=000000000000000000000000000000000067de9c
xNGX-DANGSUGAR -> tokenId=0.0.6807197 evm=000000000000000000000000000000000067de9d
```

```
OracleHub(verified) -> ContractId=0.0.6809934 evm=0xc51076c08596D3007DC4673bb8E64BAc2B2eBd19
USDC xNG -> tokenId=0.0.6808751 evm=000000000000000000000000000000000067e4af
DirectSettleAdapter(verified)  -> ContractId=0.0.6808805 evm=0x4a4078Fe786E20476d1cA1c87Cd491bD16c3fE48
Clob(verified)  -> ContractId=0.0.6809287 evm=0x4e21F8f8314782068080DaBfb1b92A9446a3E978
```

```
//scripts/oracle_set_price.ts

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
```

```
//scripts/oracle_set_band.ts

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
