// scripts/check_adapter_allowances.js
// Prints adapter allowances:
//  - USDC:  OPERATOR_EVM  -> DIRECT_SETTLE_ADAPTER
//  - AIICO: USER_{1,2,3}_EVM -> DIRECT_SETTLE_ADAPTER (only those provided)
//
// ENV:
//   RPC_URL, CHAIN_ID
//   DIRECT_SETTLE_ADAPTER
//   USDC_CONTRACT
//   AIICO
//   OPERATOR_EVM
//   USER_1_EVM [optional]
//   USER_2_EVM [optional]
//   USER_3_EVM [optional]

require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://testnet.hashio.io/api";
const CHAIN_ID = process.env.CHAIN_ID
  ? parseInt(process.env.CHAIN_ID, 10)
  : 296;

const ADAPTER = must("DIRECT_SETTLE_ADAPTER");
const USDC = must("USDC_CONTRACT");
const AIICO = must("AIICO");
const OPERATOR = must("OPERATOR_EVM");

const U1 = process.env.USER_1_EVM || null;
const U2 = process.env.USER_2_EVM || null;
const U3 = process.env.USER_3_EVM || null;

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

function must(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

function fmt(amount, decimals) {
  try {
    return ethers.formatUnits(amount, decimals);
  } catch {
    // fall back if contract misreports; assume 6
    return ethers.formatUnits(amount, 6);
  }
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);

  const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
  const aiico = new ethers.Contract(AIICO, ERC20_ABI, provider);

  // Fetch token meta
  const [usdcSym, usdcDec, aiicoSym, aiicoDec] = await Promise.all([
    usdc.symbol().catch(() => "USDC"),
    usdc
      .decimals()
      .then(Number)
      .catch(() => 6),
    aiico.symbol().catch(() => "AIICO"),
    aiico
      .decimals()
      .then(Number)
      .catch(() => 6),
  ]);

  console.log("=== Adapter Allowance Check ===");
  console.log("RPC:", RPC_URL);
  console.log("Adapter:", ADAPTER);
  console.log("");

  // OPERATOR: USDC -> Adapter
  {
    const raw = await usdc.allowance(OPERATOR, ADAPTER);
    console.log(
      `OPERATOR → Adapter (${usdcSym})`,
      `\n  owner:   ${OPERATOR}`,
      `\n  token:   ${USDC} (${usdcSym}, dec=${usdcDec})`,
      `\n  spender: ${ADAPTER}`,
      `\n  allowance: ${raw.toString()} (raw) = ${fmt(
        raw,
        usdcDec
      )} ${usdcSym}\n`
    );
  }

  // USERS: USDC -> Adapter
  const users = [
    ["USER_1", U1],
    // ["USER_2", U2],
    // ["USER_3", U3],
  ].filter(([, addr]) => !!addr);

  for (const [label, addr] of users) {
    const raw = await usdc.allowance(addr, ADAPTER);
    console.log(
      `${label} → Adapter (${aiicoSym})`,
      `\n  owner:   ${addr}`,
      `\n  token:   ${usdcSym} (${usdcSym}, dec=${usdcDec})`,
      `\n  spender: ${ADAPTER}`,
      `\n  allowance: ${raw.toString()} (raw) = ${fmt(
        raw,
        usdcDec
      )} ${usdcSym}\n`
    );
  }

  if (users.length === 0) {
    console.log(
      "Note: no USER_{1,2,3}_EVM set in env — only printed OPERATOR's USDC allowance."
    );
  }
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
