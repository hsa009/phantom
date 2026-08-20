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
  constructor(config, feed) {
    super();
    this.config = config;
    this.feed = feed;

    this.balance = rm(config.INITIAL_BALANCE);
    this.position = null;
    this.history = [];

    this._buffer = [];
    this._windowTimer = null;
    this._checkTimer = null;
    this._nextWindowStart = 0;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;

    this.feed.on('tick', (quote) => this._onTick(quote));
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

  /* ---- window scheduling --------------------------------------------- */

  _nextBoundary(now) {
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

    const quote = this._latestQuote();
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

    this.position = {
      id: randomUUID(),
      marketId: quote.marketId,
      direction,
      entryPrice: rp(entryPrice),
      trueMultiplier,
      stake: rm(stake),
      tokensBought,
      openedAt,
      windowEnd: this._nextWindowStart + c.MARKET_DURATION_MS,
    };

    this.emit('tradeOpened', { ...this.position });
  }

  _heldExitPrice(quote) {
    // We exit at the live bid of the side we hold.
    return this.position.direction === 'UP' ? quote.yesBid : quote.noBid;
  }

  _checkExit() {
    if (!this.position || !this._latestQuote()) return;
    const c = this.config;
    const quote = this._latestQuote();
    const now = Date.now();

    const exitPrice = rp(this._heldExitPrice(quote));
    const exitValue = this.position.tokensBought * exitPrice;
    const pnl = rm(exitValue - this.position.stake);

    let reason = null;
    if (pnl >= c.TAKE_PROFIT) reason = 'take_profit';
    else if (pnl <= -c.STOP_LOSS) reason = 'stop_loss';
    else if (now >= this.position.windowEnd - c.EXIT_BUFFER_MS) reason = 'expiry';

    if (reason) this._closeTrade(exitPrice, pnl, reason, now);
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
      balance: this.balance,
      totalTrades: total,
      wins,
      losses,
      winRate,
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
    this.emit('reset', { balance: this.balance });
  }
}

module.exports = { PaperEngine };