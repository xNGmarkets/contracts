require("dotenv").config();
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

(async () => {
  const MIRROR = process.env.MIRROR_URL || "https://testnet.mirrornode.hedera.com";
  const TOPIC  = process.env.HCS_TOPIC_ID;
  if(!TOPIC) throw new Error("Set HCS_TOPIC_ID in .env");

  const url = `${MIRROR}/api/v1/topics/${TOPIC}/messages?limit=10&order=desc`;
  const res = await fetch(url);
  if(!res.ok){ throw new Error(`Mirror error ${res.status}`); }
  const json = await res.json();
  // decode base64 payloads
  const msgs = (json.messages || []).map(m=>{
    const data = Buffer.from(m.message, 'base64').toString('utf8');
    let parsed=null; try { parsed = JSON.parse(data); } catch {}
    return { consensus_timestamp: m.consensus_timestamp, sequence_number: m.sequence_number, payload: parsed || data };
  });
  console.log(JSON.stringify(msgs, null, 2));
})();
