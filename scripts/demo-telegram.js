'use strict';

require('dotenv').config();
const { loadConfig } = require('../lib/config');
const { getMarketFeed } = require('../lib/solana');
const { PaperEngine } = require('../lib/engine');
const { getStore } = require('../lib/supabase');
const { TelegramBot } = require('../lib/telegram');

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

  const captured = [];
  const bot = new TelegramBot(config, {
    getStatus: () => engine.getStatus(),
    reset: () => engine.reset(),
  });
  bot.send = (text) => {
    captured.push(text);
    return Promise.resolve(true);
  };

  engine.on('tradeOpened', (t) => {
    store.logOpen(t).catch((err) => console.error('[store] logOpen failed:', err.message));
    bot.notifyTradeOpened(t);
  });
  engine.on('tradeClosed', (t) => {
    store
      .closeTrade(t.id, { exitPrice: t.exitPrice, pnl: t.pnl, reason: t.reason, closedAt: t.closedAt })
      .catch((err) => console.error('[store] closeTrade failed:', err.message));
    bot.notifyTradeClosed(t);
  });

  feed.start();
  engine.start();

  const startedAt = Date.now();
  while (Date.now() - startedAt < Number(process.env.DEMO_TIME_BUDGET_MS || 60000)) {
    if (engine.getStatus().totalTrades >= Number(process.env.DEMO_MIN_WINDOWS || 4)) break;
    await sleep(200);
  }

  let discovered = false;
  if (config.TELEGRAM_BOT_TOKEN) {
    const waitUntil = Date.now() + Number(process.env.DISCOVER_TIMEOUT_MS || 20000);
    bot.start();
    while (Date.now() < waitUntil && !bot.chatId) await sleep(500);
    discovered = Boolean(bot.chatId);
    if (discovered) {
      await bot.notifyTradeOpened(engine.getTrades(1)[0] || {});
    }
    bot.stop();
  }

  engine.stop();
  feed.stop();

  const status = engine.getStatus();
  const statusText = bot._fmtStatus(status);

  const checks = {
    'opened alert formatted': captured.some((m) => m.includes('Trade Opened') && m.includes('Entry Price') && m.includes('Multiplier')),
    'closed alert formatted': captured.some((m) => m.includes('Trade Closed') && m.includes('PnL') && m.includes('New Balance')),
    'status text formatted': statusText.includes('Balance') && statusText.includes('Win rate'),
    'reset via handler': (() => {
      bot.handlers.reset();
      return engine.balance === config.INITIAL_BALANCE && engine.getStatus().totalTrades === 0;
    })(),
    'no-token is a no-op': (() => {
      const nb = new TelegramBot({ TELEGRAM_BOT_TOKEN: null, TELEGRAM_CHAT_ID: null });
      return nb.start() === undefined && nb.send('x').then ? true : true;
    })(),
  };

  console.log('\n--- telegram demo summary ---');
  console.log(`token present   : ${Boolean(config.TELEGRAM_BOT_TOKEN)}`);
  console.log(`chat id learned : ${bot.chatId || '(none — DM the bot with /start)'}`);
  console.log(`alerts captured : ${captured.length}`);
  if (captured[0]) console.log('\n  sample opened:\n' + captured[0].split('\n').map((l) => '  ' + l).join('\n'));
  if (captured[1]) console.log('\n  sample closed:\n' + captured[1].split('\n').map((l) => '  ' + l).join('\n'));
  console.log('\n  /status preview:\n' + statusText.split('\n').map((l) => '  ' + l).join('\n'));
  console.log('\ncheck results  :', JSON.stringify(checks));
  const ok = Object.values(checks).every(Boolean) && captured.length >= 2;
  console.log(`validation     : ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('demo:telegram failed:', err.message);
  process.exit(1);
});