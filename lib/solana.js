'use strict';

const { EventEmitter } = require('events');
const { Connection } = require('@solana/web3.js');

/* ------------------------------------------------------------------ *
 * Market feed adapter layer.
 *
 * `getMarketFeed(config)` is a factory returning a `MarketFeed`
 * (EventEmitter) that always presents the same interface:
 *
 *   - start()
 *   - stop()
 *   - getQuote()
 *   - on('tick',  quote)
 *   - on('market', { marketId })
 *
 * Quote shape (the single normalization both adapters produce):
 *   { marketId, yesBid, yesAsk, noBid, noAsk, mid, timestamp,
 *     mode, simulated }
 * with  noBid = 1 - yesAsk  and  noAsk = 1 - yesBid.
 *
 * SIM  -> SimFeed    temporary in-process random-walk order book used to
 *                    verify the Supabase / Telegram / WebSocket plumbing.
 * REAL -> HeliusFeed swap-in adapter that subscribes to on-chain market
 *                    accounts over the Helius RPC WebSocket. Price decoding
 *                    is isolated in decodePrice() + yesPriceToTokens(),
 *                    the only market-specific seams to implement in Phase 8.
 *
 * HeliusFeed degrades to sim ticks instead of crashing when the RPC is
 * unreachable, accounts are missing, or decodePrice() is unimplemented, and
 * marks those quotes builder.simulated: true so downstream code cannot
 * mistake fallback data for live odds.
 * ------------------------------------------------------------------ */

const DEFAULT_SPREAD = 0.03;
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;
const RECONNECT_DELAY_MS = 5000;

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function round(x, dp = 4) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function turnRpcUrlIntoWs(url) {
  if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
  return url.replace(/^http/, 'ws');
}

function marketIdFor(config, now = Date.now()) {
  const windowStart =
    Math.floor(now / config.MARKET_DURATION_MS) * config.MARKET_DURATION_MS;
  const mins = Math.round(config.MARKET_DURATION_MS / 60000);
  return `SIM-${mins}MIN-${windowStart}`;
}

function normalizeQuote({ marketId, yesBid, yesAsk, timestamp, mode, simulated }) {
  const noAsk = round(1 - yesBid);
  const noBid = round(1 - yesAsk);
  return {
    marketId,
    yesBid: round(yesBid),
    yesAsk: round(yesAsk),
    noBid,
    noAsk,
    mid: round((yesBid + yesAsk) / 2),
    timestamp: timestamp || Date.now(),
    mode,
    simulated: Boolean(simulated),
  };
}

/* ------------------------------------------------------------------ *
 * SimFeed — temporary deterministic-ish random-walk order book.
 * ------------------------------------------------------------------ */
class SimFeed extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.mode = 'sim';
    this.source = 'sim';
    this._mid = 0.5;
    this._target = 0.5;
    this._lastQuote = null;
    this._timer = null;
    this._marketId = null;
  }

  start() {
    if (this._timer) return;
    // Emit a first quote immediately so callers never wait on the interval.
    this._step();
    this._timer = setInterval(() => this._step(), this.config.FEED_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getQuote() {
    if (!this._lastQuote) this._step();
    return this._lastQuote;
  }

  _step() {
    const c = this.config;
    const now = Date.now();

    // Momentum burst: occasionally push the mid toward a biased target so the
    // engine's momentum signal has real structure to read (not pure noise).
    if (Math.random() < c.SIMS_MOMENTUM_SHOCK_PROB) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const magnitude = 0.03 + Math.random() * 0.09;
      this._mid += dir * magnitude;
      this._target = clamp(this._mid + dir * 0.06, MIN_PRICE, MAX_PRICE);
    } else {
      this._target = 0.5;
    }

    // Mean-reverting process whose volatility shrinks near the price bounds.
    const volScale = clamp(Math.sqrt(this._mid * (1 - this._mid)) * 3.5, 0.02, 0.5);
    this._mid +=
      c.SIMS_KAPPA * (this._target - this._mid) +
      c.SIMS_SIGMA * volScale * gaussian();
    this._mid = clamp(this._mid, MIN_PRICE, MAX_PRICE);

    const spread =
      c.SIMS_SPREAD_MIN + Math.random() * (c.SIMS_SPREAD_MAX - c.SIMS_SPREAD_MIN);
    const yesAsk = clamp(this._mid + spread / 2, MIN_PRICE, MAX_PRICE);
    const yesBid = clamp(this._mid - spread / 2, MIN_PRICE, MAX_PRICE);

    const marketId = marketIdFor(c, now);
    if (this._marketId !== null && this._marketId !== marketId) {
      this._marketId = marketId;
      this.emit('market', { marketId, timestamp: now });
    }
    if (this._marketId === null) this._marketId = marketId;

    this._lastQuote = normalizeQuote({
      marketId,
      yesBid,
      yesAsk,
      timestamp: now,
      mode: this.mode,
      simulated: false,
    });
    this.emit('tick', this._lastQuote);
  }
}

/* ------------------------------------------------------------------ *
 * HeliusFeed — live on-chain order book subscriptions (Phase 8 seams).
 * ------------------------------------------------------------------ */
class HeliusFeed extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.mode = 'real';

    const wsEndpoint = turnRpcUrlIntoWs(config.RPC_URL);
    this._connection = new Connection(config.RPC_URL, {
      wsEndpoint,
      confirmTransactionInitialTimeout: 30000,
    });

    const hasAccounts =
      config.MARKET_PROGRAM_ID && config.MARKET_ACCOUNTS.length > 0;
    this.source = hasAccounts ? 'rpc' : 'sim-fallback';
    this._reconnectTimer = null;
    this._subIds = [];
    this._lastQuote = null;
    this._stubErrorLogged = false;

    this._fallback = hasAccounts ? null : new SimFeed(config);
  }

  start() {
    if (this._fallback) {
      console.warn(
        '[solana] HeliusFeed: MARKET_PROGRAM_ID/MARKET_ACCOUNTS not configured. ' +
          'Falling back to simulated ticks.'
      );
      this._adoptFallback();
      return;
    }
    this._subscribe();
  }

  stop() {
    for (const id of this._subIds) {
      try {
        this._connection.removeAccountChangeListener(id);
      } catch {
        // best effort
      }
    }
    this._subIds = [];
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._fallback) this._fallback.stop();
  }

  getQuote() {
    if (this._fallback) {
      const q = this._fallback.getQuote();
      return { ...q, mode: this.mode, simulated: true };
    }
    return this._lastQuote;
  }

  _adoptFallback() {
    this.source = 'sim-fallback';
    this._fallback.on('tick', (quote) => this._emitSimulated(quote));
    this._fallback.on('market', (m) => this.emit('market', m));
    this._fallback.start();
  }

  _emitSimulated(quote) {
    this._lastQuote = { ...quote, mode: this.mode, simulated: true };
    this.emit('tick', this._lastQuote);
  }

  _subscribe() {
    const c = this.config;
    try {
      for (const account of c.MARKET_ACCOUNTS) {
        const id = this._connection.onAccountChange(
          account,
          (accountInfo) => this._onAccountChange(account, accountInfo),
          'confirmed'
        );
        this._subIds.push(id);
      }
      this.source = 'rpc';
    } catch (err) {
      console.error('[solana] RPC subscription failed:', err.message);
      this._scheduleReconnect();
    }
  }

  _onAccountChange(account, accountInfo) {
    if (!accountInfo || !accountInfo.data) return;
    try {
      // Phase 8 seam #1: decode raw account bytes into a yes-price in [0,1].
      const rawYesPrice = this.decodePrice(accountInfo.data, account);
      const { yesBid, yesAsk } = this.yesPriceToTokens(rawYesPrice, account);
      this._lastQuote = normalizeQuote({
        marketId: `REAL-${account}`,
        yesBid,
        yesAsk,
        timestamp: Date.now(),
        mode: this.mode,
        simulated: false,
      });
      this.emit('tick', this._lastQuote);
    } catch (err) {
      if (!this._stubErrorLogged) {
        this._stubErrorLogged = true;
        console.error(
          '[solana] decodePrice() requires a market-specific implementation ' +
            '(Phase 8). Dropping to simulated ticks:',
          err.message
        );
      }
      this._adoptFallback();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._subscribe();
    }, RECONNECT_DELAY_MS);
  }

  /* ---- Phase 8 seams (the only market-specific code) ------------------ */

  // decodePrice(accountData: Buffer|{data}, marketId: string) -> number (0..1)
  decodePrice() {
    throw new Error('MARKET_LAYOUT_NOT_IMPLEMENTED');
  }

  // yesPriceToTokens(price, marketId) -> { yesBid, yesAsk }
  yesPriceToTokens(price, marketId) {
    const p = clamp(Number(price), MIN_PRICE, MAX_PRICE);
    return {
      yesBid: round(clamp(p - DEFAULT_SPREAD / 2, MIN_PRICE, MAX_PRICE)),
      yesAsk: round(clamp(p + DEFAULT_SPREAD / 2, MIN_PRICE, MAX_PRICE)),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */
function getMarketFeed(config) {
  const feed =
    config.MARKET_MODE === 'real' ? new HeliusFeed(config) : new SimFeed(config);
  feed.feedMode = config.MARKET_MODE;
  return feed;
}

module.exports = {
  getMarketFeed,
  SimFeed,
  HeliusFeed,
  clamp,
  round,
  turnRpcUrlIntoWs,
};