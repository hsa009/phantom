'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  PORT: 10000,
  MARKET_MODE: 'sim',
  TARGET_ASSET: 'BTC',
  FEED_INTERVAL_MS: 200,
  SIMS_SPREAD_MIN: 0.02,
  SIMS_SPREAD_MAX: 0.06,
  SIMS_MOMENTUM_SHOCK_PROB: 0.002,
  SIMS_BTC_START_PRICE: 67000,
  SIMS_BTC_SIGMA: 0.0002,
  SIMS_BTC_DRIFT: 0,
  MARKET_DURATION_MS: 300000,
  STAKE_AMOUNT: 1.0,
  INITIAL_BALANCE: 18.0,
  TP_ENABLED: false,
  TP_VALUE: 0.5,
  SL_ENABLED: false,
  SL_VALUE: -0.6,
  EXIT_BUFFER_MS: 15000,
  CHECK_INTERVAL_MS: 200,
  MOMENTUM_THRESHOLD: 0.0005,
  MOMENTUM_LOOKBACK_MS: 60000,
  MAX_SPREAD: 0.1,
  KALSHI_API_BASE: 'https://api.elections.kalshi.com/trade-api/v2',
  KALSHI_SERIES: 'KXBTC15M',
  KALSHI_POLL_MS: 500,
  KALSHI_FETCH_TIMEOUT: 8000,
  BTC_SPOT_POLL_MS: 500,
  API_KEY: '',
  DRIFT_SPREAD_FALLBACK: 0.03,
  DRIFT_MARKET_SCAN_MS: 60000,
};

const REQUIRED_ENV = ['RPC_URL'];

function loadDotenv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath });
    }
  } catch {
    // dotenv is optional at runtime; Render injects env natively.
  }
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function loadConfig() {
  loadDotenv();

  const env = process.env;

  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Set them in .env (see .env.example) or in your hosting dashboard.`
    );
  }

  const envMode = String(env.MARKET_MODE || '').toLowerCase();
  // Force Kalshi as the trading feed. Only explicit 'sim' or 'real' — or
  // 'kalshi' — overrides the default; anything unset/unknown lands on Kalshi
  // so the live service can never silently boot a simulated feed again.
  const marketMode = ['kalshi', 'sim', 'real'].includes(envMode) ? envMode : 'kalshi';
  if (envMode !== 'kalshi') {
    console.warn(
      `[config] MARKET_MODE ${envMode ? `"${env.MARKET_MODE}"` : 'unset'} -> forcing "kalshi"`
    );
  }

  const config = {
    RPC_URL: env.RPC_URL,
    MARKET_MODE: marketMode,
    TARGET_ASSET: (env.TARGET_ASSET || DEFAULT_CONFIG.TARGET_ASSET).toUpperCase(),
    MARKET_PROGRAM_ID: env.MARKET_PROGRAM_ID || null,
    MARKET_ACCOUNTS: (env.MARKET_ACCOUNTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    DRIFT_MARKET_INDEX: parseNumber(env.DRIFT_MARKET_INDEX, null),
    DRIFT_SPREAD_FALLBACK: parseNumber(
      env.DRIFT_SPREAD_FALLBACK,
      DEFAULT_CONFIG.DRIFT_SPREAD_FALLBACK
    ),
    DRIFT_MARKET_SCAN_MS: parseNumber(
      env.DRIFT_MARKET_SCAN_MS,
      DEFAULT_CONFIG.DRIFT_MARKET_SCAN_MS
    ),

    PORT: parseNumber(env.PORT, DEFAULT_CONFIG.PORT),
    FEED_INTERVAL_MS: parseNumber(env.FEED_INTERVAL_MS, DEFAULT_CONFIG.FEED_INTERVAL_MS),

    SIMS_SPREAD_MIN: parseNumber(env.SIMS_SPREAD_MIN, DEFAULT_CONFIG.SIMS_SPREAD_MIN),
    SIMS_SPREAD_MAX: parseNumber(env.SIMS_SPREAD_MAX, DEFAULT_CONFIG.SIMS_SPREAD_MAX),
    SIMS_MOMENTUM_SHOCK_PROB: parseNumber(
      env.SIMS_MOMENTUM_SHOCK_PROB,
      DEFAULT_CONFIG.SIMS_MOMENTUM_SHOCK_PROB
    ),
    SIMS_BTC_START_PRICE: parseNumber(
      env.SIMS_BTC_START_PRICE,
      DEFAULT_CONFIG.SIMS_BTC_START_PRICE
    ),
    SIMS_BTC_SIGMA: parseNumber(env.SIMS_BTC_SIGMA, DEFAULT_CONFIG.SIMS_BTC_SIGMA),
    SIMS_BTC_DRIFT: parseNumber(env.SIMS_BTC_DRIFT, DEFAULT_CONFIG.SIMS_BTC_DRIFT),

    MARKET_DURATION_MS: parseNumber(env.MARKET_DURATION_MS, DEFAULT_CONFIG.MARKET_DURATION_MS),
    STAKE_AMOUNT: parseNumber(env.STAKE_AMOUNT, DEFAULT_CONFIG.STAKE_AMOUNT),
    INITIAL_BALANCE: parseNumber(env.INITIAL_BALANCE, DEFAULT_CONFIG.INITIAL_BALANCE),
    TP_ENABLED: parseBoolean(env.TP_ENABLED, DEFAULT_CONFIG.TP_ENABLED),
    TP_VALUE: parseNumber(env.TP_VALUE, DEFAULT_CONFIG.TP_VALUE),
    SL_ENABLED: parseBoolean(env.SL_ENABLED, DEFAULT_CONFIG.SL_ENABLED),
    SL_VALUE: parseNumber(env.SL_VALUE, DEFAULT_CONFIG.SL_VALUE),
    API_KEY: (env.API_KEY || DEFAULT_CONFIG.API_KEY).trim(),
    EXIT_BUFFER_MS: parseNumber(env.EXIT_BUFFER_MS, DEFAULT_CONFIG.EXIT_BUFFER_MS),
    CHECK_INTERVAL_MS: parseNumber(env.CHECK_INTERVAL_MS, DEFAULT_CONFIG.CHECK_INTERVAL_MS),
    MOMENTUM_THRESHOLD: parseNumber(env.MOMENTUM_THRESHOLD, DEFAULT_CONFIG.MOMENTUM_THRESHOLD),
    MOMENTUM_LOOKBACK_MS: parseNumber(
      env.MOMENTUM_LOOKBACK_MS,
      DEFAULT_CONFIG.MOMENTUM_LOOKBACK_MS
    ),
    MAX_SPREAD: parseNumber(env.MAX_SPREAD, DEFAULT_CONFIG.MAX_SPREAD),

    KALSHI_API_BASE: env.KALSHI_API_BASE || DEFAULT_CONFIG.KALSHI_API_BASE,
    KALSHI_SERIES: env.KALSHI_SERIES || DEFAULT_CONFIG.KALSHI_SERIES,
    KALSHI_POLL_MS: parseNumber(env.KALSHI_POLL_MS, DEFAULT_CONFIG.KALSHI_POLL_MS),
    KALSHI_FETCH_TIMEOUT: parseNumber(
      env.KALSHI_FETCH_TIMEOUT,
      DEFAULT_CONFIG.KALSHI_FETCH_TIMEOUT
    ),
    BTC_SPOT_POLL_MS: parseNumber(env.BTC_SPOT_POLL_MS, DEFAULT_CONFIG.BTC_SPOT_POLL_MS),

    SUPABASE_URL: env.SUPABASE_URL || null,
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY || null,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || null,
    TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID || null,
  };

  return config;
}

module.exports = { loadConfig, DEFAULT_CONFIG };