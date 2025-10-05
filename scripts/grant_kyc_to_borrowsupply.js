// scripts/grant_kyc_to_borrowsupply.js
require("dotenv").config();
const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  ContractId,
  AccountInfoQuery,
  TokenGrantKycTransaction,
} = require("@hashgraph/sdk");

// ------- Helpers -------
const net = (process.env.HEDERA_NETWORK || "testnet").toLowerCase();
function pk(str) {
  return PrivateKey.fromStringECDSA(str.startsWith("0x") ? str : "0x" + str);
}
function toTokenId(x) {
  if (!x) throw new Error("TokenId empty");
  return x.startsWith("0x")
    ? TokenId.fromEvmAddress(0, 0, x)
    : TokenId.fromString(x);
}
function toAccountId(x) {
  if (!x) throw new Error("Account/Contract id empty");
  if (x.startsWith("0x")) return AccountId.fromEvmAddress(0, 0, x); // contract evm
  if (x.includes(".")) return AccountId.fromString(x); // 0.0.x
  // fallback: contract-id like "0.0.x" expected; also accept "contract:0.0.x"
  return AccountId.fromString(x);
}

// Build the list of tokens to KYC
const TOKENS = [
  //   process.env.USDC_CONTRACT_ID || process.env.USDC_CONTRACT,
  process.env.AIICO,
  process.env.MTNN,
  process.env.UBA,
  process.env.GTCO,
  process.env.ZENITHBANK,
  process.env.ARADEL,
  process.env.TOTALNG,
  process.env.CORNERST,
  process.env.OKOMUOIL,
  process.env.PRESCO,
  process.env.NESTLE,
  process.env.DANGSUGAR,
].filter(Boolean);

// Target account = Borrow/Supply contract’s account
const CONTRACT_ID =
  process.env.BORROW_SUPPLY_CONTRACT_ID || process.env.BORROW_SUPPLY_CONTRACT; // accept EVM; we convert below

// KYC admin (must be the token’s kycKey)
const ADMIN_ID = process.env.OPERATOR_ACCOUNT_ID;
const ADMIN_KEY = process.env.OPERATOR_PRIVATE_KEY;

(async () => {
  if (!ADMIN_ID || !ADMIN_KEY)
    throw new Error("Missing OPERATOR_ACCOUNT_ID / OPERATOR_PRIVATE_KEY");
  if (!CONTRACT_ID)
    throw new Error(
      "Missing BORROW_SUPPLY_CONTRACT_ID or BORROW_SUPPLY_CONTRACT"
    );
  if (TOKENS.length === 0) throw new Error("No tokens provided in env");

  const client =
    net === "mainnet"
      ? Client.forMainnet()
      : net === "previewnet"
      ? Client.forPreviewnet()
      : Client.forTestnet();

  client.setOperator(AccountId.fromString(ADMIN_ID), pk(ADMIN_KEY));

  const contractAccount = toAccountId(CONTRACT_ID);
  console.log("Network:", net);
  console.log("Admin:", ADMIN_ID);
  console.log("BorrowSupply (account):", contractAccount.toString());
  console.log("Tokens:", TOKENS);

  // Check existing relationships once
  const rels = await new AccountInfoQuery()
    .setAccountId(contractAccount)
    .execute(client);

  for (const t of TOKENS) {
    const tId = toTokenId(t);
    const rel = rels.tokenRelationships.get(tId.toString());
    const associated = !!rel;
    const kyc = rel ? rel.isKycGranted : false;

    console.log(`\n[${tId}] associated=${associated} kyc=${kyc}`);

    if (!associated) {
      console.warn(
        "  • Not associated yet — associate first (contract must call htsAssociate or you do TokenAssociate via admin, if token allows)."
      );
    }

    if (kyc) {
      console.log("  • KYC already granted — skipping");
      continue;
    }

    try {
      const tx = await new TokenGrantKycTransaction()
        .setTokenId(tId)
        .setAccountId(contractAccount)
        .freezeWith(client)
        .sign(pk(ADMIN_KEY)); // must be the token’s kycKey

      const resp = await tx.execute(client);
      const rec = await resp.getReceipt(client);
      console.log("  • GrantKYC status:", rec.status.toString());
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes("ACCOUNT_KYC_ALREADY_GRANTED_FOR_TOKEN")) {
        console.log("  • KYC already granted (race) — ok");
      } else if (msg.includes("TOKEN_HAS_NO_KYC_KEY")) {
        console.log("  • Token has no KYC key — nothing to grant (ok)");
      } else {
        console.error("  ✗ GrantKYC failed:", msg);
      }
    }
  }

  console.log("\nDone.");
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
