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
  const operatorKey = PrivateKey.fromStringECDSA(process.env.FEE_SINK_KEY);
  const operatorId = AccountId.fromString(process.env.FEE_SINK_ACCOUNT_ID);
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);

  const tokenId = TokenId.fromString(process.env.USDC_CONTRACT_ID);
  const _tx = await new TokenAssociateTransaction()
    .setAccountId(operatorId)
    .setTokenIds([tokenId])
    .freezeWith(client)
    .sign(operatorKey);

  const _resp = await _tx.execute(client);
  const _rec = await _resp.getReceipt(client);
  console.log("USDC association:", _rec.status.toString());

  // const amount = Number(1_000_000 * 1e6); // 100,000,000 = 100 USDC (6dp)
  // const tx = new TokenMintTransaction()
  //   .setTokenId(tokenId)
  //   .setAmount(amount)
  //   .setMaxTransactionFee(new Hbar(10))
  //   .freezeWith(client);

  // const mintTxSign = await tx.sign(operatorKey);
  // const mintTxSubmit = await mintTxSign.execute(client);
  // const mintRx = await mintTxSubmit.getReceipt(client);

  // console.log("Mint status:", mintTxSubmit.transactionId.toString());
})();
