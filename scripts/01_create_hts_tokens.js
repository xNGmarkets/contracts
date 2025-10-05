require("dotenv").config();

const {
  Client,
  PrivateKey,
  AccountId,
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
  TokenMintTransaction,
  TokenBurnTransaction,
  TokenWipeTransaction,
  TransferTransaction,
  Hbar,
} = require("@hashgraph/sdk");

async function main() {
  // Auto-detect key type (ED25519 or ECDSA)
  const operatorKey = PrivateKey.fromString(process.env.OPERATOR_KEY);
  const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);

  // Use separate keys in production; reusing operator for demo simplicity
  const adminKey  = operatorKey;
  const supplyKey = operatorKey;
  const wipeKey   = operatorKey;

  // Create a fungible token with infinite supply + wipe capability
  const createTx = await new TokenCreateTransaction()
    .setTokenName("Green Points - GreenAfrica.org")
    .setTokenSymbol("GREEN")
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(6)
    .setInitialSupply(0)
    .setSupplyType(TokenSupplyType.Infinite)
    .setTreasuryAccountId(operatorId)
    .setAdminKey(adminKey.publicKey)
    .setSupplyKey(supplyKey.publicKey)
    .setWipeKey(wipeKey.publicKey)            // <-- REQUIRED to remove from user accounts
    // Omit KYC/Freeze keys for a smoother UX:
    // .setKycKey(kycKey.publicKey)
    // .setFreezeKey(freezeKey.publicKey)
    .setMaxTransactionFee(new Hbar(10))
    .freezeWith(client)
    .sign(operatorKey);

  const createRx = await (await createTx.execute(client)).getReceipt(client);
  const tokenId = createRx.tokenId;
  const evm = "0x" + tokenId.toSolidityAddress();
  console.log("TokenId:", tokenId.toString());
  console.log("EVM address:", evm);

  // --- EXAMPLES ---

  // 1) Mint to treasury
  const amount = 1000n * 1_000_000n; // 1000 GREEN @ 6 decimals
  await (await (await new TokenMintTransaction()
    .setTokenId(tokenId)
    .setAmount(Number(amount))
    .freezeWith(client))
    .sign(supplyKey))
    .execute(client);

  // 2) Transfer to a user (ensure the user is associated or has unlimited auto-association)
  const USER = AccountId.fromString(process.env.USER_ID); // set in .env
  await (await new TransferTransaction()
    .addTokenTransfer(tokenId, operatorId, -Number(amount))
    .addTokenTransfer(tokenId, USER, Number(amount))
    .execute(client));

  // 3) “Burn” from treasury (reduces total supply) — only affects treasury balance
  const burnAmt = 10n * 1_000_000n;
  await (await (await new TokenBurnTransaction()
    .setTokenId(tokenId)
    .setAmount(Number(burnAmt))
    .freezeWith(client))
    .sign(supplyKey))
    .execute(client);

  // 4) Remove tokens from a user’s wallet (admin wipe; also reduces total supply)
  const wipeAmt = 5n * 1_000_000n;
  await (await (await new TokenWipeTransaction()
    .setTokenId(tokenId)
    .setAccountId(USER)
    .setAmount(Number(wipeAmt))
    .freezeWith(client))
    .sign(wipeKey))
    .execute(client);

  console.log("Done.");
}

main().catch(console.error);
