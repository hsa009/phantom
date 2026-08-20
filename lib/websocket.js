'use strict';

const { WebSocketServer } = require('ws');

/* ------------------------------------------------------------------ *
 * WebSocket streaming layer.
 *
 * attachWebSocketServer(httpServer, getState) mounts a WS server on top
 * of the Express HTTP server. It broadcasts a JSON snapshot of the bot
 * ({ type: 'state', ...getState() }) to every connected dashboard client
 * (Cloudflare Pages frontend), throttled to BROADCAST_INTERVAL_MS, and
 * sends an immediate snapshot to each client on connect.
 * ------------------------------------------------------------------ */

const BROADCAST_INTERVAL_MS = 500;
const OPEN = 1;
const WSS_PATH = '/ws';

function attachWebSocketServer(server, getState) {
  const wss = new WebSocketServer({ server, path: WSS_PATH });

  const send = (ws, payload) => {
    if (ws.readyState !== OPEN) return;
    try {
      ws.send(payload);
    } catch {
      // client gone; cleaned up below
    }
  };

  wss.on('connection', (ws) => {
    send(ws, JSON.stringify({ type: 'state', ...getState() }));
    ws.on('close', () => {});
    ws.on('error', () => {});
  });

  const timer = setInterval(() => {
    if (wss.clients.size === 0) return;
    const payload = JSON.stringify({ type: 'state', ...getState() });
    for (const ws of wss.clients) send(ws, payload);
  }, BROADCAST_INTERVAL_MS);
  if (timer.unref) timer.unref();

  console.log(`[ws] websocket server mounted on ${WSS_PATH} (broadcast ${BROADCAST_INTERVAL_MS}ms)`);
  return wss;
}

module.exports = { attachWebSocketServer, BROADCAST_INTERVAL_MS, WSS_PATH };