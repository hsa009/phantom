'use strict';

const API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT = 20;
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;
const FAILURES_BEFORE_HINT = 3;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(x) {
  return `$${Number(x).toFixed(2)}`;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function fmtDirection(d) {
  return d === 'UP' ? '⬆️ UP' : '⬇️ DOWN';
}

class TelegramBot {
  constructor(config, handlers = {}) {
    this.config = config;
    this.handlers = handlers;
    this.token = (config.TELEGRAM_BOT_TOKEN || '').trim();
    this.chatId = (config.TELEGRAM_CHAT_ID || '').trim() || null;
    this._offset = 0;
    this._pollTimer = null;
    this._running = false;
    this._discoveredChats = new Set();
    this._failures = 0;
  }

  start() {
    if (!this.token) {
      console.warn(
        '[telegram] TELEGRAM_BOT_TOKEN not set — alerts and commands disabled.'
      );
      return;
    }
    if (this.chatId) {
      console.log(`[telegram] alert chat set from env: ${this.chatId}`);
    }
    this._running = true;
    this._pollLoop();
  }

  stop() {
    this._running = false;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
  }

  

  async _api(method, body) {
    const res = await fetch(`${API}${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const description =
        json.description || res.statusText || `HTTP ${res.status}`;
      if (res.status === 404) {
        throw new Error(
          `invalid TELEGRAM_BOT_TOKEN (Telegram 404 for /${method}). ` +
            'Copy the full token from @BotFather — format 123456789:AAH..., no quotes or spaces.'
        );
      }
      throw new Error(`telegram ${method} failed (${res.status}): ${description}`);
    }
    return json.result;
  }

  

  _pollLoop() {
    if (!this._running) return;
    const body = {
      offset: this._offset,
      timeout: POLL_TIMEOUT,
      allowed_updates: ['message'],
    };
    this._api('getUpdates', body)
      .then((updates) => {
        this._failures = 0;
        if (Array.isArray(updates)) {
          for (const u of updates) {
            if (u.message) this._handleUpdate(u.message);
            this._offset = Math.max(this._offset, (u.update_id || 0) + 1);
          }
        }
        this._pollTimer = setTimeout(() => this._pollLoop(), 0);
      })
      .catch((err) => {
        this._failures += 1;
        if (this._failures <= FAILURES_BEFORE_HINT) {
          console.error(`[telegram] poll error: ${err.message}`);
        } else if (this._failures === FAILURES_BEFORE_HINT + 1) {
          console.error(
            `[telegram] poll keeps failing after ${this._failures} attempts — ` +
              'check TELEGRAM_BOT_TOKEN on Render. Retrying with backoff.'
          );
        }
        const delay = Math.min(
          RECONNECT_DELAY_MS * 2 ** Math.min(this._failures, 6),
          MAX_RECONNECT_DELAY_MS
        );
        this._pollTimer = setTimeout(() => this._pollLoop(), delay);
      });
  }

  

  _learnChatId(chat) {
    if (!chat || !chat.id) return;
    if (!this.config.TELEGRAM_CHAT_ID && !this._discoveredChats.has(chat.id)) {
      this._discoveredChats.add(chat.id);
      this.chatId = chat.id;
      console.log(`[telegram] chat auto-discovered: ${chat.id}`);
      this._send(
        '✅ Bot online. Alerts will be delivered here. Use /status or /reset.',
        { silent: true }
      ).catch(() => {});
    }
  }

  _handleUpdate(message) {
    this._learnChatId(message.chat);
    const text = (message.text || '').trim();
    if (!text.startsWith('/')) return;

    const [command] = text.split(/\s+/);
    const reply = (txt) =>
      this._send(txt).catch((err) =>
        console.error('[telegram] reply failed:', err.message)
      );

    switch (command) {
      case '/start':
        reply(
          '🤖 <b>Solana Prediction Paper-Trading Bot</b>\n\n' +
            'Commands:\n/status — balance, stats, open positions\n/reset — reset virtual bankroll to $18.00'
        );
        break;
      case '/status':
        if (typeof this.handlers.getStatus !== 'function') {
          reply('Status handler not wired yet.');
          break;
        }
        reply(this._fmtStatus(this.handlers.getStatus()));
        break;
      case '/reset':
        if (typeof this.handlers.reset !== 'function') {
          reply('Reset handler not wired yet.');
          break;
        }
        this.handlers.reset();
        reply('✅ Virtual bankroll reset to $18.00.');
        break;
      default:
        reply(`Unknown command ${command}. Try /status or /reset.`);
    }
  }

  

  async _send(text, opts = {}) {
    if (!this.token) return false;
    if (!this.chatId) {
      if (!opts.silent) {
        console.warn(
          '[telegram] no chat id known yet — DM the bot with /start to enable alerts.'
        );
      }
      return false;
    }
    await this._api('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return true;
  }

  send(text) {
    return this._send(text).catch((err) =>
      console.error('[telegram] send failed:', err.message)
    );
  }

  

  notifyTradeOpened(t) {
    const msg =
      `🚀 <b>Trade Opened</b>\n` +
      `Market: <code>${escapeHtml(t.marketId)}</code>\n` +
      `Direction: <b>${fmtDirection(t.direction)}</b>\n` +
      `Entry Price: ${fmtMoney(t.entryPrice)}\n` +
      `True Multiplier: <b>${t.trueMultiplier.toFixed(2)}x</b>\n` +
      `Stake: ${fmtMoney(t.stake)}`;
    return this.send(msg);
  }

  notifyTradeClosed(t) {
    const icon = t.pnl >= 0 ? '💰' : '💸';
    const sign = t.pnl >= 0 ? '+' : '';
    const reason = this._fmtReason(t.reason);
    const msg =
      `${icon} <b>Trade Closed</b>\n` +
      `Direction: ${fmtDirection(t.direction)}\n` +
      `Exit Price: ${fmtMoney(t.exitPrice)}\n` +
      `PnL: <b>${sign}${fmtMoney(t.pnl)}</b>\n` +
      `New Balance: <b>${fmtMoney(t.balance)}</b>\n` +
      `Duration: ${fmtDuration(t.durationMs)}\n` +
      `Exit: ${reason}`;
    return this.send(msg);
  }

  _fmtReason(reason) {
    switch (reason) {
      case 'tp_exit':
        return '🎯 take-profit — early cash-out at the live bid';
      case 'sl_exit':
        return '🛑 stop-loss — early cash-out at the live bid';
      case 'expiry':
        return '⏱ 15-min window closed — natural settlement';
      case 'reset':
        return '♻️ reset (position closed at breakeven)';
      case 'recovery':
        return '🔧 recovery — settled at breakeven after restart';
      default:
        return escapeHtml(reason || 'n/a');
    }
  }

  

  _fmtStatus(s) {
    const lines = [
      '📊 <b>Bot Status</b>',
      `Mode: <code>${escapeHtml(s.mode)}</code>`,
      `Balance: <b>${fmtMoney(s.balance)}</b>`,
      `Total trades: ${s.totalTrades}`,
      `Win rate: ${s.winRate}% (${s.wins}W / ${s.losses}L)`,
      `Open positions: ${s.openPosition ? 1 : 0}`,
    ];
    if (s.openPosition) {
      const p = s.openPosition;
      lines.push(
        `Open: ${fmtDirection(p.direction)} @ ${fmtMoney(p.entryPrice)}` +
          ` (mult ${p.trueMultiplier.toFixed(2)}x)`
      );
    }
    if (s.nextWindowStart) {
      lines.push(
        `Next window: ${new Date(s.nextWindowStart).toLocaleTimeString()}`
      );
    }
    return lines.join('\n');
  }
}

module.exports = { TelegramBot, escapeHtml, fmtMoney, fmtDuration };