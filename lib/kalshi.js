'use strict';

const { EventEmitter } = require('events');

const { normalizeQuote, clamp, round } = require('./feed-util');

const DEFAULT_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;
const DAY_MS = 24 * 60 * 60 * 1000;

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function str(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function parseTickerCloseTime(ticker, reference = Date.now()) {
  if (!ticker) return null;
  const m = /-(\d{2})([A-Z]{3})(\d{4})(\d{2})(\d{2})-/.exec(ticker);
  if (!m) return null;
  const day = Number(m[1]);
  const monthAbbr = m[2];
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months.indexOf(monthAbbr);
  if (month === -1) return null;

  let year4 = year;
  const refYear = new Date(reference).getUTCFullYear();
  if (Math.abs(year4 - refYear) > 1) year4 = refYear;

  let close = Date.UTC(year4, month, day, hour, minute);
  const utcDay = (ts) => Math.floor(ts / DAY_MS);
  const utcTimeOfDay = (ts) => mathMod(ts, DAY_MS);

  const targetTod = utcTimeOfDay(close);
  if (Math.abs(close - reference) > 3 * DAY_MS || utcDay(close) !== utcDay(reference)) {
    const base = utcDay(reference) * DAY_MS;
    close = base + targetTod;
    if (close > reference) close -= DAY_MS;
    if (close < reference - DAY_MS / 2) close += DAY_MS;
    return close;
  }
  return close;
}

function mathMod(a, n) {
  return ((a % n) + n) % n;
}

class KalshiFeed extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.mode = 'real';
    this.source = 'kalshi';
    this.asset = 'BTC';
    this.ERROR_GUARD_MS = 60000;

    this.apiBase = (config.KALSHI_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '');
    this.seriesTicker = config.KALSHI_SERIES || 'KXBTC15M';
    this.pollMs = config.KALSHI_POLL_MS || 500;

    this.active = null;
    this._lastQuote = null;
    this._timer = null;
    this._priceSource = null;
    this._errorAt = 0;
    this._errorLoggedFor = null;
    this._inFlight = false;
  }

  _attachPriceBtc(priceBtc) {
    this._priceSource = priceBtc;
  }

  _nextBoundary() {
    return this.active ? this.active.closeTime : Date.now() + this.pollMs;
  }

  start() {
    if (this._timer) return;
    const poll = () => {
      if (this._inFlight) return;
      this._inFlight = true;
      this._poll()
        .catch(() => this._safeContinue())
        .finally(() => {
          this._inFlight = false;
        });
    };
    poll();
    this._timer = setInterval(poll, this.pollMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getQuote() {
    return this._lastQuote;
  }

  getMarketInfo() {
    if (!this.active) return null;
    return {
      marketId: this.active.marketId,
      ticker: this.active.marketId,
      closeTime: this.active.closeTime,
      expectedExpiration: this.active.expectedExpiration,
      market: this.active.market,
    };
  }

  
  settleValue(direction, priceSnapshot) {
    const price =
      priceSnapshot != null
        ? priceSnapshot
        : this._priceSource
          ? this._priceSource.getPrice()
          : null;
    if (price == null) return 0;
    const strike = this.active ? this.active.openPriceSnapshot : price;
    const up = direction === 'UP';
    const win = up ? price >= strike : price < strike;
    return win ? 1 : 0;
  }

  async _poll() {
    const c = this.config;
    const markets = await this._fetchMarkets();
    if (!Array.isArray(markets) || markets.length === 0) {
      if (this.active) this._clearActive();
      this._backoff('no markets returned');
      return;
    }

    const now = Date.now();
    let active = null;
    for (const m of markets) {
      const openTime = m.open_time ? new Date(m.open_time).getTime() : null;
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : null;
      const expectedExp = m.expected_expiration_time
        ? new Date(m.expected_expiration_time).getTime()
        : null;
      if (openTime == null || closeTime == null) continue;
      if (now >= openTime && now < closeTime) {
        active = { market: m, openTime, closeTime, expectedExpiration: expectedExp };
        break;
      }
    }

    if (!active) {
      let best = null;
      for (const m of markets) {
        if (m.status === 'closed' || m.result) continue;
        if (num(m.yes_bid_dollars) === 0 && num(m.yes_ask_dollars) === 0) continue;
        const closeTime = m.close_time ? new Date(m.close_time).getTime() : Infinity;
        if (closeTime < best) best = m;
      }
      if (best) {
        const closeTime = new Date(best.close_time).getTime();
        const expectedExp = best.expected_expiration_time
          ? new Date(best.expected_expiration_time).getTime()
          : null;
        active = { market: best, openTime: null, closeTime, expectedExpiration: expectedExp };
      }
    }

    if (!active) {
      if (this.active) this._clearActive();
      this._backoff('no active KXBTC15M window');
      return;
    }

    active.marketId = this._marketIdOf(active.market);

    const rolledOver =
      !this.active || this.active.marketId !== this._marketIdOf(active.market);

    if (rolledOver && this._priceSource) {
      active.openPriceSnapshot = this._priceSource.getPrice();
    } else if (this.active && this.active.openPriceSnapshot != null) {
      active.openPriceSnapshot = this.active.openPriceSnapshot;
    } else {
      active.openPriceSnapshot = null;
    }

    this.active = active;
    this._errorAt = 0;
    this._lastQuote = this._buildQuote(active);

    if (rolledOver) {
      this.emit('market', {
        marketId: active.marketId,
        closeTime: active.closeTime,
        expectedExpiration: active.expectedExpiration,
        ticker: active.marketId,
        timestamp: now,
      });
    }
    this.emit('tick', this._lastQuote);
  }

  _clearActive() {
    const old = this.active;
    this.active = null;
    this._lastQuote = null;
    if (old) {
      this.emit('market', {
        marketId: null,
        closeTime: null,
        timestamp: Date.now(),
      });
    }
  }

  _backoff(reason) {
    const now = Date.now();
    if (now - this._errorAt > this.ERROR_GUARD_MS) {
      if (this._errorLoggedFor !== reason) {
        console.warn(`[kalshi] ${reason} — staying idle (no simulated fallback).`);
        this._errorLoggedFor = reason;
      }
      this._errorAt = now;
    }
  }

  _safeContinue() {
  }

  _marketIdOf(market) {
    return market.ticker || market.market_ticker || market.market;
  }

  _buildQuote(active) {
    const m = active.market;
    const ticker = this._marketIdOf(m);
    const yesAsk = clamp(num(m.yes_ask_dollars), MIN_PRICE, MAX_PRICE);
    const yesBid = clamp(num(m.yes_bid_dollars), MIN_PRICE, MAX_PRICE);
    const price = this._priceSource ? this._priceSource.getPrice() : null;

    return normalizeQuote({
      marketId: ticker,
      yesBid,
      yesAsk,
      timestamp: Date.now(),
      mode: this.mode,
      simulated: false,
      asset: this.asset,
      price,
      windowEnd: active.closeTime,
      expectedExpiration: active.expectedExpiration,
    });
  }

  async _fetchMarkets() {
    const url = `${this.apiBase}/markets?series_ticker=${encodeURIComponent(
      this.seriesTicker
    )}&limit=200`;
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.config.KALSHI_FETCH_TIMEOUT || 8000),
    });
    if (!res.ok) {
      throw new Error(`kalshi markets ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    return Array.isArray(body.markets) ? body.markets : [];
  }
}

module.exports = { KalshiFeed, parseTickerCloseTime, DEFAULT_API_BASE };