require("dotenv").config();
const {
  Client, AccountId, TokenAssociateTransaction, TokenGrantKycTransaction
} = require("@hashgraph/sdk");
const { loadECDSAKey, parseTokenId } = require("../utils/key");

(async () => {
  const operatorKey = loadECDSAKey(process.env.OPERATOR_KEY);
  const accountId   = AccountId.fromString(process.env.ACCOUNT_ID);
  const client = Client.forTestnet().setOperator(accountId, operatorKey);

  const tokens = (process.env.TOKENS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!tokens.length) throw new Error("Set TOKENS=0.0.x,0.0.y in .env");

  const tokenIds = tokens.map(parseTokenId);

  // 1) Associate
  const assocTx = await new TokenAssociateTransaction()
    .setAccountId(accountId)
    .setTokenIds(tokenIds)
    .freezeWith(client)
    .sign(operatorKey);

  const assocResp = await assocTx.execute(client);
  const assocRec  = await assocResp.getReceipt(client);
  console.log("Association status:", assocRec.status.toString());

  // 2) Grant KYC
  for (const t of tokenIds) {
    const kycTx = await new TokenGrantKycTransaction()
      .setAccountId(accountId)
      .setTokenId(t)
      .freezeWith(client)
      .sign(operatorKey);
    const kycResp = await kycTx.execute(client);
    const kycRec  = await kycResp.getReceipt(client);
    console.log(`Grant KYC for ${t.toString()} ->`, kycRec.status.toString());
  }
})().catch(console.error);
