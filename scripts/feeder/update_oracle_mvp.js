// feeder/update_oracle_mvp.js
import 'dotenv/config';
import { ethers } from 'ethers';
import OracleHubAbi from './abi/OracleHub.json' assert { type: 'json' };

const RPC = process.env.RPC_URL || 'https://testnet.hashio.io/api';
const PK  = process.env.PRIVATE_KEY;
const ORACLE = process.env.ORACLE_HUB;
const ASSETS = (process.env.ASSETS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(pair => { const [sym, addr] = pair.split(':'); return { sym, addr }; });

const provider = new ethers.JsonRpcProvider(RPC);
const wallet   = new ethers.Wallet(PK, provider);
const oracle   = new ethers.Contract(ORACLE, OracleHubAbi, wallet);

const seqMap = Object.fromEntries(ASSETS.map(a => [a.addr.toLowerCase(), 0]));
const now = () => Math.floor(Date.now()/1000);

function demoPriceE6() {
  const base = 200_000; // $0.200000
  const jitter = Math.floor((Math.random()-0.5)*400); // ±$0.0002
  return base + jitter;
}

async function runOnce(){
  const ts = now();
  for (const { sym, addr } of ASSETS) {
    const priceE6 = demoPriceE6();

    // (optional) read current seq from chain for continuity
    const cur = await oracle.getPrice(addr);
    const nextSeq = Number(cur.seq || 0) + 1;
    const hcsMsgId = '0x' + '00'.repeat(32);

    // Push price
    await (await oracle.setPrice(addr, { priceE6, seq: nextSeq, ts, hcsMsgId })).wait();

    // Push fixed band (mid = price, width = 150 bps)
    await (await oracle.setBand(addr, { midE6: priceE6, widthBps: 150, ts })).wait();

    console.log(`[${sym}] price=${priceE6} mid=${priceE6} band=±150bps ts=${ts}`);
  }
}

runOnce().catch(err => { console.error(err); process.exit(1); });
