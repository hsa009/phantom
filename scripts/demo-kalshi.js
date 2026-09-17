'use strict';

require('dotenv').config();
const { loadConfig } = require('../lib/config');
const { getMarketFeed, KalshiFeed } = require('../lib/solana');
const { PriceBtc } = require('../lib/btc-price');

function checkQuote(q) {
  const bad = [];
  const has = (k) => q[k] != null;
  if (has('yesBid') && has('yesAsk') && !(q.yesBid < q.yesAsk)) bad.push('yesBid/yestAsk');
  if (has('noBid') && has('noAsk') && !(q.noBid < q.noAsk)) bad.push('noBid/noAsk');
  if (has('noBid') && has('yesAsk') && Math.abs(q.noBid + q.yesAsk - 1) > 1e-9) bad.push('noBid!=1-yesAsk');
  if (has('noAsk') && has('yesBid') && Math.abs(q.noAsk + q.yesBid - 1) > 1e-9) bad.push('noAsk!=1-yesBid');
  return bad.length ? bad.join(', ') : 'OK';
}

async function main() {
  const config = loadConfig();
  config.MARKET_MODE = 'kalshi';
  const feed = getMarketFeed(config);
  if (!(feed instanceof KalshiFeed)) {
    throw new Error('expected KalshiFeed for MARKET_MODE=kalshi');
  }
  const priceBtc = new PriceBtc(config);
  feed._attachPriceBtc(priceBtc);
  feed.marketRoller = () => true;
  priceBtc.start();

  const RUN_MS = Number(process.env.DEMO_RUN_MS || 15000);
  const failures = { invalid: 0, activeInWindow: 0 };
  const seenMarkets = new Set();
  let samples = 0;
  let rollovers = 0;

  feed.on('tick', (q) => {
    samples += 1;
    const chk = checkQuote(q);
    if (chk !== 'OK') failures.invalid += 1;
    seenMarkets.add(q.marketId);
    const mi = feed.getMarketInfo();
    if (samples <= 3 || samples % 30 === 0) {
      console.log(
        `[tick #${samples}] market=${q.marketId} yes=${q.yesBid}..${q.yesAsk} ` +
          `no=${q.noBid}..${q.noAsk} price=${q.price != null ? '$' + q.price.toFixed(2) : '—'} ` +
          `windowEnd=${q.windowEnd ? new Date(q.windowEnd).toISOString() : '—'}`
      );
    }
    const wEnd = mi && mi.closeTime ? Number(mi.closeTime) : q.windowEnd;
    if (q.yesBid > 0 && q.yesAsk > 0 && wEnd) {
      const now = Date.now();
      if (!(now < wEnd)) failures.activeInWindow += 1;
    }
  });

  feed.on('market', (m) => {
    rollovers += 1;
    console.log(
      `[rollover] market=${m.marketId} closeTime=${m.closeTime ? new Date(m.closeTime).toISOString() : '—'}`
    );
  });

  console.log('[demo] starting Kalshi feed for ' + RUN_MS + 'ms...');
  feed.start();

  await new Promise((r) => setTimeout(r, RUN_MS));
  feed.stop();
  priceBtc.stop();

  const mi = feed.getMarketInfo();
  const quote = feed.getQuote();
  console.log('\n--- kalshi demo summary ---');
  console.log('ticks            :', samples);
  console.log('markets seen     :', seenMarkets.size);
  console.log('rollovers        :', rollovers);
  console.log('invalid quotes   :', failures.invalid);
  console.log('active-out-window:', failures.activeInWindow);
  console.log('active contract  :', mi ? mi.ticker : 'none');
  console.log('close time       :', mi && mi.closeTime ? new Date(mi.closeTime).toISOString() : '—');
  console.log('final quote      :', JSON.stringify(quote));

  const hasLiveBook = quote && quote.yesBid > 0 && quote.yesAsk > 0;
  const ok = samples > 0 && failures.invalid === 0 && failures.activeInWindow === 0;
  console.log(
    `validation        : ${ok ? 'PASS' : 'FAIL'}` +
      (hasLiveBook ? ' (live book present)' : ' (book not yet traded — windows opened only near their open_time)')
  );
  process.exit(ok ? 0 : 2);
}

main().catch((err) => {
  console.error('demo:kalshi failed:', err.message);
  process.exit(1);
});