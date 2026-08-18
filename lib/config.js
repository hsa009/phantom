'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  PORT: 10000,
  MARKET_MODE: 'sim',
  FEED_INTERVAL_MS: 200,
  SIMS_SPREAD_MIN: 0.02,
  SIMS_SPREAD_MAX: 0.06,
  SIMS_KAPPA: 0.01,
  SIMS_SIGMA: 0.02,
  SIMS_MOMENTUM_SHOCK_PROB: 0.002,
  MARKET_DURATION_MS: 300000,
  STAKE_AMOUNT: 1.0,
  INITIAL_BALANCE: 18.0,
  TAKE_PROFIT: 0.5,
  STOP_LOSS: 0.25,
  EXIT_BUFFER_MS: 15000,
  CHECK_INTERVAL_MS: 200,
  MOMENTUM_THRESHOLD: 0.005,
  MOMENTUM_LOOKBACK_MS: 60000,
  MAX_SPREAD: 0.1,
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

  const marketMode = (env.MARKET_MODE || DEFAULT_CONFIG.MARKET_MODE).toLowerCase();
  if (!['sim', 'real'].includes(marketMode)) {
    throw new Error(
      `Invalid MARKET_MODE "${env.MARKET_MODE}" — expected "sim" or "real".`
    );
  }

  const config = {
    RPC_URL: env.RPC_URL,
    MARKET_MODE: marketMode,
    MARKET_PROGRAM_ID: env.MARKET_PROGRAM_ID || null,
    MARKET_ACCOUNTS: (env.MARKET_ACCOUNTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    PORT: parseNumber(env.PORT, DEFAULT_CONFIG.PORT),
    FEED_INTERVAL_MS: parseNumber(env.FEED_INTERVAL_MS, DEFAULT_CONFIG.FEED_INTERVAL_MS),

    SIMS_SPREAD_MIN: parseNumber(env.SIMS_SPREAD_MIN, DEFAULT_CONFIG.SIMS_SPREAD_MIN),
    SIMS_SPREAD_MAX: parseNumber(env.SIMS_SPREAD_MAX, DEFAULT_CONFIG.SIMS_SPREAD_MAX),
    SIMS_KAPPA: parseNumber(env.SIMS_KAPPA, DEFAULT_CONFIG.SIMS_KAPPA),
    SIMS_SIGMA: parseNumber(env.SIMS_SIGMA, DEFAULT_CONFIG.SIMS_SIGMA),
    SIMS_MOMENTUM_SHOCK_PROB: parseNumber(
      env.SIMS_MOMENTUM_SHOCK_PROB,
      DEFAULT_CONFIG.SIMS_MOMENTUM_SHOCK_PROB
    ),

    MARKET_DURATION_MS: parseNumber(env.MARKET_DURATION_MS, DEFAULT_CONFIG.MARKET_DURATION_MS),
    STAKE_AMOUNT: parseNumber(env.STAKE_AMOUNT, DEFAULT_CONFIG.STAKE_AMOUNT),
    INITIAL_BALANCE: parseNumber(env.INITIAL_BALANCE, DEFAULT_CONFIG.INITIAL_BALANCE),
    TAKE_PROFIT: parseNumber(env.TAKE_PROFIT, DEFAULT_CONFIG.TAKE_PROFIT),
    STOP_LOSS: parseNumber(env.STOP_LOSS, DEFAULT_CONFIG.STOP_LOSS),
    EXIT_BUFFER_MS: parseNumber(env.EXIT_BUFFER_MS, DEFAULT_CONFIG.EXIT_BUFFER_MS),
    CHECK_INTERVAL_MS: parseNumber(env.CHECK_INTERVAL_MS, DEFAULT_CONFIG.CHECK_INTERVAL_MS),
    MOMENTUM_THRESHOLD: parseNumber(env.MOMENTUM_THRESHOLD, DEFAULT_CONFIG.MOMENTUM_THRESHOLD),
    MOMENTUM_LOOKBACK_MS: parseNumber(
      env.MOMENTUM_LOOKBACK_MS,
      DEFAULT_CONFIG.MOMENTUM_LOOKBACK_MS
    ),
    MAX_SPREAD: parseNumber(env.MAX_SPREAD, DEFAULT_CONFIG.MAX_SPREAD),

    SUPABASE_URL: env.SUPABASE_URL || null,
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY || null,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || null,
    TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID || null,
  };

  return config;
}

module.exports = { loadConfig, DEFAULT_CONFIG };