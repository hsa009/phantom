-- Trades ledger for the Solana prediction paper-trading bot
-- Run once in Supabase → SQL Editor.

create table if not exists public.trades (
  id              uuid primary key default gen_random_uuid(),
  market_id       text not null,
  direction       text not null check (direction in ('UP', 'DOWN')),
  entry_price     numeric not null,
  true_multiplier numeric not null,
  stake_amount    numeric not null,
  tokens_bought   numeric not null,
  exit_price      numeric,
  pnl             numeric,
  status          text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  reason          text,                                 -- take_profit | stop_loss | expiry | reset | recovery
  created_at      timestamptz not null default now(),
  closed_at       timestamptz,
  updated_at      timestamptz default now()
);

-- Allow the app (anon key) read + write access to the paper ledger.
-- Intentionally permissive: this is a purely simulated paper ledger with no
-- real funds. Tighten before ever storing real data.
alter table public.trades enable row level security;

create policy "anon_insert_trades" on public.trades
  for insert to anon with check (true);

create policy "anon_select_trades" on public.trades
  for select to anon using (true);

create policy "anon_update_trades" on public.trades
  for update to anon using (true);