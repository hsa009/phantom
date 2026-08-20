'use strict';

const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');

/* ------------------------------------------------------------------ *
 * PaperEngine — paper-trading execution engine.
 *
 * Listens to a MarketFeed (lib/solana.js), opens exactly one $STAKE
 * position per 5-minute market window (direcion from a basic momentum
 * signal), and manages exits on take-profit / stop-loss / expiry.
 *
 * The engine is deliberately strategy-swappable: it only consumes
 * feed events + quotes, and only emits events. Persistence (Supabase),
 * alerts (Telegram) and streaming (WebSocket) subscribe to its events
 * in later phases.
 *
 * Events:
 *   tradeOpened   { id, marketId, direction, entryPrice, trueMultiplier,
 *                   stake, tokensBought, openedAt, windowEnd }
 *   tradeClosed   { id, marketId, direction, entryPrice, exitPrice,
 *                   tokensBought, stake, pnl, balance, reason,
 *                   openedAt, closedAt, durationMs }
 *   windowSkipped { windowStart, reason, detail }
 *   reset         { balance }
 * ------------------------------------------------------------------ */

const ROUND_PRICE = 4;
const ROUND_MONEY = 2;

function rp(x) {
  const f = 10 ** ROUND_PRICE;
  return Math.round(x * f) / f;
}

function rm(x) {
  const f = 10 ** ROUND_MONEY;
  return Math.round(x * f) / f;
}

class PaperEngine extends EventEmitter {
  constructor(config, feed, handlers = {}) {
    super();
    this.config = config;
    this.feed = feed;

    this.balance = rm(config.INITIAL_BALANCE);
    this.position = null;
    this.history = [];

    // Risk controls (TP/SL) — live-editable from the dashboard. The engine
    // re-reads them at every window start and every exit check, so UI edits
    // apply immediately without a restart.
    this.risk = {
      tpEnabled: config.TP_ENABLED,
      tpValue: config.TP_VALUE,
      slEnabled: config.SL_ENABLED,
      slValue: config.SL_VALUE,
    };
    this._refreshRisk = handlers.refreshRisk || null;
    this._riskRefreshedAt = 0;

    this._buffer = [];
    this._windowTimer = null;
    this._checkTimer = null;
    this._nextWindowStart = 0;
    this._running = false;
    this._startedAt = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._startedAt = Date.now();
    this._refreshRiskState();

    this.feed.on('tick', (quote) => this._onTick(quote));
    if (typeof this.feed.marketRoller === 'function') {
      // Adapters that roll contracts themselves (Kalshi) drive scheduling.
      this.feed.on('market', (m) => this._onMarketRoll(m));
    }
    this._scheduleNextWindow();

    this._checkTimer = setInterval(
      () => this._checkExit(),
      this.config.CHECK_INTERVAL_MS
    );
    if (this._checkTimer.unref) this._checkTimer.unref();
  }

  stop() {
    this._running = false;
    if (this._windowTimer) clearTimeout(this._windowTimer);
    if (this._checkTimer) clearInterval(this._checkTimer);
    this._windowTimer = null;
    this._checkTimer = null;
  }

  /* ---- feed handling ------------------------------------------------- */

  _onTick(quote) {
    const now = quote.timestamp;
    // Signal price: underlying asset price (BTC) when available, else the
    // normalized YES/NO mid as a fallback for legacy feeds.
    const price = quote.price != null ? quote.price : quote.mid;
    this._buffer.push({ price, ts: now });

    const pruneBefore = now - this.config.MOMENTUM_LOOKBACK_MS * 2 - 5000;
    let i = 0;
    while (i < this._buffer.length && this._buffer[i].ts < pruneBefore) i += 1;
    if (i > 0) this._buffer.splice(0, i);
  }

  _latestQuote() {
    return this.feed.getQuote() || null;
  }

  /* ---- risk config --------------------------------------------------- */

  setRisk(risk) {
    if (risk && typeof risk === 'object') {
      this.risk = {
        tpEnabled: risk.tpEnabled !== undefined ? Boolean(risk.tpEnabled) : this.risk.tpEnabled,
        tpValue: risk.tpValue !== undefined ? Number(risk.tpValue) : this.risk.tpValue,
        slEnabled: risk.slEnabled !== undefined ? Boolean(risk.slEnabled) : this.risk.slEnabled,
        slValue: risk.slValue !== undefined ? Number(risk.slValue) : this.risk.slValue,
      };
    }
  }

  async _refreshRiskState() {
    if (typeof this._refreshRisk !== 'function') return;
    try {
      const risk = await this._refreshRisk();
      if (risk) this.setRisk(risk);
    } catch (err) {
      console.error('[engine] risk refresh failed:', err.message);
    }
  }

  /* ---- window scheduling --------------------------------------------- */

  _feedRollsOwnWindows() {
    return typeof this.feed.marketRoller === 'function' && this.feed.marketRoller();
  }

  _onMarketRoll(m) {
    // A new Kalshi 15-min window began; re-anchor scheduling to its close.
    if (!m || !m.marketId || !m.closeTime) return;
    this._nextWindowStart = m.closeTime;
    this._scheduleNextWindow();
  }

  _nextBoundary(now) {
    if (this._feedRollsOwnWindows()) {
      const info = this.feed.getMarketInfo();
      if (info && info.closeTime) return info.closeTime;
      return now + this.config.MARKET_DURATION_MS;
    }
    return (
      Math.ceil(now / this.config.MARKET_DURATION_MS) *
      this.config.MARKET_DURATION_MS
    );
  }

  _scheduleNextWindow() {
    const now = Date.now();
    this._nextWindowStart = this._nextBoundary(now);
    const delay = Math.max(1, this._nextWindowStart - now);

    if (this._windowTimer) clearTimeout(this._windowTimer);
    this._windowTimer = setTimeout(() => this._onWindowStart(), delay);
    if (this._windowTimer.unref) this._windowTimer.unref();
  }

  _onWindowStart() {
    if (this.position) {
      this._scheduleNextWindow();
      return;
    }

    this._refreshRiskState();

    const quote = this._latestQuote();
    if (this._feedRollsOwnWindows()) {
      // Kalshi: only open when a live window is on offer; otherwise skip.
      const info = this.feed.getMarketInfo();
      if (!this.validQuoteForOpen(quote) || !info) {
        this.emit('windowSkipped', {
          windowStart: this._nextWindowStart,
          reason: 'no_live_window',
          detail: 'no active Kalshi contract',
        });
        this._scheduleNextWindow();
        return;
      }
    }

    const decision = this._decideDirection(quote);

    if (!decision.canOpen) {
      this.emit('windowSkipped', {
        windowStart: this._nextWindowStart,
        reason: decision.reason,
        detail: decision.detail,
      });
    } else {
      this._openTrade(decision.direction, quote);
    }

    this._scheduleNextWindow();
  }

  validQuoteForOpen(quote) {
    if (!quote) return false;
    if (quote.yesBid == null || quote.yesAsk == null) return false;
    if (!(quote.yesBid > 0) || !(quote.yesAsk > 0)) return false;
    return true;
  }

  /* ---- momentum signal (basic; swappable later) ---------------------- */

  _decideDirection(quote) {
    const c = this.config;
    if (!quote) {
      return { canOpen: false, reason: 'no_quote', detail: 'feed has no quote yet' };
    }

    const spread = quote.yesAsk - quote.yesBid;
    if (spread > c.MAX_SPREAD) {
      return { canOpen: false, reason: 'wide_spread', detail: `spread=${spread.toFixed(4)}` };
    }

    const now = Date.now();
    const lookback = c.MOMENTUM_LOOKBACK_MS;

    // Recent = last `lookback` ms (e.g. 60s) of price action; previous =
    // the `lookback` ms slice directly before it.
    const recent = this._buffer.filter((s) => now - s.ts <= lookback);
    const previous = this._buffer.filter(
      (s) => now - s.ts > lookback && now - s.ts <= lookback * 2
    );

    if (recent.length === 0 || previous.length === 0) {
      return {
        canOpen: false,
        reason: 'insufficient_data',
        detail: `buffer span=${(now - (this._buffer[0]?.ts || now))}ms need>${lookback * 2}ms`,
      };
    }

    const avg = (arr) => arr.reduce((s, x) => s + x.price, 0) / arr.length;
    const recentAvg = avg(recent);
    const previousAvg = avg(previous);
    if (previousAvg <= 0) {
      return { canOpen: false, reason: 'bad_signal', detail: `previousAvg=${previousAvg}` };
    }
    const momentum = (recentAvg - previousAvg) / previousAvg;

    if (Math.abs(momentum) < c.MOMENTUM_THRESHOLD) {
      return {
        canOpen: false,
        reason: 'flat_momentum',
        detail: `momentum=${momentum.toFixed(6)} threshold=${c.MOMENTUM_THRESHOLD} ` +
          `recent=${recentAvg} prev=${previousAvg}`,
      };
    }

    return {
      canOpen: true,
      direction: momentum > 0 ? 'UP' : 'DOWN',
      detail: `momentum=${momentum.toFixed(6)} recent=${recentAvg} prev=${previousAvg}`,
    };
  }

  /* ---- trade execution ----------------------------------------------- */

  _openTrade(direction, quote) {
    const c = this.config;
    const openedAt = Date.now();

    // Buy the outcome token at the current ask of the chosen side.
    const entryPrice = direction === 'UP' ? quote.yesAsk : quote.noAsk;
    const stake = c.STAKE_AMOUNT;
    const tokensBought = rp(stake / entryPrice);
    const trueMultiplier = rp(stake / entryPrice); // payout $1.00 / execution price

    let windowEnd = this._nextWindowStart + c.MARKET_DURATION_MS;
    if (this._feedRollsOwnWindows()) {
      const info = this.feed.getMarketInfo();
      if (info && info.closeTime) windowEnd = info.closeTime;
    } else if (quote.windowEnd) {
      windowEnd = quote.windowEnd;
    }

    const spotNow = quote.price != null ? quote.price : null;
    this.position = {
      id: randomUUID(),
      marketId: quote.marketId,
      direction,
      entryPrice: rp(entryPrice),
      trueMultiplier,
      stake: rm(stake),
      tokensBought,
      openedAt,
      windowEnd,
      windowStrike: spotNow,
      spent: rm(stake),
    };

    this.emit('tradeOpened', { ...this.position });
  }

  _heldExitPrice(quote) {
    // We exit at the live bid of the side we hold.
    return this.position.direction === 'UP' ? quote.yesBid : quote.noBid;
  }

  /**
   * Natural settlement value for the Kalshi window at expiry (paper-fill).
   * YES (UP) pays 1.0 when the spot at close >= the window-open strike, else
   * 0.0; NO (DOWN) is the mirror image. Falls back to the live bid when a
   * spot strike is unavailable.
   */
  _settlementValue(quote) {
    const pos = this.position;
    if (typeof this.feed.settleValue === 'function') {
      return this.feed.settleValue(
        pos.direction,
        quote && quote.price != null ? quote.price : null
      );
    }
    // Legacy/sim adapters: exit into the held bid at expiry.
    return this._heldExitPrice(quote);
  }

  _checkExit() {
    if (!this.position) return;
    const quote = this._latestQuote();
    if (!quote) return;
    const c = this.config;
    const now = Date.now();

    // Live-read the dashboard TP/SL state before every evaluation.
    this._refreshRiskState();

    const exitPrice = rp(this._heldExitPrice(quote));
    const exitValue = this.position.tokensBought * exitPrice;
    const pnl = rm(exitValue - this.position.stake);

    const expired = now >= this.position.windowEnd - c.EXIT_BUFFER_MS;
    let reason = null;
    let closePrice = exitPrice;

    if (expired) {
      // Natural 15-min settlement — payout is the binary result, not the bid.
      const settle = rp(this._settlementValue(quote));
      closePrice = settle;
      const settledPnl = rm(this.position.tokensBought * settle - this.position.stake);
      reason = 'expiry';
      this._closeTrade(closePrice, settledPnl, reason, now);
      return;
    }

    const risk = this.risk || c;
    if (risk.tpEnabled && pnl >= risk.tpValue) reason = 'tp_exit';
    else if (risk.slEnabled && pnl <= risk.slValue) reason = 'sl_exit';

    if (reason) this._closeTrade(closePrice, pnl, reason, now);
  }

  _closeTrade(exitPrice, pnl, reason, closedAt = Date.now()) {
    const pos = this.position;
    this.balance = rm(this.balance + pnl);

    const closed = {
      id: pos.id,
      marketId: pos.marketId,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice,
      tokensBought: pos.tokensBought,
      stake: pos.stake,
      pnl,
      balance: this.balance,
      reason,
      openedAt: pos.openedAt,
      closedAt,
      durationMs: closedAt - pos.openedAt,
    };

    this.position = null;
    this.history.push(closed);
    if (this.history.length > 500) this.history.shift();

    this.emit('tradeClosed', closed);
  }

  /* ---- read-only + control surface ---------------------------------- */

  getStatus() {
    const wins = this.history.filter((t) => t.pnl > 0).length;
    const losses = this.history.filter((t) => t.pnl < 0).length;
    const total = this.history.length;
    const winRate = total ? Math.round((wins / total) * 10000) / 100 : 0;

    return {
      mode: this.feed.feedMode || 'unknown',
      feedSource: this.feed.source || 'unknown',
      balance: this.balance,
      totalTrades: total,
      wins,
      losses,
      winRate,
      risk: { ...this.risk },
      openPosition: this.position
        ? { ...this.position }
        : null,
      nextWindowStart: this._nextWindowStart,
      bufferSamples: this._buffer.length,
      updatedAt: Date.now(),
    };
  }

  getTrades(limit = 20) {
    return this.history.slice(-limit);
  }

  reset() {
    if (this.position) {
      // Force-close the open position at breakeven (paper reset).
      this._closeTrade(this.position.entryPrice, 0, 'reset');
    }
    this.balance = rm(this.config.INITIAL_BALANCE);
    this.history = [];
    this._buffer = [];
    this.risk = {
      tpEnabled: this.config.TP_ENABLED,
      tpValue: this.config.TP_VALUE,
      slEnabled: this.config.SL_ENABLED,
      slValue: this.config.SL_VALUE,
    };
    this.emit('reset', { balance: this.balance });
  }
}

module.exports = { PaperEngine };