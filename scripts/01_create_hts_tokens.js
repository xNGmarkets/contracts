require("dotenv").config();
const {
  Client,
  PrivateKey,
  AccountId,
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
  Hbar,
} = require("@hashgraph/sdk");

const TICKERS = [
  // "xNGX-MTNN",
  // "xNGX-UBA",
  // "xNGX-GTCO",
  // "xNGX-ZENITHBANK",
  // "xNGX-ARADEL",
  // "xNGX-TOTALNG",
  // "xNGX-AIICO",
  // "xNGX-CORNERST",
  // "xNGX-OKOMUOIL",
  // "xNGX-PRESCO",
  // "xNGX-NESTLE",
  // "xNGX-DANGSUGAR",
  "xNGX-NGN",
];

(async function main() {
  const operatorKey = PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY);
  const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);

  const kycKey = operatorKey,
    freezeKey = operatorKey,
    adminKey = operatorKey,
    supplyKey = operatorKey;

  for (const sym of TICKERS) {
    const tx = new TokenCreateTransaction()
      .setTokenName(sym)
      .setTokenSymbol(sym)
      .setDecimals(6)
      .setInitialSupply(1000 * 1e6) //MINT Intial supply for all stock
      .setTreasuryAccountId(operatorId)
      .setTokenType(TokenType.FungibleCommon)
      .setSupplyType(TokenSupplyType.Infinite)
      .setAdminKey(adminKey.publicKey)
      .setSupplyKey(supplyKey.publicKey)
      .setKycKey(kycKey.publicKey)
      .setFreezeKey(freezeKey.publicKey)
      .setMaxTransactionFee(new Hbar(10))
      .freezeWith(client);

    const resp = await (await tx.sign(operatorKey)).execute(client);
    const rec = await resp.getReceipt(client);
    const tokenId = rec.tokenId;
    const evm =
      typeof tokenId.toEvmAddress === "function"
        ? tokenId.toEvmAddress()
        : "0x" + tokenId.toEvmAddress();

    console.log(`${sym} -> tokenId=${tokenId.toString()} evm=${evm}`);
  }
})().catch(console.error);
