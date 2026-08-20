'use strict';

/* ------------------------------------------------------------------ *
 * PriceBtc — live BTC spot price source (public Coinbase ticker).
 *
 * Polls Coinbase's public spot endpoint and exposes the latest BTC-USD
 * price. Used by the dashboard BTC row, the engine momentum signal, and
 * the Kalshi feed's price channel. No API key required.
 * ------------------------------------------------------------------ */

const COINBASE_API = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';

class PriceBtc {
  constructor(config) {
    this.config = config;
    this._price = null;
    this._timer = null;
    this._errorAt = 0;
  }

  start() {
    if (this._timer) return;
    const poll = () => this._fetch().catch(() => this._backoff());
    poll();
    this._timer = setInterval(poll, this.config.BTC_SPOT_POLL_MS || 1000);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getPrice() {
    return this._price;
  }

  async _fetch() {
    const res = await fetch(COINBASE_API, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`coinbase spot ${res.status}`);
    const body = await res.json();
    const price = Number(body && body.data && body.data.amount);
    if (price > 0) {
      this._price = price;
      this._errorAt = 0;
    }
  }

  _backoff() {
    const now = Date.now();
    if (now - this._errorAt > 15000) {
      console.warn('[btc-price] Coinbase spot unavailable — using last known price.');
      this._errorAt = now;
    }
  }
}

module.exports = { PriceBtc, COINBASE_API };