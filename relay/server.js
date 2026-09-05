/**
 * NXTslide Cloud Relay Server
 * Runs on Railway / Render / Fly.io free tier.
 *
 * REST API:
 *   POST /api/rooms        create room, returns { code, wsUrl, phoneUrl }
 *   GET  /api/rooms/:code  check room exists
 *   GET  /health           health check
 *
 * WebSocket:
 *   WS /ws/:code/pc        PC connects as host
 *   WS /ws/:code/phone     Phone connects as remote
 */
'use strict';
const http    = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { randomBytes } = require('crypto');
const url = require('url');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const PORT        = process.env.PORT || 4000;
const ROOM_TTL_MS = 8 * 60 * 60 * 1000;
const rooms = new Map();

// ─── Automatic Keep-Alive (Prevents Render.com free tier from sleeping) ───
const keepAliveTarget = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (keepAliveTarget) {
  console.log('[Relay] Keep-alive active for:', keepAliveTarget);
  setInterval(() => {
    fetch(`${keepAliveTarget}/health`).catch(() => {});
  }, 10 * 60 * 1000); // ping every 10 min
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(randomBytes(6)).map(b => chars[b % chars.length]).join(''); }
  while (rooms.has(code));
  return code;
}

function createRoom() {
  const code  = generateCode();
  const timer = setTimeout(() => deleteRoom(code), ROOM_TTL_MS);
  rooms.set(code, { pc: null, phones: new Set(), timer, createdAt: Date.now() });
  return code;
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  if (room.pc && room.pc.readyState === WebSocket.OPEN) room.pc.close(1001,'Room expired');
  room.phones.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.close(1001,'Room expired'); });
  rooms.delete(code);
  console.log('[Relay] Room',code,'deleted. Rooms:', rooms.size);
}

function touchRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => deleteRoom(code), ROOM_TTL_MS);
}

function broadcastToPhones(room, data) {
  room.phones.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}
function sendToPc(room, data) {
  if (room.pc && room.pc.readyState === WebSocket.OPEN) room.pc.send(data);
}

app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (_req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ status:'ok', rooms:rooms.size, uptime:process.uptime() }));

app.post('/api/rooms', (req, res) => {
  const code = createRoom();
  const host = req.headers.host;
  console.log('[Relay] Room created:', code, '| Total:', rooms.size);
  res.json({
    code,
    wsUrl:    `wss://${host}/ws/${code}/pc`,
    phoneUrl: `https://${host}/r/${code}`,
    expiresAt: Date.now() + ROOM_TTL_MS,
  });
});

app.get('/api/rooms/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ exists:false });
  res.json({ exists:true, phones:room.phones.size, hasPc:room.pc!==null, code });
});

// HTTP Fallback Endpoint — zero lost clicks if WebSocket is ever reconnecting
app.post('/api/rooms/:code/command', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { action, source } = req.body;
  if (!action) return res.status(400).json({ error: 'Action required' });

  touchRoom(code);
  const payload = JSON.stringify({
    type: 'COMMAND',
    action,
    source: source || 'Relay HTTP Fallback',
    timestamp: Date.now()
  });
  sendToPc(room, payload);
  res.json({ success: true, action });
});

app.get('/r/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NXTslide - Connect</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#05070d;color:#fff;
font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;padding:2rem;text-align:center}
h1{font-size:1.5rem;margin-bottom:.5rem;color:#818cf8}p{color:#94a3b8;margin-bottom:1rem}
.code{font-size:3rem;font-weight:700;letter-spacing:.4rem;color:#818cf8;margin:1.5rem 0}
a.btn{display:block;padding:1rem 2rem;background:#6366f1;color:#fff;text-decoration:none;
border-radius:12px;font-weight:600;font-size:1.1rem;margin-bottom:1rem}
</style></head><body>
<h1>NXTslide</h1><p>Your room code is:</p>
<div class="code">${code}</div>
<a class="btn" href="nextpresent://connect?code=${code}">Open in App</a>
<p style="font-size:.85rem">Don't have the app? Download from Google Play Store.</p>
<script>setTimeout(()=>{window.location='intent://connect?code=${code}#Intent;scheme=nextpresent;package=com.nextpresent.remote;end';},500);</script>
</body></html>`);
});

app.get('/', (_req, res) => res.json({ service:'NXTslide Relay', rooms:rooms.size, version:'1.0.0' }));

server.on('upgrade', (request, socket, head) => {
  const { pathname } = url.parse(request.url);
  const match = pathname.match(/^\/ws\/([A-Z0-9]{6})\/(pc|phone)$/i);
  if (!match) { socket.destroy(); return; }
  const code = match[1].toUpperCase();
  const role = match[2].toLowerCase();
  if (!rooms.has(code)) { socket.write('HTTP/1.1 404 Room Not Found\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, code, role));
});

wss.on('connection', (ws, _req, code, role) => {
  const room = rooms.get(code);
  if (!room) { ws.close(1008,'Room gone'); return; }

  // Disable Nagle's algorithm for true 0-delay packet delivery
  if (ws._socket) {
    ws._socket.setNoDelay(true);
  }

  touchRoom(code);
  if (role === 'pc') {
    if (room.pc && room.pc.readyState === WebSocket.OPEN) room.pc.close(1001,'New PC connected');
    room.pc = ws;
    console.log('[Relay] PC joined room', code);
    broadcastToPhones(room, JSON.stringify({ type:'PC_CONNECTED' }));
    ws.on('message', (data) => { touchRoom(code); broadcastToPhones(room, data); });
    ws.on('close', () => {
      if (room.pc === ws) room.pc = null;
      broadcastToPhones(room, JSON.stringify({ type:'PC_DISCONNECTED' }));
    });
  } else {
    room.phones.add(ws);
    console.log('[Relay] Phone joined room', code, '| Phones:', room.phones.size);
    sendToPc(room, JSON.stringify({ type:'PHONE_COUNT', count:room.phones.size }));
    ws.on('message', (data) => { touchRoom(code); sendToPc(room, data); });
    ws.on('close', () => {
      room.phones.delete(ws);
      sendToPc(room, JSON.stringify({ type:'PHONE_COUNT', count:room.phones.size }));
    });
  }
  ws.on('error', (err) => console.warn('[Relay] WS error room', code, err.message));
});

process.on('SIGTERM', () => { rooms.forEach((_,c)=>deleteRoom(c)); server.close(()=>process.exit(0)); });
server.listen(PORT, () => console.log('[Relay] NXTslide Cloud Relay on port', PORT));
