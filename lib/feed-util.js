'use strict';

const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;
const DEFAULT_SPREAD = 0.03;

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function round(x, dp = 4) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function turnRpcUrlIntoWs(url) {
  if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
  return url.replace(/^http/, 'ws');
}

function normalizeQuote({ marketId, yesBid, yesAsk, timestamp, mode, simulated, asset, price }) {
  const noAsk = round(1 - yesBid);
  const noBid = round(1 - yesAsk);
  const quote = {
    marketId,
    yesBid: round(yesBid),
    yesAsk: round(yesAsk),
    noBid,
    noAsk,
    mid: round((yesBid + yesAsk) / 2),
    timestamp: timestamp || Date.now(),
    mode,
    simulated: Boolean(simulated),
  };
  if (asset) quote.asset = String(asset).toUpperCase();
  if (price != null && Number.isFinite(Number(price))) quote.price = round(Number(price), 2);
  return quote;
}

module.exports = {
  MIN_PRICE,
  MAX_PRICE,
  DEFAULT_SPREAD,
  clamp,
  round,
  turnRpcUrlIntoWs,
  normalizeQuote,
};
