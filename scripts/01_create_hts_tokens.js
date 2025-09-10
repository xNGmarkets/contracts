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
  "xNGX-MTNNG",
  "xNGX-ZENITH",
  "xNGX-GTCO",
  "xNGX-OKOMUOIL",
  "xNGX-AIICO",
];

function loadECDSAKey(str) {
  if (str.startsWith("0x") || /^[0-9a-fA-F]{64}$/.test(str)) {
    const hex = str.replace(/^0x/, "");
    return PrivateKey.fromBytesECDSA(Buffer.from(hex, "hex"));
  }
  return PrivateKey.fromStringECDSA(str);
}

(async function main() {
  const operatorKey = loadECDSAKey(process.env.OPERATOR_KEY);
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
      .setInitialSupply(0)
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
