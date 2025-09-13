require("dotenv").config();

const ZERO = 0n;
const ONE_E6 = 1_000_000n;

function bn(x){ return BigInt(x); }
function fmtE6(x){ // USD*1e6 -> human
  const sign = x < 0 ? "-" : "";
  x = x < 0 ? -x : x;
  const i = x / ONE_E6;
  const f = (x % ONE_E6).toString().padStart(6, "0");
  return `${sign}$${i}.${f.slice(0,2)}`;
}

async function main() {
  const hre = require("hardhat");
  const { ethers } = hre;

  // ===== ENV =====
  const priv = process.env.PRIVATE_KEY;
  const CLOB = process.env.CLOB_CONTRACT;
  const ORACLE = process.env.ORACLEHUB_CONTRACT;
  const ADAPTER = process.env.DIRECT_SETTLE_ADAPTER; // address
  const AIICO = process.env.AIICO;                   // token EVM addr
  const USDC = process.env.USDC_CONTRACT;           // for info only

  if(!priv || !CLOB || !ORACLE || !ADAPTER || !AIICO || !USDC){
    throw new Error("Missing one or more env vars: PRIVATE_KEY, CLOB_CONTRACT, ORACLEHUB_CONTRACT, DIRECT_SETTLE_ADAPTER, AIICO, USDC_CONTRACT");
  }

  // ===== Provider & Signer (hedera-testnet via Hashio per hardhat.config) =====
  const [signer] = await ethers.getSigners(); // uses PRIVATE_KEY from --network accounts
  console.log(`Using operator=${await signer.getAddress()}`);

  // ===== Minimal ABIs =====
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];

  const ORACLE_ABI = [
    // BandPayload: (uint128 midE6, uint16 widthBps, uint64 ts)
    "function getBand(address asset) view returns (tuple(uint128 midE6, uint16 widthBps, uint64 ts))",
    "function maxStaleness() view returns (uint64)"
  ];

  const CLOB_ABI = [
    "function place(address asset, uint8 side, bool isMarket, uint128 qty, uint128 pxE6) returns (uint256 id)",
    "function setVenue(address asset, uint8 state)",
    "function venue(address asset) view returns (uint8)", // 0=Paused,1=Continuous,2=CallAuction
    "event Placed(uint256 indexed id, address indexed asset, address indexed trader, uint8 side, bool isMarket, uint128 qty, uint128 pxE6)"
  ];

  // ===== Contracts =====
  const aiico = new ethers.Contract(AIICO, ERC20_ABI, signer);
  const oracle = new ethers.Contract(ORACLE, ORACLE_ABI, signer);
  const clob = new ethers.Contract(CLOB, CLOB_ABI, signer);

  // ===== 1) Read band & mid price =====
  const band = await oracle.getBand(AIICO);
  const maxStale = await oracle.maxStaleness();
  const now = Math.floor(Date.now()/1000);
  const isFresh = now <= Number(band.ts) + Number(maxStale);
  if (!isFresh) {
    throw new Error(`Oracle stale for AIICO: band.ts=${band.ts}, maxStaleness=${maxStale}, now=${now}`);
  }
  const midE6 = BigInt(band.midE6);
  const widthBps = BigInt(band.widthBps);
  const delta = (midE6 * widthBps) / 10000n;
  const lo = midE6 - delta;
  const hi = midE6 + delta;

  console.log(`Band mid=${fmtE6(midE6)} width=${band.widthBps}bps -> [${fmtE6(lo)}, ${fmtE6(hi)}]`);

  // We’ll place the limit AT mid (inside band)
  const limitPxE6 = midE6;

  // ===== 2) Compute qty for $50 notional =====
  const usdNotionalE6 = 50n * ONE_E6; // $50 * 1e6
  const decimals = await aiico.decimals(); // expect 6
  const scale = 10n ** BigInt(decimals);

  // We assume qty is in base units (adapter.move(asset,..,qty) uses ERC20 base units).
  // qtyBase = notional(USD*1e6) * tokenScale / price(USD*1e6)
  let qty = (usdNotionalE6 * scale) / limitPxE6;
  if (qty === ZERO) qty = 1n; // ensure > 0
  if (decimals !== 6) {
    console.warn(`AIICO decimals=${decimals} (not 6). Using scale=${scale.toString()}.`);
  }
  console.log(`Placing SELL: qty(base)=${qty.toString()} @ px=${fmtE6(limitPxE6)} ~ ${fmtE6((limitPxE6 * qty) / scale)} notional`);

  // ===== 3) Ensure venue is Continuous (1) =====
  try {
    const v = await clob.venue(AIICO);
    if (Number(v) !== 1) {
      console.log(`Venue not Continuous (=${v}). Attempting setVenue(asset,1)…`);
      const tx = await clob.setVenue(AIICO, 1);
      await tx.wait();
      console.log(`Venue set to Continuous.`);
    } else {
      console.log(`Venue already Continuous.`);
    }
  } catch (e) {
    console.warn(`Could not set/check venue (maybe not owner). Ensure asset venue is Continuous before matching. Reason: ${e.message ?? e}`);
  }

  // ===== 4) Approve DirectSettleAdapter to spend AIICO from operator (seller) =====
  const me = await signer.getAddress();
  const bal = await aiico.balanceOf(me);
  if (bal < qty) {
    throw new Error(`Insufficient AIICO balance. Have=${bal.toString()}, need=${qty.toString()}`);
  }
  const allowance = await aiico.allowance(me, ADAPTER);
  if (allowance < qty) {
    console.log(`Approving adapter=${ADAPTER} for qty=${qty.toString()}…`);
    const tx = await aiico.approve(ADAPTER, qty);
    await tx.wait();
    console.log(`Approved.`);
  } else {
    console.log(`Existing allowance is sufficient.`);
  }

  // ===== 5) Place SELL LIMIT on CLOB =====
  // Side: 0=Buy, 1=Sell
  const sideSell = 1;
  const isMarket = false;

  const txPlace = await clob.place(
    AIICO,
    sideSell,
    isMarket,
    qty,              // uint128
    limitPxE6        // uint128
  );
  const rc = await txPlace.wait();
  let orderId = null;
  for (const log of rc.logs) {
    try {
      const parsed = clob.interface.parseLog(log);
      if (parsed?.name === "Placed") {
        orderId = parsed.args.id.toString();
        break;
      }
    } catch (_) {}
  }
  console.log(`Placed SELL LIMIT order${orderId ? ` id=${orderId}` : ""}.`);

  console.log(`Done. Reminder: buyer must have USDC allowance to adapter for settlement.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
