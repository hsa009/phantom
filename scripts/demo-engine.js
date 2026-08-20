'use strict';

require('dotenv').config();
const { loadConfig } = require('../lib/config');
const { getMarketFeed } = require('../lib/solana');
const { PaperEngine } = require('../lib/engine');

/**
 * Fast-mode demo harness for the engine.
 *
 * Overrides the 5-minute market duration with DEMO_MARKET_MS (default 8000ms)
 * so take-profit / stop-loss / expiry paths all become observable quickly.
 * Verify the math yourself with:  pnl == tokensBought*exitPrice - stake
 */

function overrideForDemo(config) {
  const dur = Number(process.env.DEMO_MARKET_MS || 8000);
  if (!Number.isFinite(dur) || dur < 2000) {
    throw new Error('DEMO_MARKET_MS must be >= 2000');
  }
  config.MARKET_DURATION_MS = dur;
  // Keep the expiry cash-out comfortably inside the shrunken window.
  config.EXIT_BUFFER_MS = Math.max(500, Math.round(dur * 0.2));
  // Shrink lookbacks so the momentum buffer fills after a window or two.
  config.MOMENTUM_LOOKBACK_MS = Math.min(config.MOMENTUM_LOOKBACK_MS, Math.round(dur * 0.5));
  // MOMENTUM_THRESHOLD is a fractional return; keep it loose for the demo.
  config.MOMENTUM_THRESHOLD = Math.max(0.0005, config.MOMENTUM_THRESHOLD * 0.5);
  return config;
}

async function main() {
  const config = overrideForDemo(loadConfig());
  const feed = getMarketFeed(config);
  const engine = new PaperEngine(config, feed);

  const MIN_WINDOWS = Number(process.env.DEMO_MIN_WINDOWS || 8);
  const TIME_BUDGET_MS = Number(process.env.DEMO_TIME_BUDGET_MS || 90000);

  const stats = { opened: 0, closed: { take_profit: 0, stop_loss: 0, expiry: 0, reset: 0 }, skipped: new Map() };
  const mathBad = 0;

  engine.on('windowSkipped', ({ reason, detail }) => {
    stats.skipped.set(reason, (stats.skipped.get(reason) || 0) + 1);
    console.log(`[skip] ${reason}: ${detail}`);
  });

  engine.on('tradeOpened', (t) => {
    stats.opened += 1;
    console.log(
      `[OPEN ] ${t.marketId} ${t.direction} entry=${t.entryPrice} ` +
        `mult=${t.trueMultiplier}x stake=$${t.stake.toFixed(2)} tokens=${t.tokensBought}`
    );
  });

  engine.on('tradeClosed', (t) => {
    stats.closed[t.reason] = (stats.closed[t.reason] || 0) + 1;
    const expected = rm(t.tokensBought * t.exitPrice - t.stake);
    const label = expected === t.pnl ? '' : `  MATH MISMATCH expected=${expected}`;
    console.log(
      `[CLOSE] ${t.marketId} ${t.direction} ${t.reason} exit=${t.exitPrice} ` +
        `pnl=${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)} balance=$${t.balance.toFixed(2)} ` +
        `dur=${t.durationMs}ms${label}`
    );
    if (expected !== t.pnl) mathBad += 1;
  });

  function rm(x) {
    return Math.round(x * 100) / 100;
  }

  feed.on('tick', () => {});
  engine.on('reset', (s) => console.log(`[RESET] balance=$${s.balance.toFixed(2)}`));

  feed.start();
  engine.start();

  const startedAt = Date.now();
  const nextWindowStarts = [];
  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const status = engine.getStatus();
    const seenWindows = status.totalTrades + stats.skipped.size;
    if (seenWindows >= MIN_WINDOWS || stats.opened >= MIN_WINDOWS) break;
    nextWindowStarts.push(status.nextWindowStart);
    await sleep(200);
  }

  const status = engine.getStatus();
  const totalStarts = status.totalTrades + sum(stats.skipped.values());
  const windowCount = totalStarts + (engine.position ? 1 : 0);

  engine.stop();
  feed.stop();

  console.log('\n--- engine demo summary ---');
  console.log(`market duration : ${config.MARKET_DURATION_MS}ms`);
  console.log(`windows opened  : ${windowCount}`);
  console.log(`trades opened   : ${stats.opened}`);
  console.log(`open position   : ${engine.position ? JSON.stringify(engine.position) : 'none'}`);
  console.log('closures        :', JSON.stringify(stats.closed));
  console.log('skips           :', JSON.stringify(Object.fromEntries(stats.skipped)));
  console.log(`final balance   : $${status.balance.toFixed(2)}`);
  console.log(`win rate        : ${status.winRate}% (${status.wins}W/${status.losses}L)`);
  console.log(`pnl math errors : ${mathBad}`);

  const ok =
    mathBad === 0 &&
    status.balance >= 0 &&
    dbCheck(status.balance, config.INITIAL_BALANCE + totalPnl(engine));
  console.log(`validation      : ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);

  function sum(iter) {
    let n = 0;
    for (const v of iter) n += v;
    return n;
  }

  function totalPnl(e) {
    return e.history.reduce((s, t) => s + t.pnl, 0);
  }

  function dbCheck() {
    return Math.round((status.balance - (config.INITIAL_BALANCE + totalPnl(engine))) * 100) / 100 === 0;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('demo:engine failed:', err.message);
  process.exit(1);
});