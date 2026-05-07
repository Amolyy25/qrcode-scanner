'use strict';

const express  = require('express');
const http     = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode   = require('qrcode');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

// ── Persistent storage ────────────────────────────────────────────────────────
// Railway: add a Volume at /data, then set DATA_DIR=/data in env vars.
// Locally: uses .data/ in project root.
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '.data');
const FILES_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH   = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(FILES_DIR, { recursive: true });

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return []; }
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db));
}
let library = loadDB(); // [{ id, name, size, mimeType, savedAt }]

// ── In-memory transfer store (ephemeral, 2h TTL) ───────────────────────────
const fileStore = new Map(); // id → { id, name, size, mimeType, buffer, from, token, ts }
setInterval(() => {
  const cut = Date.now() - 2 * 3600_000;
  for (const [id, f] of fileStore) if (f.ts < cut) fileStore.delete(id);
}, 5 * 60_000);

// ── WS sessions ───────────────────────────────────────────────────────────────
const sessions = new Map(); // token → { desktop: ws|null, mobile: ws|null }

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2 GB

// ── QR ────────────────────────────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');
  const host    = req.get('x-forwarded-host') || req.get('host');
  const proto   = req.get('x-forwarded-proto') || req.protocol;
  const pairUrl = `${proto}://${host}/?token=${token}&role=phone`;
  try {
    const png = await QRCode.toBuffer(pairUrl, { width: 220, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) { res.status(500).send(err.message); }
});

// ── Upload ────────────────────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  const { token, from } = req.query;
  if (!req.file || !token) return res.status(400).json({ error: 'Missing file or token' });

  const id = uuidv4();
  fileStore.set(id, {
    id, token, from: from || 'unknown',
    name:     req.file.originalname,
    size:     req.file.size,
    mimeType: req.file.mimetype,
    buffer:   req.file.buffer,
    ts:       Date.now(),
  });

  const payload = JSON.stringify({
    type: 'file_ready', id, from,
    name:     req.file.originalname,
    size:     req.file.size,
    mimeType: req.file.mimetype,
    ts:       Date.now(),
  });

  const s = sessions.get(token);
  if (s) {
    if (s.desktop?.readyState === WebSocket.OPEN) s.desktop.send(payload);
    if (s.mobile?.readyState  === WebSocket.OPEN) s.mobile.send(payload);
  }
  res.json({ ok: true, id });
});

// ── Download (memory first, then disk library) ─────────────────────────────
app.get('/download/:id', (req, res) => {
  const mem = fileStore.get(req.params.id);
  if (mem) {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(mem.name)}`);
    res.setHeader('Content-Type', mem.mimeType || 'application/octet-stream');
    return res.send(mem.buffer);
  }
  const meta = library.find(m => m.id === req.params.id);
  if (!meta) return res.status(404).send('File not found or expired');
  const fp = path.join(FILES_DIR, meta.id);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing on disk');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
  res.sendFile(fp);
});

// ── Preview (images, inline) ──────────────────────────────────────────────────
app.get('/preview/:id', (req, res) => {
  const mem = fileStore.get(req.params.id);
  if (mem) {
    if (!mem.mimeType?.startsWith('image/')) return res.status(400).send('Not an image');
    res.setHeader('Content-Type', mem.mimeType);
    return res.send(mem.buffer);
  }
  const meta = library.find(m => m.id === req.params.id);
  if (!meta || !meta.mimeType?.startsWith('image/')) return res.status(404).send('Not found');
  res.setHeader('Content-Type', meta.mimeType);
  res.sendFile(path.join(FILES_DIR, meta.id));
});

// ── Transfer file list (ephemeral, per session) ───────────────────────────────
app.get('/files/:token', (req, res) => {
  const list = [];
  for (const f of fileStore.values()) {
    if (f.token === req.params.token)
      list.push({ id: f.id, name: f.name, size: f.size, mimeType: f.mimeType, from: f.from, ts: f.ts });
  }
  res.json(list.sort((a, b) => b.ts - a.ts));
});

app.delete('/files/:id', (req, res) => {
  const { token } = req.query;
  const f = fileStore.get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (f.token !== token) return res.status(403).json({ error: 'Forbidden' });
  fileStore.delete(req.params.id);
  res.json({ ok: true });
});

// ── Library (persistent) ──────────────────────────────────────────────────────
app.post('/save/:id', (req, res) => {
  if (library.find(m => m.id === req.params.id)) return res.json({ ok: true, already: true });

  const f = fileStore.get(req.params.id);
  if (!f) return res.status(404).json({ error: 'File no longer in memory' });

  const fp = path.join(FILES_DIR, f.id);
  fs.writeFileSync(fp, f.buffer);

  const meta = { id: f.id, name: f.name, size: f.size, mimeType: f.mimeType, savedAt: Date.now() };
  library.unshift(meta);
  saveDB(library);
  res.json({ ok: true });
});

app.get('/library', (_req, res) => res.json(library));

app.delete('/library/:id', (req, res) => {
  const idx = library.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  library.splice(idx, 1);
  saveDB(library);
  try { fs.unlinkSync(path.join(FILES_DIR, req.params.id)); } catch {}
  res.json({ ok: true });
});

// ── WebSocket signaling ───────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const qs    = new URLSearchParams(req.url.split('?')[1] || '');
  const token = qs.get('token');
  const role  = qs.get('role');

  if (!token || !['desktop', 'mobile'].includes(role)) { ws.close(); return; }
  if (!sessions.has(token)) sessions.set(token, { desktop: null, mobile: null });
  const s = sessions.get(token);
  s[role]?.close();
  s[role] = ws;

  const peer = role === 'desktop' ? 'mobile' : 'desktop';
  if (s[peer]?.readyState === WebSocket.OPEN) {
    s[peer].send(JSON.stringify({ type: `${role}_connected` }));
    ws.send(JSON.stringify({ type: `${peer}_connected` }));
  }

  ws.on('close', () => {
    if (s[role] !== ws) return;
    s[role] = null;
    s[peer]?.readyState === WebSocket.OPEN &&
      s[peer].send(JSON.stringify({ type: `${role}_disconnected` }));
    if (!s.desktop && !s.mobile) sessions.delete(token);
  });
  ws.on('error', () => {});
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`QR Share on :${PORT} | data: ${DATA_DIR}`));
