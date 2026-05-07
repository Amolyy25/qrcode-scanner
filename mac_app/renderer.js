'use strict';

const $ = id => document.getElementById(id);

const qrImg       = $('qr-img');
const dot         = $('dot');
const statusText  = $('status-text');
const dropZone    = $('drop-zone');
const progressWrap= $('progress-wrap');
const progressLbl = $('progress-label');
const fill        = $('fill');
const btnReset    = $('btn-reset');

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  dot.className = `dot ${state}`;   // '', 'connected', 'error'
  statusText.textContent = text;
}

// ── Progress bar ─────────────────────────────────────────────────────────────
let hideTimer = null;

function showProgress(label, pct) {
  clearTimeout(hideTimer);
  progressWrap.className = 'progress-wrap visible';
  progressLbl.textContent = label;
  fill.style.width = `${pct}%`;
}

function finishProgress(label) {
  fill.style.width = '100%';
  progressLbl.textContent = label;
  hideTimer = setTimeout(() => { progressWrap.className = 'progress-wrap'; }, 2200);
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const session = await window.electron.startSession();
  applySession(session);
}

function applySession(session) {
  qrImg.src = session.qrDataUrl;
  setStatus('', 'Waiting for iPhone');
}

init();

// ── Event subscriptions ───────────────────────────────────────────────────────
window.electron.onSessionNew(applySession);

window.electron.onWsStatus(status => {
  if (status === 'disconnected') setStatus('error', 'Disconnected');
});

window.electron.onWsError(() => setStatus('error', 'Connection error'));

window.electron.onWsMessage(msg => {
  if (msg.type === 'phone_connected') {
    setStatus('connected', 'iPhone connected');
  } else if (msg.type === 'chunk_meta' && msg.chunkIndex === 0) {
    showProgress(`Receiving ${msg.filename}…`, 0);
  }
});

window.electron.onTransferProgress(({ filename, chunkIndex, totalChunks, progress }) => {
  showProgress(`Sending ${filename} — ${progress}%`, progress);
});

window.electron.onTransferComplete(({ filename }) => {
  finishProgress(`Sent ${filename} ✓`);
});

window.electron.onTransferError(({ filename, error }) => {
  finishProgress(`Error: ${error}`);
});

window.electron.onReceiveProgress(({ filename, progress }) => {
  showProgress(`Receiving ${filename} — ${progress}%`, progress);
});

window.electron.onReceiveComplete(({ filename }) => {
  finishProgress(`Saved ${filename} ✓`);
});

window.electron.onReceiveError(({ filename, error }) => {
  finishProgress(`Receive error: ${error}`);
});

// ── Drop zone ─────────────────────────────────────────────────────────────────
dropZone.addEventListener('click', async () => {
  const paths = await window.electron.openFilePicker();
  paths.forEach(p => window.electron.sendFile(p));
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('over');
});

dropZone.addEventListener('dragleave', e => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('over');
});

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('over');
  Array.from(e.dataTransfer.files).forEach(f => {
    if (f.path) window.electron.sendFile(f.path);
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────
btnReset.addEventListener('click', async () => {
  setStatus('', 'Waiting for iPhone');
  progressWrap.className = 'progress-wrap';
  clearTimeout(hideTimer);
  const session = await window.electron.resetSession();
  applySession(session);
});
