'use strict';

const { EventEmitter } = require('events');
const { Connection } = require('@solana/web3.js');
const { DriftFeed } = require('./drift');
const { KalshiFeed } = require('./kalshi');

const {
  DEFAULT_SPREAD,
  MIN_PRICE,
  MAX_PRICE,
  clamp,
  round,
  turnRpcUrlIntoWs,
  normalizeQuote,
} = require('./feed-util');

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function marketIdFor(config, now = Date.now()) {
  const windowStart =
    Math.floor(now / config.MARKET_DURATION_MS) * config.MARKET_DURATION_MS;
  const mins = Math.round(config.MARKET_DURATION_MS / 60000);
  const asset = config.TARGET_ASSET || 'SIM';
  return `SIM-${asset}-${mins}MIN-${windowStart}`;
}

class SimFeed extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.mode = 'sim';
    this.source = 'sim';
    this.asset = config.TARGET_ASSET || 'BTC';
    this._price = config.SIMS_BTC_START_PRICE;
    this._windowOpenPrice = config.SIMS_BTC_START_PRICE;
    this._lastQuote = null;
    this._timer = null;
    this._marketId = null;
  }

  start() {
    if (this._timer) return;
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

  get price() {
    return this._price;
  }

  _step() {
    const c = this.config;
    const now = Date.now();

    if (Math.random() < c.SIMS_MOMENTUM_SHOCK_PROB) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const jump = 0.0005 + Math.random() * 0.0015;
      this._price *= 1 + dir * jump;
    }

    this._price *=
      1 + c.SIMS_BTC_DRIFT + c.SIMS_BTC_SIGMA * gaussian();
    this._price = Math.max(c.SIMS_BTC_START_PRICE * 0.5, this._price);

    const marketId = marketIdFor(c, now);
    if (this._marketId !== null && this._marketId !== marketId) {
      this._windowOpenPrice = this._price;
      this._marketId = marketId;
      this.emit('market', { marketId, timestamp: now });
    }
    if (this._marketId === null) this._marketId = marketId;

    const move = (this._price - this._windowOpenPrice) / this._windowOpenPrice;
    const prob = clamp(0.5 + 1.5 * move, MIN_PRICE, MAX_PRICE);

    const spread =
      c.SIMS_SPREAD_MIN + Math.random() * (c.SIMS_SPREAD_MAX - c.SIMS_SPREAD_MIN);
    const yesAsk = clamp(prob + spread / 2, MIN_PRICE, MAX_PRICE);
    const yesBid = clamp(prob - spread / 2, MIN_PRICE, MAX_PRICE);

    this._lastQuote = normalizeQuote({
      marketId,
      yesBid,
      yesAsk,
      timestamp: now,
      mode: this.mode,
      simulated: false,
      asset: this.asset,
      price: this._price,
    });
    this.emit('tick', this._lastQuote);
  }
}

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

  

  decodePrice() {
    throw new Error('MARKET_LAYOUT_NOT_IMPLEMENTED');
  }

  yesPriceToTokens(price, marketId) {
    const p = clamp(Number(price), MIN_PRICE, MAX_PRICE);
    return {
      yesBid: round(clamp(p - DEFAULT_SPREAD / 2, MIN_PRICE, MAX_PRICE)),
      yesAsk: round(clamp(p + DEFAULT_SPREAD / 2, MIN_PRICE, MAX_PRICE)),
    };
  }
}

function getMarketFeed(config) {
  const feed =
    config.MARKET_MODE === 'real'
      ? new DriftFeed(config)
      : config.MARKET_MODE === 'kalshi'
        ? new KalshiFeed(config)
        : new SimFeed(config);
  feed.feedMode = config.MARKET_MODE;
  return feed;
}

module.exports = {
  getMarketFeed,
  SimFeed,
  HeliusFeed,
  DriftFeed,
  KalshiFeed,
  clamp,
  round,
  turnRpcUrlIntoWs,
};