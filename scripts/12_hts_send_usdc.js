// scripts/12_hts_send_usdc.js
// Send 100,000 USDC (6dp) each to 3 users from the treasury (operator)

require("dotenv").config();
const {
  AccountId,
  PrivateKey,
  Client,
  TokenId,
  TransferTransaction,
  Hbar,
} = require("@hashgraph/sdk");

// ---- ENV ----
// Required:
// OPERATOR_ID=0.0.xxxxxxx
// OPERATOR_KEY=0x.... (ECDSA private key)
// USDC_CONTRACT_ID=0.0.6808751
// USER_1_ACCOUNT_ID=0.0.6809185
// USER_2_ACCOUNT_ID=0.0.6809186
// USER_3_ACCOUNT_ID=0.0.6809187

(async function main() {
  try {
    // Client (testnet)
    const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
    const operatorKey = PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY);
    const client = Client.forTestnet().setOperator(operatorId, operatorKey);

    // Token & accounts
    const tokenId = TokenId.fromString(process.env.AIICO_CONTRACT_ID);

    const USERS = [
      process.env.USER_1_ACCOUNT_ID,
      // process.env.USER_2_ACCOUNT_ID,
      // process.env.USER_3_ACCOUNT_ID,
      // "0.0.6734752",
    ].filter(Boolean);

    // if (USERS.length !== 3) {
    //   throw new Error("Missing one or more USER_{1,2,3}_ACCOUNT_ID env vars.");
    // }

    // Amount: 100,000 USDC with 6 decimals = 100,000 * 1,000,000 = 100,000,000,000
    // Use Number (safe here) — NOT BigInt — for @hashgraph/sdk transfer amounts
    const amountUnits = 500 * 1000000; // Number(1e11) — within JS safe integer

    // Build a single multi-party TransferTransaction
    let tx = new TransferTransaction()
      .setTransactionMemo("Airdrop Token to users")
      .setMaxTransactionFee(new Hbar(5));

    // Debit the treasury once per user (and credit each user)
    for (const idStr of USERS) {
      const aid = AccountId.fromString(idStr);
      tx = tx
        .addTokenTransfer(tokenId, operatorId, -amountUnits) // debit treasury/operator
        .addTokenTransfer(tokenId, aid, amountUnits); // credit user
    }

    // Freeze, sign, execute
    tx = tx.freezeWith(client);
    const signed = await tx.sign(operatorKey);
    const resp = await signed.execute(client);
    const rec = await resp.getReceipt(client);

    console.log("✅ Transfer status:", rec.status.toString());
    console.log(
      `Sent ${amountUnits} units (100,000 USDC) to each of ${USERS.length} users`
    );
  } catch (err) {
    console.error("❌ ERROR:", err);
    process.exit(1);
  }
})();
