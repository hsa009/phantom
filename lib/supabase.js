'use strict';

/* ------------------------------------------------------------------ *
 * Trade ledger persistence.
 *
 * getStore(config) returns a store behind one async interface:
 *
 *   mode                        'supabase' | 'mock'
 *   list(limit)                 -> rows (newest first)
 *   getOpenPositions()          -> OPEN rows
 *   logOpen(trade)              -> INSERT OPEN row (id from engine)
 *   closeTrade(id, result)      -> UPDATE row to CLOSED
 *   recoverOpenPositions()      -> settle sudden-OPEN rows after restart
 *   getStats()                  -> { totalTrades, wins, losses, winRate, openCount }
 *   getRiskConfig()             -> { tpEnabled, tpValue, slEnabled, slValue }
 *   setRiskConfig(risk)         -> persist TP/SL dashboard controls
 *
 * The Supabase client is used when SUPABASE_URL + SUPABASE_ANON_KEY are set
 * (e.g. added as secrets on Render). Otherwise a MockStore keeps the whole
 * pipeline runnable locally and logs a notice — the bot never crashes for a
 * missing credential, mirroring the feed's fallback philosophy.
 * ------------------------------------------------------------------ */

const { createClient } = require('@supabase/supabase-js');

const toRow = (t) => ({
  id: t.id,
  market_id: t.marketId,
  direction: t.direction,
  entry_price: t.entryPrice,
  true_multiplier: t.trueMultiplier,
  stake_amount: t.stake,
  tokens_bought: t.tokensBought,
  exit_price: t.exitPrice ?? null,
  pnl: t.pnl ?? null,
  status: t.exitPrice === undefined || t.exitPrice === null ? 'OPEN' : 'CLOSED',
  reason: t.reason ?? null,
  created_at: new Date(t.openedAt ?? Date.now()).toISOString(),
  closed_at: t.closedAt ? new Date(t.closedAt).toISOString() : null,
});

function rowsToStats(rows) {
  const wins = rows.filter((r) => (r.pnl ?? 0) > 0).length;
  const losses = rows.filter((r) => (r.pnl ?? 0) < 0).length;
  const total = rows.length;
  const openCount = rows.filter((r) => r.status === 'OPEN').length;
  return {
    totalTrades: total,
    wins,
    losses,
    winRate: total ? Math.round((wins / total) * 10000) / 100 : 0,
    openCount,
  };
}

/* ------------------------------------------------------------------ *
 * Real Supabase-backed store
 * ------------------------------------------------------------------ */
class SupabaseStore {
  constructor(config) {
    this.mode = 'supabase';
    this.config = config;
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
  }

  async list(limit = 50) {
    const { data, error } = await this.client
      .from('trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  async getOpenPositions() {
    const { data, error } = await this.client
      .from('trades')
      .select('*')
      .eq('status', 'OPEN')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async logOpen(trade) {
    const { error } = await this.client
      .from('trades')
      .insert(toRow(trade))
      .select('id');
    if (error) throw error;
  }

  async closeTrade(id, { exitPrice, pnl, reason, closedAt }) {
    const { error } = await this.client
      .from('trades')
      .update({
        exit_price: exitPrice,
        pnl,
        reason: reason || null,
        status: 'CLOSED',
        closed_at: new Date(closedAt ?? Date.now()).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw error;
  }

  async recoverOpenPositions() {
    const open = await this.getOpenPositions();
    if (open.length === 0) return [];

    if (this.config.MARKET_MODE === 'real') {
      // Phase 8: resume real positions at the live quote instead of settling.
      console.warn(
        `[supabase] ${open.length} OPEN trade(s) found in real mode — resuming is Phase 8 work.`
      );
      return open;
    }

    // Sim mode: settle stragglers so the ledger stays consistent after a
    // Render restart (the sim feed restarts, so there is no true state to resume).
    for (const row of open) {
      const { error } = await this.client
        .from('trades')
        .update({
          exit_price: row.entry_price,
          pnl: 0,
          reason: 'recovery',
          status: 'CLOSED',
          closed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (error) throw error;
    }
    console.warn(
      `[supabase] recovered ${open.length} OPEN trade(s) from a previous run (settled at breakeven).`
    );
    return open;
  }

  async getStats() {
    const { data, error } = await this.client.from('trades').select('*');
    if (error) throw error;
    return rowsToStats(data || []);
  }

  /** Delete every trade row (fresh-start / bankroll reset). */
  async clearTrades() {
    const { error } = await this.client.from('trades').delete().neq('id', '');
    if (error) throw error;
    return { cleared: true };
  }

  /* ---- TP/SL risk controls (bot_settings singleton row) -------------- */

  RISK_FALLBACK = {
    tpEnabled: false,
    tpValue: 0.5,
    slEnabled: false,
    slValue: -0.6,
  };

  _mapRiskRow(row) {
    if (!row) return null;
    return {
      tpEnabled: Boolean(row.tp_enabled),
      tpValue: Number(row.tp_value ?? this.RISK_FALLBACK.tpValue),
      slEnabled: Boolean(row.sl_enabled),
      slValue: Number(row.sl_value ?? this.RISK_FALLBACK.slValue),
    };
  }

  async getRiskConfig() {
    try {
      const { data, error } = await this.client
        .from('bot_settings')
        .select('*')
        .eq('id', 'default')
        .limit(1);
      if (error) {
        if (
          String(error.message || error.code || error).includes('relation') ||
          String(error.message || error.code || error)
            .toLowerCase()
            .includes('does not exist')
        ) {
          console.warn(
            '[supabase] bot_settings table missing — using engine defaults for TP/SL. ' +
              'Create it (id, tp_enabled, tp_value, sl_enabled, sl_value, updated_at) to enable dashboard risk controls.'
          );
          return null;
        }
        throw error;
      }
      return this._mapRiskRow(data && data.length > 0 ? data[0] : null);
    } catch (err) {
      console.error('[supabase] getRiskConfig failed:', err.message);
      return null;
    }
  }

  async setRiskConfig(risk) {
    if (!risk || typeof risk !== 'object') return null;
    const patch = {
      tp_enabled: risk.tpEnabled !== undefined ? Boolean(risk.tpEnabled) : undefined,
      tp_value: risk.tpValue !== undefined ? Number(risk.tpValue) : undefined,
      sl_enabled: risk.slEnabled !== undefined ? Boolean(risk.slEnabled) : undefined,
      sl_value: risk.slValue !== undefined ? Number(risk.slValue) : undefined,
      updated_at: new Date().toISOString(),
    };
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined) delete patch[key];
    }

    let row = null;
    try {
      const { data } = await this.client
        .from('bot_settings')
        .select('id')
        .eq('id', 'default')
        .limit(1);
      row = data && data.length > 0 ? data[0] : null;
    } catch (err) {
      console.error('[supabase] setRiskConfig read failed:', err.message);
      return null;
    }

    const { error } = row
      ? await this.client.from('bot_settings').update(patch).eq('id', 'default')
      : await this.client.from('bot_settings').insert([{ id: 'default', ...patch }]);

    if (error) {
      if (String(error.message || error).toLowerCase().includes('does not exist')) {
        console.warn(
          '[supabase] bot_settings table missing — TP/SL change not persisted.'
        );
        return null;
      }
      console.error('[supabase] setRiskConfig failed:', error.message);
      return null;
    }
    return this._mapRiskRow({ ...(row || {}), ...patch });
  }
}

/* ------------------------------------------------------------------ *
 * In-memory store (local dev / demo runner when no Supabase creds)
 * ------------------------------------------------------------------ */
class MockStore {
  constructor() {
    this.mode = 'mock';
    this._rows = [];
  }

  async list(limit = 50) {
    return [...this._rows]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  async getOpenPositions() {
    return this._rows.filter((r) => r.status === 'OPEN');
  }

  async logOpen(trade) {
    this._rows.push(toRow(trade));
  }

  async closeTrade(id, { exitPrice, pnl, reason, closedAt }) {
    const row = this._rows.find((r) => r.id === id);
    if (!row) return;
    Object.assign(row, {
      exit_price: exitPrice,
      pnl,
      reason: reason || null,
      status: 'CLOSED',
      closed_at: new Date(closedAt ?? Date.now()).toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  async recoverOpenPositions() {
    const open = this._rows.filter((r) => r.status === 'OPEN');
    for (const row of open) {
      Object.assign(row, {
        exit_price: row.entry_price,
        pnl: 0,
        reason: 'recovery',
        status: 'CLOSED',
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    if (open.length > 0) {
      console.warn(
        `[supabase-mock] recovered ${open.length} OPEN trade(s) from a previous run (settled at breakeven).`
      );
    }
    return open;
  }

  async getStats() {
    return rowsToStats(this._rows);
  }

  async clearTrades() {
    this._rows = [];
    return { cleared: true };
  }

  RISK_FALLBACK = {
    tpEnabled: false,
    tpValue: 0.5,
    slEnabled: false,
    slValue: -0.6,
  };

  async getRiskConfig() {
    return this._risk ? { ...this._risk } : null;
  }

  async setRiskConfig(risk) {
    if (!risk || typeof risk !== 'object') return null;
    this._risk = {
      tpEnabled: risk.tpEnabled !== undefined ? Boolean(risk.tpEnabled) : undefined,
      tpValue: Number(risk.tpValue ?? this.RISK_FALLBACK.tpValue),
      slEnabled: risk.slEnabled !== undefined ? Boolean(risk.slEnabled) : undefined,
      slValue: Number(risk.slValue ?? this.RISK_FALLBACK.slValue),
    };
    if (this._risk.tpEnabled === undefined) delete this._risk.tpEnabled;
    if (this._risk.slEnabled === undefined) delete this._risk.slEnabled;
    return { ...this._risk };
  }
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */
function getStore(config) {
  if (config.SUPABASE_URL && config.SUPABASE_ANON_KEY) {
    return new SupabaseStore(config);
  }
  console.warn(
    '[supabase] SUPABASE_URL/SUPABASE_ANON_KEY not set — using in-memory mock store. ' +
      'Set them (e.g. as Render secrets) for live persistence.'
  );
  return new MockStore();
}

module.exports = { getStore, SupabaseStore, MockStore };