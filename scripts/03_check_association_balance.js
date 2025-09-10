require("dotenv").config();
const { Client, AccountId, AccountBalanceQuery } = require("@hashgraph/sdk");
const { loadECDSAKey, parseTokenId } = require("../utils/key");

(async () => {
  const operatorKey = loadECDSAKey(process.env.OPERATOR_KEY);
  const accountId   = AccountId.fromString(process.env.ACCOUNT_ID);
  const client = Client.forTestnet().setOperator(accountId, operatorKey);

  const token = parseTokenId(process.env.TOKEN || "");
  const bal = await new AccountBalanceQuery().setAccountId(accountId).execute(client);
  const tidStr = token.toString();
  const amt = bal.tokens._map.get(tidStr) || 0n;
  console.log(`Balance for ${tidStr}:`, amt.toString());
})().catch(console.error);
