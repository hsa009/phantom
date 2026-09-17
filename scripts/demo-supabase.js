'use strict';

require('dotenv').config();
const { loadConfig } = require('../lib/config');
const { getMarketFeed } = require('../lib/solana');
const { PaperEngine } = require('../lib/engine');
const { getStore } = require('../lib/supabase');

function overrideForDemo(config) {
  const dur = Number(process.env.DEMO_MARKET_MS || 8000);
  config.MARKET_DURATION_MS = dur;
  config.EXIT_BUFFER_MS = Math.max(500, Math.round(dur * 0.2));
  config.MOMENTUM_LOOKBACK_MS = Math.min(config.MOMENTUM_LOOKBACK_MS, Math.round(dur * 0.5));
  config.MOMENTUM_THRESHOLD = Math.max(0.0005, config.MOMENTUM_THRESHOLD * 0.5);
  return config;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const config = overrideForDemo(loadConfig());
  const feed = getMarketFeed(config);
  const engine = new PaperEngine(config, feed);
  const store = getStore(config);

  const MIN_WINDOWS = Number(process.env.DEMO_MIN_WINDOWS || 10);
  const TIME_BUDGET_MS = Number(process.env.DEMO_TIME_BUDGET_MS || 90000);

  engine.on('tradeOpened', (t) => {
    store.logOpen(t).catch((err) => console.error('[store] logOpen failed:', err.message));
  });
  engine.on('tradeClosed', (t) => {
    store
      .closeTrade(t.id, { exitPrice: t.exitPrice, pnl: t.pnl, reason: t.reason, closedAt: t.closedAt })
      .catch((err) => console.error('[store] closeTrade failed:', err.message));
  });

  feed.start();
  engine.start();

  const startedAt = Date.now();
  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const status = engine.getStatus();
    if (status.totalTrades >= MIN_WINDOWS) break;
    await sleep(200);
  }

  const recovered = await store.recoverOpenPositions();

  const engineHistory = engine.getTrades(500);
  const rows = await store.list(500);
  const stats = await store.getStats();

  const opened = engineHistory.length;
  const matched = engineHistory.filter((t) => {
    const row = rows.find((r) => r.id === t.id);
    if (!row) return false;
    return (
      row.status === 'CLOSED' &&
      row.reason === t.reason &&
      Math.round(row.entry_price - t.entryPrice) === 0 &&
      Math.round(row.exit_price - t.exitPrice) === 0 &&
      Math.round((row.pnl ?? 0) - t.pnl) === 0
    );
  }).length;

  engine.stop();
  feed.stop();

  console.log('\n--- supabase demo summary ---');
  console.log(`store mode     : ${store.mode}`);
  console.log(`engine trades  : ${opened}`);
  console.log(`recovered open : ${recovered.length}`);
  console.log(`store rows     : ${rows.length} (${rows.filter((r) => r.status === 'CLOSED').length} closed, ${rows.filter((r) => r.status === 'OPEN').length} open)`);
  console.log(`rows matching engine: ${matched}/${opened}`);
  console.log('store stats    :', JSON.stringify(stats));
  if (rows[0]) console.log('latest row     :', JSON.stringify(rows[0]));

  const ok =
    matched === opened &&
    opened > 0 &&
    stats.openCount === 0;
  console.log(`validation     : ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}
main().catch((err) => {
  console.error('demo:supabase failed:', err.message);
  process.exit(1);
});