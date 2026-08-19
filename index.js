'use strict';

require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');

const { loadConfig } = require('./lib/config');
const { getMarketFeed } = require('./lib/solana');
const { PaperEngine } = require('./lib/engine');
const { getStore } = require('./lib/supabase');
const { TelegramBot } = require('./lib/telegram');
const { attachWebSocketServer } = require('./lib/websocket');

function composeState(feed, engine, store, startedAt, wss) {
  return {
    mode: feed.feedMode,
    feedSource: feed.source || 'unknown',
    balance: engine.balance,
    status: engine.getStatus(),
    quote: feed.getQuote(),
    recentTrades: engine.getTrades(15),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    wsClients: wss ? wss.clients.size : 0,
    storeMode: store.mode,
    timestamp: Date.now(),
  };
}

async function main() {
  const config = loadConfig();
  const startedAt = Date.now();

  // 1) Persistence first — settle any OPEN rows left by a previous run
  //    (e.g. Render restarted mid-trade).
  const store = getStore(config);
  try {
    await store.recoverOpenPositions();
  } catch (err) {
    console.error('[index] recovery failed:', err.message);
  }

  // 2) Feed + engine
  const feed = getMarketFeed(config);
  const engine = new PaperEngine(config, feed);

  // 3) Telegram (chat id auto-discovered from the first DM)
  const telegram = new TelegramBot(config, {
    getStatus: () => engine.getStatus(),
    reset: () => {
      engine.reset();
      store.recoverOpenPositions().catch((err) =>
        console.error('[index] post-reset recovery failed:', err.message)
      );
    },
  });

  // 4) Wire engine events -> persistence + alerts
  engine.on('tradeOpened', async (t) => {
    try {
      await store.logOpen(t);
    } catch (err) {
      console.error('[index] logOpen failed:', err.message);
    }
    telegram.notifyTradeOpened(t);
  });
  engine.on('tradeClosed', async (t) => {
    try {
      await store.closeTrade(t.id, {
        exitPrice: t.exitPrice,
        pnl: t.pnl,
        reason: t.reason,
        closedAt: t.closedAt,
      });
    } catch (err) {
      console.error('[index] closeTrade failed:', err.message);
    }
    telegram.notifyTradeClosed(t);
  });
  engine.on('windowSkipped', (w) =>
    console.log(`[engine] window skipped: ${w.reason}${w.detail ? ' — ' + w.detail : ''}`)
  );
  engine.on('reset', () => console.log('[index] engine reset'));

  // 5) Start market data + trading loop
  feed.start();
  engine.start();

  // 6) Express HTTP (health/keep-alive) + WebSocket streaming
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  let wss = null;
  app.get('/', (req, res) => {
    res.json({
      status: 'ok',
      mode: config.MARKET_MODE,
      balance: engine.balance,
      openPositions: engine.position ? 1 : 0,
      wsClients: wss ? wss.clients.size : 0,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: Date.now(),
    });
  });

  const server = http.createServer(app);
  wss = attachWebSocketServer(server, () => composeState(feed, engine, store, startedAt, wss));

  server.listen(config.PORT, () => {
    console.log(`[http] listening on :${config.PORT} (mode=${config.MARKET_MODE}, PORT=${config.PORT})`);
    console.log('[index] bot engine started');
  });

  // 7) Telegram commands (polling)
  telegram.start();

  // 8) Graceful shutdown for Render spins / redeploys
  const shutdown = (why) => {
    console.log(`[index] ${why} — shutting down cleanly...`);
    feed.stop();
    engine.stop();
    telegram.stop();
    try {
      wss.close();
    } catch {
      // already closed
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[index] fatal:', err);
  process.exit(1);
});