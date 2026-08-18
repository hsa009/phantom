'use strict';

require('dotenv').config();
const { loadConfig } = require('../lib/config');
const { getMarketFeed } = require('../lib/solana');

const RUN_MS = Number(process.env.DEMO_RUN_MS || 5000);

function validateQuote(q, i) {
  const checks = {
    'yesBid < yesAsk': q.yesBid < q.yesAsk,
    'noBid < noAsk': q.noBid < q.noAsk,
    'yesBid >= 0': q.yesBid >= 0,
    'yesAsk <= 1': q.yesAsk <= 1,
    'no = 1 - yes': Math.abs(q.noBid + q.yesAsk - 1) < 1e-9 && Math.abs(q.noAsk + q.yesBid - 1) < 1e-9,
  };
  const bad = Object.entries(checks).filter(([, ok]) => !ok);
  return bad.length ? bad.map(([k]) => k).join(', ') : 'OK';
}

async function main() {
  const config = loadConfig();
  const feed = getMarketFeed(config);

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

  feed.on('market', ({ marketId, timestamp }) => {
    console.log(`[rollover] new market window ${marketId} @ ${new Date(timestamp).toISOString()}`);
  });

  console.log(
    `Starting feed: mode=${feed.feedMode} source=${feed.source} interval=${config.FEED_INTERVAL_MS}ms`
  );
  feed.start();

  await new Promise((resolve) => setTimeout(resolve, RUN_MS));
  feed.stop();

  const quote = feed.getQuote();
  console.log('\n--- demo summary ---');
  console.log(`ticks received : ${sample}`);
  console.log(`invalid quotes : ${failures}`);
  console.log(`markets seen   : ${seenMarkets.size} (${[...seenMarkets].join(', ')})`);
  console.log(`final quote    : ${JSON.stringify(quote)}`);
  console.log(`validation     : ${failures === 0 ? 'PASS' : 'FAIL'}`);

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('demo:feed failed:', err.message);
  process.exit(1);
});