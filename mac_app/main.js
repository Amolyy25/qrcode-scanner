'use strict';

const { app, BrowserWindow, Tray, ipcMain, dialog, nativeImage, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { v4: uuidv4 } = require('uuid');
const WebSocket      = require('ws');
const QRCode         = require('qrcode');

const RELAY    = 'wss://qrcode-scanner-production-940c.up.railway.app';
const PAIR_URL = 'https://qrcode-scanner-production-940c.up.railway.app/pair';
const CHUNK_SZ = 64 * 1024;          // 64 KB
const TTL      = 5 * 60 * 1000;      // 5 minutes

app.dock?.hide();

let tray        = null;
let win         = null;
let ws          = null;
let resetTimer  = null;
let justHid     = false;              // prevent tray-click from re-opening after blur

// ── Receiving state ──────────────────────────────────────────────────────────
let pendingMeta   = null;             // last chunk_meta received, awaiting binary
let rxFiles       = new Map();        // filename → { chunks[], received, totalChunks, totalSize }

// ── Helpers ──────────────────────────────────────────────────────────────────
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ── Session ───────────────────────────────────────────────────────────────────
async function startSession() {
  const token      = uuidv4();
  const pairingUrl = `${PAIR_URL}?token=${token}`;
  const qrDataUrl  = await QRCode.toDataURL(pairingUrl, {
    width: 200, margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });

  openWS(token);

  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(async () => {
    const session = await startSession();
    send('session:new', session);
  }, TTL);

  return { token, pairingUrl, qrDataUrl };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function openWS(token) {
  if (ws) { ws.removeAllListeners(); ws.terminate(); ws = null; }
  pendingMeta = null;
  rxFiles.clear();

  ws = new WebSocket(`${RELAY}/mac?token=${token}`);

  ws.on('open',  ()           => send('ws:status', 'relay_connected'));
  ws.on('close', ()           => send('ws:status', 'disconnected'));
  ws.on('error', (e)          => send('ws:error',  e.message));
  ws.on('message', (data, isBinary) => {
    if (isBinary) onBinary(data);
    else          onText(data.toString());
  });
}

function onText(text) {
  if (text === 'phone_connected') {
    send('ws:message', { type: 'phone_connected' }); return;
  }
  let msg;
  try { msg = JSON.parse(text); } catch { send('ws:message', { type: 'raw', data: text }); return; }

  if (msg.type === 'chunk_meta') {
    pendingMeta = msg;
    if (!rxFiles.has(msg.filename)) {
      rxFiles.set(msg.filename, {
        chunks: new Array(msg.totalChunks).fill(null),
        received: 0,
        totalChunks: msg.totalChunks,
        totalSize: msg.totalSize,
      });
    }
    send('ws:message', msg);
  } else if (msg.type === 'transfer_complete') {
    assembleFile(msg.filename);
  } else {
    send('ws:message', msg);
  }
}

function onBinary(data) {
  if (!pendingMeta) return;
  const meta  = pendingMeta; pendingMeta = null;
  const state = rxFiles.get(meta.filename);
  if (!state) return;

  state.chunks[meta.chunkIndex] = Buffer.from(data);
  state.received++;
  send('receive:progress', {
    filename:    meta.filename,
    chunkIndex:  meta.chunkIndex,
    totalChunks: state.totalChunks,
    progress:    Math.round((state.received / state.totalChunks) * 100),
  });
}

function assembleFile(filename) {
  const state = rxFiles.get(filename);
  if (!state) return;
  try {
    const buf      = Buffer.concat(state.chunks.filter(Boolean));
    const savePath = path.join(os.homedir(), 'Downloads', filename);
    fs.writeFileSync(savePath, buf);
    rxFiles.delete(filename);
    send('receive:complete', { filename, savePath });
    shell.showItemInFolder(savePath);
  } catch (err) {
    send('receive:error', { filename, error: err.message });
  }
}

// ── File sending ─────────────────────────────────────────────────────────────
async function sendFile(filePath) {
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return { error: 'WebSocket not connected' };

  const filename   = path.basename(filePath);
  const totalSize  = fs.statSync(filePath).size;
  const totalChunks = Math.ceil(totalSize / CHUNK_SZ);
  const stream     = fs.createReadStream(filePath, { highWaterMark: CHUNK_SZ });
  let   chunkIndex = 0;

  try {
    for await (const chunk of stream) {
      ws.send(JSON.stringify({ type: 'chunk_meta', filename, totalSize, chunkIndex, totalChunks }));
      ws.send(chunk);
      chunkIndex++;
      send('transfer:progress', {
        filename, chunkIndex, totalChunks,
        progress: Math.round((chunkIndex / totalChunks) * 100),
      });
    }
    ws.send(JSON.stringify({ type: 'transfer_complete', filename }));
    send('transfer:complete', { filename });
    return { success: true };
  } catch (err) {
    send('transfer:error', { filename, error: err.message });
    return { error: err.message };
  }
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 400, height: 500,
    show: false, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    vibrancy: 'under-window', visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile('index.html');

  win.on('blur', () => {
    // Blur fires before the tray click event; flag it so tray handler can skip re-open.
    justHid = true;
    win.hide();
    setTimeout(() => { justHid = false; }, 250);
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'iconTemplate.png');
  const img      = nativeImage.createFromPath(iconPath);
  img.setTemplateImage(true);

  tray = new Tray(img);
  tray.setToolTip('QR Share');

  tray.on('click', (_, bounds) => {
    if (justHid) return; // blur already hid it; don't re-open on same click
    if (win.isVisible()) { win.hide(); return; }
    const wb = win.getBounds();
    win.setPosition(
      Math.round(bounds.x + bounds.width / 2 - wb.width / 2),
      Math.round(bounds.y + bounds.height + 4),
    );
    win.show(); win.focus();
  });
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('session:start',   ()           => startSession());
ipcMain.handle('session:reset',   ()           => startSession());
ipcMain.handle('file:send',       (_, fpath)   => sendFile(fpath));
ipcMain.handle('dialog:openFile', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.cancelled ? [] : r.filePaths;
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => { createWindow(); createTray(); });
app.on('window-all-closed', e => e.preventDefault());
