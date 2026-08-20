'use strict';

const { EventEmitter } = require('events');
const { Connection, Keypair } = require('@solana/web3.js');
const {
  DriftClient,
  Wallet,
  ContractType,
  PRICE_PRECISION,
  convertToNumber,
} = require('@drift-labs/sdk');

const {
  MIN_PRICE,
  MAX_PRICE,
  clamp,
  round,
  turnRpcUrlIntoWs,
  normalizeQuote,
} = require('./feed-util');

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;

function isPredictionMarket(market) {
  return Boolean(market.contractType && market.contractType.prediction !== undefined);
}

function isPerpetualMarket(market) {
  return Boolean(market.contractType && market.contractType.perpetual !== undefined);
}

function marketName(market) {
  if (!market || !Array.isArray(market.name)) return '';
  const bytes = Buffer.from(market.name);
  return bytes.toString('utf8').replace(/\0/g, '').trim();
}

function marketStatus(market) {
  if (!market || !market.status) return 'unknown';
  if (market.status.initialized !== undefined) return 'initialized';
  if (market.status.active !== undefined) return 'active';
  if (market.status.paused !== undefined) return 'paused';
  return JSON.stringify(market.status);
}

/* ------------------------------------------------------------------ *
 * DriftFeed — live Drift B.E.T (Prediction) market oracle feed.
 *
 * Uses the @drift-labs/sdk DriftClient against a mainnet Helius RPC
 * WebSocket. The perp-market oracle IS the live YES probability (0..1)
 * for prediction markets, so each refresh reads that oracle and derives
 * a bid/ask pair around it using DRIFT_SPREAD_FALLBACK. The underlying
 * spot/perp oracle for TARGET_ASSET (e.g. BTC-PERP) is also read and
 * attached as `price`, so the engine's momentum runs on real BTC price
 * action.
 *
 * Market selection is filtered by TARGET_ASSET: only prediction markets
 * whose name contains the asset (case-insensitive) are considered, with
 * active markets preferred. If none is live the feed logs and stays idle,
 * re-scanning on DRIFT_MARKET_SCAN_MS — NO SIMULATED DATA, no trades —
 * until a matching B.E.T market lists.
 * ------------------------------------------------------------------ */
class DriftFeed extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.mode = 'real';
    this.source = 'drift';

    this._connection = new Connection(config.RPC_URL, {
      wsEndpoint: turnRpcUrlIntoWs(config.RPC_URL),
      confirmTransactionInitialTimeout: 30000,
    });

    // Read-only wallet: the bot never constructs real transactions, so the
    // private key is a throwaway keypair used only to satisfy the SDK.
    this._wallet = new Wallet(Keypair.generate());

    this._driftClient = new DriftClient({
      connection: this._connection,
      wallet: this._wallet,
      env: 'mainnet-beta',
      accountSubscription: { type: 'websocket', resubTimeoutMs: 30000 },
    });

    this._marketIndex = config.DRIFT_MARKET_INDEX ?? null;
    this._priceMarketIndex = null;
    this._lastQuote = null;
    this._pollTimer = null;
    this._rescanTimer = null;
    this._attached = false;
    this._subscribed = false;
    this._stopped = false;
    this._reconnectAttempts = 0;
    this._listener = () => this._refresh();
  }

  get sourceStatus() {
    if (this._marketIndex === null) return 'idle-waiting-market';
    return this._lastQuote ? 'live' : this._subscribed ? 'searching' : 'connecting';
  }

  async start() {
    if (this._stopped) return;
    try {
      console.log('[drift] connecting DriftClient over Helius RPC WebSocket...');
      await this._driftClient.subscribe();
      this._subscribed = true;
      this._reconnectAttempts = 0;

      const found = await this._selectMarket();
      if (!found) {
        console.log(
          `[drift] no "${this.config.TARGET_ASSET}" B.E.T market live — feed idle, ` +
            `re-scanning every ${this.config.DRIFT_MARKET_SCAN_MS}ms. No simulated data.`
        );
        return;
      }

      this._attachListeners();
      this._startPolling();
      this._refresh();
      console.log(`[drift] live feed started (marketIndex=${this._marketIndex})`);
    } catch (err) {
      console.error(`[drift] subscribe failed (${err.message}). No simulated data — retrying...`);
      this._scheduleReconnect();
    }
  }

  stop() {
    this._stopped = true;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._rescanTimer) {
      clearTimeout(this._rescanTimer);
      this._rescanTimer = null;
    }
    if (this._subscribed) {
      try {
        if (this._attached) {
          this._driftClient.eventEmitter.removeListener('marketAccountUpdate', this._listener);
          this._driftClient.eventEmitter.removeListener('perpMarketAccountUpdate', this._listener);
        }
        this._driftClient.unsubscribe();
      } catch {
        // best effort during shutdown
      }
      this._subscribed = false;
      this._attached = false;
    }
  }

  getQuote() {
    return this._lastQuote;
  }

  _attachListeners() {
    if (this._attached) return;
    this._driftClient.eventEmitter.on('marketAccountUpdate', this._listener);
    this._driftClient.eventEmitter.on('perpMarketAccountUpdate', this._listener);
    this._attached = true;
  }

  _startPolling() {
    if (this._pollTimer) return;
    // Safety poll: guarantee ticks flow even if no account-update events
    // arrive between market updates.
    this._pollTimer = setInterval(() => this._refresh(), this.config.FEED_INTERVAL_MS);
  }

  async _selectMarket() {
    const markets = this._driftClient.getPerpMarketAccounts();
    const predictionMarkets = markets.filter(isPredictionMarket);
    const asset = String(this.config.TARGET_ASSET || 'BTC').toUpperCase();

    console.log(
      `[drift] found ${markets.length} perp markets total, ` +
        `${predictionMarkets.length} prediction (B.E.T) markets (target=${asset})`
    );
    for (const m of predictionMarkets) {
      const match = marketName(m).toUpperCase().includes(asset);
      console.log(
        `[drift]   #${m.marketIndex} "${marketName(m)}" status=${marketStatus(m)} ` +
          `expiry=${m.expiryTs.toString()}${match ? '  <== TARGET' : ''}`
      );
    }

    // Explicitly pinned market index wins over asset filtering.
    if (this._marketIndex !== null) {
      const target = predictionMarkets.find((m) => m.marketIndex === this._marketIndex);
      if (!target) {
        throw new Error(
          `DRIFT_MARKET_INDEX=${this._marketIndex} is not a prediction market. ` +
            `Available: ${predictionMarkets.map((m) => m.marketIndex).join(', ') || 'none'}`
        );
      }
      this._priceMarketIndex = this._findPriceMarket(markets, asset);
      return true;
    }

    const matching = predictionMarkets.filter((m) =>
      marketName(m).toUpperCase().includes(asset)
    );
    const target = matching.find((m) => marketStatus(m) === 'active') || matching[0];

    if (!target) {
      this._marketIndex = null;
      this._priceMarketIndex = null;
      console.warn(
        `[drift] no "${asset}" B.E.T prediction market live. Idle until one lists.`
      );
      this._scheduleRescan();
      return false;
    }

    this._marketIndex = target.marketIndex;
    this._priceMarketIndex = this._findPriceMarket(markets, asset);
    console.log(`[drift] selected market #${this._marketIndex} "${marketName(target)}"`);
    return true;
  }

  _findPriceMarket(markets, asset) {
    const candidate = markets.find(
      (m) => isPerpetualMarket(m) && marketName(m).toUpperCase().includes(asset)
    );
    if (candidate) {
      console.log(
        `[drift] underlying price source: #${candidate.marketIndex} "${marketName(candidate)}"`
      );
      return candidate.marketIndex;
    }
    return null;
  }

  _refresh() {
    if (this._marketIndex === null || this._stopped) return;
    try {
      const oracle = this._driftClient.getOracleDataForPerpMarket(this._marketIndex);
      if (!oracle || !oracle.price) return;

      const mid = clamp(convertToNumber(oracle.price, PRICE_PRECISION), MIN_PRICE, MAX_PRICE);
      const spread = this.config.DRIFT_SPREAD_FALLBACK;
      const yesBid = clamp(round(mid - spread / 2), MIN_PRICE, MAX_PRICE);
      const yesAsk = clamp(round(mid + spread / 2), MIN_PRICE, MAX_PRICE);
      const finalBid = Math.min(yesBid, yesAsk - MIN_PRICE);
      const finalAsk = Math.max(yesAsk, finalBid + MIN_PRICE);

      let price;
      if (this._priceMarketIndex !== null) {
        const p = this._driftClient.getOracleDataForPerpMarket(this._priceMarketIndex);
        if (p && p.price) price = convertToNumber(p.price, PRICE_PRECISION);
      }

      this._lastQuote = normalizeQuote({
        marketId: `BET-${this._marketIndex}-${this.config.TARGET_ASSET}`,
        yesBid: finalBid,
        yesAsk: finalAsk,
        timestamp: Date.now(),
        mode: this.mode,
        simulated: false,
        asset: this.config.TARGET_ASSET,
        price,
      });
      this.emit('tick', this._lastQuote);
    } catch (err) {
      console.error(`[drift] quote refresh failed (${err.message}). Idle — no simulated data.`);
    }
  }

  _scheduleRescan() {
    if (this._stopped || this._rescanTimer) return;
    this._rescanTimer = setTimeout(async () => {
      this._rescanTimer = null;
      if (this._stopped) return;
      const found = await this._selectMarket().catch((err) => {
        console.error(`[drift] market rescan failed (${err.message})`);
        return false;
      });
      if (found) {
        this._attachListeners();
        this._startPolling();
        this._refresh();
        console.log(`[drift] live feed started (marketIndex=${this._marketIndex})`);
      } else {
        this._scheduleRescan();
      }
    }, this.config.DRIFT_MARKET_SCAN_MS);
    if (this._rescanTimer.unref) this._rescanTimer.unref();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    this._reconnectAttempts += 1;
    if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[drift] giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts. ` +
          `Idle until restart. No simulated data.`
      );
      return;
    }
    const delay = RECONNECT_DELAY_MS * this._reconnectAttempts;
    console.log(`[drift] reconnect attempt ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    setTimeout(() => {
      if (!this._stopped) this.start();
    }, delay).unref();
  }
}

module.exports = { DriftFeed };
