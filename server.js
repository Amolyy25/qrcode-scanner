'use strict';

const express  = require('express');
const http     = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

// ── In-memory stores ─────────────────────────────────────────────────────────
// sessions: token → { desktop: ws|null, mobile: ws|null }
const sessions = new Map();
// fileStore: fileId → { id, name, size, mimeType, buffer, from, token, ts }
const fileStore = new Map();

// Evict files older than 2 h
setInterval(() => {
  const cut = Date.now() - 2 * 3600_000;
  for (const [id, f] of fileStore) if (f.ts < cut) fileStore.delete(id);
}, 5 * 60_000);

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Upload ────────────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/upload', upload.single('file'), (req, res) => {
  const { token, from } = req.query;
  if (!req.file || !token) return res.status(400).json({ error: 'Missing file or token' });

  const id = uuidv4();
  fileStore.set(id, {
    id, token, from: from || 'unknown',
    name: req.file.originalname,
    size: req.file.size,
    mimeType: req.file.mimetype,
    buffer: req.file.buffer,
    ts: Date.now(),
  });

  const payload = JSON.stringify({
    type: 'file_ready', id, from,
    name: req.file.originalname,
    size: req.file.size,
    mimeType: req.file.mimetype,
    ts: Date.now(),
  });

  const s = sessions.get(token);
  if (s) {
    if (s.desktop?.readyState === WebSocket.OPEN) s.desktop.send(payload);
    if (s.mobile?.readyState  === WebSocket.OPEN) s.mobile.send(payload);
  }

  res.json({ ok: true, id });
});

// ── Download (attachment) ─────────────────────────────────────────────────────
app.get('/download/:id', (req, res) => {
  const f = fileStore.get(req.params.id);
  if (!f) return res.status(404).send('File not found or expired');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
  res.send(f.buffer);
});

// ── Preview (inline, images only) ────────────────────────────────────────────
app.get('/preview/:id', (req, res) => {
  const f = fileStore.get(req.params.id);
  if (!f) return res.status(404).send('Not found');
  if (!f.mimeType?.startsWith('image/')) return res.status(400).send('Not an image');
  res.setHeader('Content-Type', f.mimeType);
  res.send(f.buffer);
});

// ── File list ─────────────────────────────────────────────────────────────────
app.get('/files/:token', (req, res) => {
  const list = [];
  for (const f of fileStore.values()) {
    if (f.token === req.params.token) {
      list.push({ id: f.id, name: f.name, size: f.size, mimeType: f.mimeType, from: f.from, ts: f.ts });
    }
  }
  res.json(list.sort((a, b) => b.ts - a.ts));
});

// ── Delete ────────────────────────────────────────────────────────────────────
app.delete('/files/:id', (req, res) => {
  const { token } = req.query;
  const f = fileStore.get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (f.token !== token) return res.status(403).json({ error: 'Forbidden' });
  fileStore.delete(req.params.id);
  res.json({ ok: true });
});

// ── WebSocket signaling ───────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const qs    = new URLSearchParams(req.url.split('?')[1] || '');
  const token = qs.get('token');
  const role  = qs.get('role'); // 'desktop' | 'mobile'

  if (!token || !['desktop', 'mobile'].includes(role)) { ws.close(); return; }

  if (!sessions.has(token)) sessions.set(token, { desktop: null, mobile: null });
  const s = sessions.get(token);

  // Close stale connection for this role
  s[role]?.close();
  s[role] = ws;

  const peer = role === 'desktop' ? 'mobile' : 'desktop';

  // Announce each other
  if (s[peer]?.readyState === WebSocket.OPEN) {
    s[peer].send(JSON.stringify({ type: `${role}_connected` }));
    ws.send(JSON.stringify({ type: `${peer}_connected` }));
  }

  ws.on('close', () => {
    if (s[role] !== ws) return;
    s[role] = null;
    if (s[peer]?.readyState === WebSocket.OPEN)
      s[peer].send(JSON.stringify({ type: `${role}_disconnected` }));
    if (!s.desktop && !s.mobile) sessions.delete(token);
  });

  ws.on('error', () => {});
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`QR Share on :${PORT}`));
