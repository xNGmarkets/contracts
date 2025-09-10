// mint_usdc_hts.js
require("dotenv").config();
const {
  Client,
  PrivateKey,
  AccountId,
  TokenId,
  TokenMintTransaction,
  TokenAssociateTransaction,
  Hbar,
} = require("@hashgraph/sdk");

(async () => {
  const operatorKey = loadECDSA(process.env.OPERATOR_KEY);
  const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);

  const tokenId = TokenId.fromString(process.env.USDC_TOKEN_ID);
  const _tx = await new TokenAssociateTransaction()
    .setAccountId(operatorId)
    .setTokenIds([tokenId])
    .freezeWith(client)
    .sign(operatorKey);

  const _resp = await _tx.execute(client);
  const _rec = await _resp.getReceipt(client);
  console.log("USDC association:", _rec.status.toString());

  const amount = Number(process.env.MINT_USDC || "100000000"); // 100,000,000 = 100 USDC (6dp)
  const tx = new TokenMintTransaction()
    .setTokenId(tokenId)
    .setAmount(amount)
    .setMaxTransactionFee(new Hbar(10))
    .freezeWith(client);

  const resp = await (await tx.sign(operatorKey)).execute(client);
  const rec = await resp.getReceipt(client);
  console.log("Mint status:", rec.status.toString());
})();
