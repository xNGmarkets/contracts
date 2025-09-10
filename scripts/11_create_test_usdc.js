// create_usdc_hts.js
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

(async () => {
  const operatorKey = loadECDSA(process.env.OPERATOR_KEY);
  const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);

  const name = "USD Coin (HTS)";
  const symbol = "USDC";
  const tx = new TokenCreateTransaction()
    .setTokenName(name)
    .setTokenSymbol(symbol)
    .setDecimals(6)
    .setInitialSupply(0)
    .setTreasuryAccountId(operatorId)
    .setTokenType(TokenType.FungibleCommon)
    .setSupplyType(TokenSupplyType.Infinite)
    // no KYC key -> simpler UX for quote currency
    .setAdminKey(operatorKey.publicKey)
    .setSupplyKey(operatorKey.publicKey)
    .setFreezeDefault(false)
    .setMaxTransactionFee(new Hbar(10))
    .freezeWith(client);

  const resp = await (await tx.sign(operatorKey)).execute(client);
  const rec = await resp.getReceipt(client);
  const tokenId = rec.tokenId;
  const evm =
    typeof tokenId.toEvmAddress === "function"
      ? tokenId.toEvmAddress()
      : "0x" + tokenId.toEvmAddress();

  console.log(`USDC HTS created -> tokenId=${tokenId.toString()} evm=${evm}`);
})();
