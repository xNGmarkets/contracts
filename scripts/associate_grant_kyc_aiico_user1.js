// scripts/associate_grant_kyc_aiico_user1.js
// Associates USER_1 to AIICO and (if applicable) grants KYC to USER_1.
// Usage: node scripts/associate_grant_kyc_aiico_user1.js

require("dotenv").config();
const {
  Client,
  AccountId,
  PrivateKey,
  TokenId,
  TokenAssociateTransaction,
  TokenGrantKycTransaction,
  AccountInfoQuery,
  TokenInfoQuery,
  Status,
} = require("@hashgraph/sdk");

// ---- ENV ----
// Hedera network: this script uses testnet. Change to forMainnet() if needed.
const USER_ID = process.env.USER_1_ACCOUNT_ID; // e.g. 0.0.6834746
const USER_KEY = process.env.USER_1_PRIVATE_KEY; // hex ECDSA (with or without 0x)

const ADMIN_ID = process.env.OPERATOR_ACCOUNT_ID || process.env.ACCOUNT_ID; // KYC admin payer
const ADMIN_KEY = process.env.OPERATOR_PRIVATE_KEY || process.env.PRIVATE_KEY; // must control token kycKey

// AIICO token — you can pass either EVM address (0x...) or 0.0.x
const AIICO = process.env.AIICO; // 0x000...67de98
const AIICO_ID = process.env.AIICO_CONTRACT_ID; // optional 0.0.x; if set, used instead of EVM

if (!USER_ID || !USER_KEY)
  throw new Error("Missing USER_1_ACCOUNT_ID / USER_1_PRIVATE_KEY");
if (!ADMIN_ID || !ADMIN_KEY)
  throw new Error("Missing OPERATOR_ACCOUNT_ID / OPERATOR_PRIVATE_KEY");
if (!AIICO && !AIICO_ID)
  throw new Error("Provide AIICO (EVM) or AIICO_CONTRACT_ID (0.0.x) in env");

function hexKey(k) {
  return k.startsWith("0x") ? k : "0x" + k;
}

function toTokenId(x) {
  if (!x) throw new Error("Token id/address empty");
  if (x.startsWith("0x")) return TokenId.fromEvmAddress(0, 0, x);
  return TokenId.fromString(x);
}

async function assoc(userClient, userId, tokenId) {
  const tx = new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(userId))
    .setTokenIds([tokenId])
    .freezeWith(userClient);

  const signed = await tx.sign(
    PrivateKey.fromStringECDSA(hexKey(process.env.USER_1_PRIVATE_KEY))
  );
  const resp = await signed.execute(userClient);
  const rec = await resp.getReceipt(userClient);
  console.log(
    `• Associate ${userId} ↔ ${tokenId.toString()} : ${rec.status.toString()}`
  );
  return rec.status;
}

async function grantKyc(adminClient, userId, tokenId) {
  const tx = new TokenGrantKycTransaction()
    .setAccountId(AccountId.fromString(userId))
    .setTokenId(tokenId)
    .freezeWith(adminClient);

  const resp = await tx.execute(adminClient);
  const rec = await resp.getReceipt(adminClient);
  console.log(
    `• Grant KYC ${userId} on ${tokenId.toString()} : ${rec.status.toString()}`
  );
  return rec.status;
}

async function main() {
  const userClient = Client.forTestnet().setOperator(
    AccountId.fromString(USER_ID),
    PrivateKey.fromStringECDSA(hexKey(USER_KEY))
  );
  const adminClient = Client.forTestnet().setOperator(
    AccountId.fromString(ADMIN_ID),
    PrivateKey.fromStringECDSA(hexKey(ADMIN_KEY))
  );

  const tokenId = toTokenId(AIICO_ID || AIICO);

  // 1) Associate (safe if already associated)
  try {
    await assoc(userClient, USER_ID, tokenId);
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
      console.log(`• Already associated: ${USER_ID} ↔ ${tokenId.toString()}`);
    } else {
      throw e;
    }
  }

  // 2) If token enforces KYC (has kycKey), grant KYC with the token's KYC admin key
  const tInfo = await new TokenInfoQuery()
    .setTokenId(tokenId)
    .execute(adminClient);
  if (!tInfo.kycKey) {
    console.log("• Token has no kycKey → KYC not required/ignored");
  } else {
    try {
      await grantKyc(adminClient, USER_ID, tokenId);
    } catch (e) {
      // common: already granted
      const msg = e?.message || String(e);
      if (msg.includes("ACCOUNT_KYC_ALREADY_GRANTED")) {
        console.log(
          `• KYC already granted for ${USER_ID} on ${tokenId.toString()}`
        );
      } else {
        throw e;
      }
    }
  }

  // 3) Verify relationship
  const ai = await new AccountInfoQuery()
    .setAccountId(AccountId.fromString(USER_ID))
    .execute(adminClient);
  const rel = ai.tokenRelationships.get(tokenId.toString());
  if (!rel) {
    console.log("✗ Relationship missing (association failed?)");
  } else {
    console.log(
      `• Verified: assoc=${true}  kyc=${rel.isKycGranted}  frozen=${
        rel.isFrozen
      }  balance=${rel.balance.toString()}`
    );
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
