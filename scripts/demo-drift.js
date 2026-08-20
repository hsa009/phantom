'use strict';

require('dotenv').config();
const { loadConfig } = require('../lib/config');
const { DriftFeed } = require('../lib/drift');

const RUN_MS = Number(process.env.DEMO_RUN_MS || 10000);

function validateQuote(q, i) {
  const checks = {
    'yesBid < yesAsk': q.yesBid < q.yesAsk,
    'noBid < noAsk': q.noBid < q.noAsk,
    'yesBid >= 0': q.yesBid >= 0,
    'yesAsk <= 1': q.yesAsk <= 1,
    'no = 1 - yes': Math.abs(q.noBid + q.yesAsk - 1) < 1e-9 && Math.abs(q.noAsk + q.yesBid - 1) < 1e-9,
    'not simulated': q.simulated === false,
    'drift market id': String(q.marketId).startsWith('BET-'),
  };
  const bad = Object.entries(checks).filter(([, ok]) => !ok);
  return bad.length ? bad.map(([k]) => k).join(', ') : 'OK';
}

async function main() {
  if (!process.env.RPC_URL) {
    throw new Error('RPC_URL is required — set it in .env (mainnet Helius key)');
  }
  const config = loadConfig();
  const feed = new DriftFeed(config);

  let sample = 0;
  let failures = 0;
  const seenMarkets = new Set();

  feed.on('tick', (q) => {
    sample += 1;
    const check = validateQuote(q, sample);
    if (check !== 'OK') failures += 1;
    seenMarkets.add(q.marketId);
    if (sample <= 3 || sample % 50 === 0) {
      console.log(
        `[tick #${sample}] mode=${q.mode} simulated=${q.simulated} mid=${q.mid} ` +
          `yes=${q.yesBid}..${q.yesAsk} no=${q.noBid}..${q.noAsk} market=${q.marketId}`
      );
    }
  });

  console.log(`Connecting to Drift via ${config.RPC_URL.replace(/api-key=.*$/, 'api-key=***')}`);
  feed.start();

  const timeout = setTimeout(() => {
    console.log('\n--- demo summary ---');
    const quote = feed.getQuote();
    console.log(`feed source   : ${feed.source}`);
    console.log(`source status : ${feed.sourceStatus}`);
    console.log(`ticks received: ${sample}`);
    console.log(`invalid quotes: ${failures}`);
    console.log(`markets seen  : ${seenMarkets.size} (${[...seenMarkets].join(', ')})`);
    console.log(`final quote   : ${JSON.stringify(quote)}`);
    const passed = failures === 0 && sample > 0;
    console.log(`validation    : ${passed ? 'PASS' : 'FAIL'}`);
    feed.stop();
    process.exit(passed ? 0 : 1);
  }, RUN_MS);
  timeout.unref();
}

main().catch((err) => {
  console.error('demo:drift failed:', err.message);
  process.exit(1);
});
