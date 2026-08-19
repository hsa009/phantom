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