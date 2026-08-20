'use strict';

require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');

const { loadConfig } = require('./lib/config');
const { getMarketFeed, KalshiFeed } = require('./lib/solana');
const { PaperEngine } = require('./lib/engine');
const { getStore } = require('./lib/supabase');
const { TelegramBot } = require('./lib/telegram');
const { attachWebSocketServer } = require('./lib/websocket');
const { PriceBtc } = require('./lib/btc-price');

function composeState(feed, engine, store, startedAt, wss) {
  return {
    mode: feed.feedMode,
    feedSource: feed.source || 'unknown',
    balance: engine.balance,
    risk: engine.risk,
    status: engine.getStatus(),
    quote: feed.getQuote(),
    marketInfo: typeof feed.getMarketInfo === 'function' ? feed.getMarketInfo() : null,
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
  const engine = new PaperEngine(config, feed, {
    refreshRisk: async () =>
      store.getRiskConfig().catch((err) => {
        console.error('[index] risk refresh failed:', err.message);
        return null;
      }),
  });

  // 2b) BTC spot price source + attach to Kalshi-mode feed
  const priceBtc = new PriceBtc(config);
  if (feed instanceof KalshiFeed) {
    feed._attachPriceBtc(priceBtc);
    feed.marketRoller = () => true;
  }
  priceBtc.start();

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
      risk: engine.risk,
      wsClients: wss ? wss.clients.size : 0,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: Date.now(),
    });
  });

  // Feed/mode diagnostics — one curl to see exactly what feed is live.
  app.get('/api/mode', (req, res) => {
    res.json({
      marketMode: config.MARKET_MODE,
      feedMode: feed.feedMode,
      feedSource: feed.source || 'unknown',
      feedClass: feed.constructor.name,
      marketInfo: typeof feed.getMarketInfo === 'function' ? feed.getMarketInfo() : null,
      storeMode: store.mode,
    });
  });

  // TP/SL risk controls — read/write surface for the dashboard.
  app.get('/api/risk', (req, res) => {
    res.json({ ok: true, risk: engine.risk });
  });

  app.post('/api/risk', express.json(), async (req, res) => {
    const body = req.body || {};
    if (config.API_KEY && req.get('x-api-key') !== config.API_KEY) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    const merged = {
      tpEnabled: body.tpEnabled !== undefined ? Boolean(body.tpEnabled) : engine.risk.tpEnabled,
      tpValue: body.tpValue !== undefined ? Number(body.tpValue) : engine.risk.tpValue,
      slEnabled: body.slEnabled !== undefined ? Boolean(body.slEnabled) : engine.risk.slEnabled,
      slValue: body.slValue !== undefined ? Number(body.slValue) : engine.risk.slValue,
    };
    engine.setRisk(merged);
    try {
      const persisted = await store.setRiskConfig(merged);
      if (persisted) engine.setRisk(persisted);
      console.log(
        `[index] risk updated: TP ${merged.tpEnabled ? 'ON' : 'off'} $${merged.tpValue}, ` +
          `SL ${merged.slEnabled ? 'ON' : 'off'} $${merged.slValue}`
      );
      res.json({ ok: true, risk: engine.risk, persisted: Boolean(persisted) });
    } catch (err) {
      console.error('[index] setRiskConfig failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Fresh-start: reset the virtual bankroll, clear the ledger, return risk to defaults.
  app.post('/api/reset', async (req, res) => {
    if (config.API_KEY && req.get('x-api-key') !== config.API_KEY) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    try {
      await store.clearTrades();
      const defaults = {
        tpEnabled: config.TP_ENABLED,
        tpValue: config.TP_VALUE,
        slEnabled: config.SL_ENABLED,
        slValue: config.SL_VALUE,
      };
      engine.setRisk(defaults);
      await store.setRiskConfig(defaults).catch(() => null);
      engine.reset();
      console.log('[index] bankroll reset to $18.00 and ledger cleared — fresh start.');
      res.json({ ok: true, balance: engine.balance });
    } catch (err) {
      console.error('[index] /api/reset failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
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
    priceBtc.stop();
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