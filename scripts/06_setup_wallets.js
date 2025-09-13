/* eslint-disable no-console */
require("dotenv").config();
const {
  Client,
  AccountId,
  PrivateKey,
  Hbar,
  AccountCreateTransaction,
  TokenAssociateTransaction,
  TokenGrantKycTransaction,
  TokenId,
} = require("@hashgraph/sdk");

/**
 * This script:
 * 1) Creates a fee sink ECDSA wallet (account)
 * 2) Associates fee sink to USDC (0.0.6808751) and optionally grants KYC
 * 3) Creates 3 user wallets
 * 4) Associates those wallets to all xNGX tokens + USDC
 * 5) Grants KYC for those wallets on each token (if the token was created with your operator as KYC key)
 *
 * Notes:
 * - Association tx payer is the OPERATOR (set on the client). The target account must SIGN each association.
 * - KYC grants are signed by the operator (must hold the token's KYC key).
 * - If a token doesn’t have KYC enabled (no kycKey), KYC grant will fail with TOKEN_HAS_NO_KYC_KEY; we ignore gracefully.
 */

const OPERATOR_ID = process.env.ACCOUNT_ID;
const OPERATOR_KEY = process.env.OPERATOR_KEY;

if (!OPERATOR_ID || !OPERATOR_KEY) {
  console.error("Missing OPERATOR_ID / OPERATOR_KEY in .env");
  process.exit(1);
}

const client = Client.forTestnet().setOperator(
  AccountId.fromString(OPERATOR_ID),
  PrivateKey.fromStringECDSA(OPERATOR_KEY)
);

// ---- Tokens (USDC + your xNGX set) ----
const USDC_ID = TokenId.fromString("0.0.6808751");

const STOCK_TOKENS = [
  { sym: "xNGX-MTNN", id: "0.0.6807185" },
  { sym: "xNGX-UBA", id: "0.0.6807187" },
  { sym: "xNGX-GTCO", id: "0.0.6807188" },
  { sym: "xNGX-ZENITHBANK", id: "0.0.6807189" },
  { sym: "xNGX-ARADEL", id: "0.0.6807190" },
  { sym: "xNGX-TOTALNG", id: "0.0.6807191" },
  { sym: "xNGX-AIICO", id: "0.0.6807192" },
  { sym: "xNGX-CORNERST", id: "0.0.6807193" },
  { sym: "xNGX-OKOMUOIL", id: "0.0.6807194" },
  { sym: "xNGX-PRESCO", id: "0.0.6807195" },
  { sym: "xNGX-NESTLE", id: "0.0.6807196" },
  { sym: "xNGX-DANGSUGAR", id: "0.0.6807197" },
].map((t) => ({ sym: t.sym, tokenId: TokenId.fromString(t.id) }));

// Helper: chunk an array (association supports multiple tokenIds per tx; keep small & safe)
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function createEcdsaAccount(label, initialHbar = 2) {
  const key = PrivateKey.generateECDSA();
  const pub = key.publicKey;

  const tx = await new AccountCreateTransaction()
    .setKeyWithoutAlias(pub)
    .setInitialBalance(new Hbar(initialHbar))
    .freezeWith(client)
    .sign(PrivateKey.fromStringECDSA(OPERATOR_KEY)); // payer signs

  const resp = await tx.execute(client);
  const rec = await resp.getReceipt(client);
  const accountId = rec.accountId;

  const acct = AccountId.fromString(accountId.toString());
  const evm = acct.toEvmAddress(); // 40 hex (no 0x)

  console.log(
    `\n[${label}] Account created: ${acct.toString()} | EVM 0x${evm}\nPrivateKey (ECDSA): ${key.toStringRaw()}`
  );

  return { accountId: acct, privateKey: key };
}

async function associateTokens(target, tokenIds) {
  // Hedera allows multiple tokenIds in one associate; we chunk to keep tx size small.
  const chunks = chunk(tokenIds, 6);
  for (const group of chunks) {
    const tx = new TokenAssociateTransaction()
      .setAccountId(target.accountId)
      .setTokenIds(group);

    const frozen = tx.freezeWith(client);
    // Payer (operator) already set via client. Target account MUST sign for association.
    const signed = await frozen.sign(target.privateKey);

    const resp = await signed.execute(client);
    const rec = await resp.getReceipt(client);
    console.log(
      `  Associated ${target.accountId.toString()} to ${group
        .map((t) => t.toString())
        .join(", ")} -> ${rec.status.toString()}`
    );
  }
}

async function grantKyc(target, tokenId) {
  try {
    const tx = new TokenGrantKycTransaction()
      .setTokenId(tokenId)
      .setAccountId(target.accountId)
      .freezeWith(client); // payer/operator set by client

    // Sign with operator (must hold token's KYC key)
    const signed = await tx.sign(PrivateKey.fromStringECDSA(OPERATOR_KEY));
    const resp = await signed.execute(client);
    const rec = await resp.getReceipt(client);

    console.log(
      `  KYC granted on ${tokenId.toString()} for ${target.accountId.toString()} -> ${rec.status.toString()}`
    );
  } catch (e) {
    const msg = String(e.message || e);
    // Common benign cases to ignore/soft-report:
    // - TOKEN_HAS_NO_KYC_KEY
    // - ACCOUNT_KYC_ALREADY_GRANTED
    if (
      msg.includes("TOKEN_HAS_NO_KYC_KEY") ||
      msg.includes("ACCOUNT_KYC_ALREADY_GRANTED")
    ) {
      console.log(
        `  KYC grant skipped for ${tokenId.toString()} (${msg.replace(
          /\n/g,
          " "
        )})`
      );
    } else {
      console.warn(`  KYC grant error for ${tokenId.toString()}: ${msg}`);
    }
  }
}

async function main() {
  console.log("== xNGX: Wallet bootstrap & associations (testnet) ==");

  // Build full token set: all stocks + USDC
  const ALL_TOKEN_IDS = [USDC_ID, ...STOCK_TOKENS.map((t) => t.tokenId)];

  // 1) Fee sink
  const feeSink = await createEcdsaAccount("FEE_SINK", 8);
  console.log("Associating FEE_SINK to USDC & all stock tokens…");
  await associateTokens(feeSink, ALL_TOKEN_IDS);
  console.log(
    "Granting KYC to FEE_SINK (if tokens support KYC & you hold the KYC key) …"
  );
  for (const t of ALL_TOKEN_IDS) {
    await grantKyc(feeSink, t);
  }

  // 2) Create three user wallets
  const users = [];
  for (let i = 1; i <= 3; i++) {
    const u = await createEcdsaAccount(`USER_${i}`, 8);
    users.push(u);
  }

  // 3) Associate users to all stock tokens + USDC
  for (const [idx, u] of users.entries()) {
    console.log(`Associating USER_${idx + 1} to USDC & all stock tokens…`);
    await associateTokens(u, ALL_TOKEN_IDS);
  }

  // 4) Grant KYC for each user on each token (if applicable)
  for (const [idx, u] of users.entries()) {
    console.log(`Granting KYC for USER_${idx + 1} on all tokens…`);
    for (const t of ALL_TOKEN_IDS) {
      await grantKyc(u, t);
    }
  }

  console.log("\nDone ✅");
  console.log(
    "\nNOTE:\n- If any token does not have a KYC key, KYC grant is skipped.\n- Associations are paid by the operator; the target account must still SIGN each association.\n- Printed private keys are raw ECDSA; store them securely."
  );
}

main().catch((err) => {
  console.error("\nERROR:", err?.message || err);
  process.exit(1);
});
