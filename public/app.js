'use strict';

// ── Role / token detection ────────────────────────────────────────────────────
const params   = new URLSearchParams(location.search);
const urlToken = params.get('token');
const ROLE     = params.get('role') === 'phone' ? 'mobile' : 'desktop';
const TOKEN    = ROLE === 'mobile' ? urlToken : desktopToken();

function desktopToken() {
  let t = localStorage.getItem('qrs_token');
  if (!t) { t = crypto.randomUUID(); localStorage.setItem('qrs_token', t); }
  return t;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmtSize(b) {
  if (b < 1024)       return `${b} B`;
  if (b < 1048576)    return `${(b/1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b/1048576).toFixed(1)} MB`;
  return `${(b/1073741824).toFixed(2)} GB`;
}

function fileEmoji(mime) {
  if (!mime)                              return '📁';
  if (mime.startsWith('image/'))          return '🖼️';
  if (mime.startsWith('video/'))          return '🎬';
  if (mime.startsWith('audio/'))          return '🎵';
  if (mime === 'application/pdf')         return '📄';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('archive')) return '🗜️';
  if (mime.startsWith('text/'))           return '📝';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  if (mime.includes('sheet') || mime.includes('excel'))   return '📊';
  return '📁';
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws, wsRetry;

function connectWS(onMsg) {
  clearTimeout(wsRetry);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${TOKEN}&role=${ROLE}`);
  ws.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch {} };
  ws.onclose   = () => { wsRetry = setTimeout(() => connectWS(onMsg), 3000); };
  ws.onerror   = () => ws.close();
}

// ── Upload (XHR for progress) ─────────────────────────────────────────────────
function upload(file, onProgress) {
  return new Promise((ok, fail) => {
    const xhr = new XMLHttpRequest();
    const fd  = new FormData();
    fd.append('file', file);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload  = () => (xhr.status === 200 ? ok(JSON.parse(xhr.responseText)) : fail(new Error(xhr.statusText)));
    xhr.onerror = () => fail(new Error('Network error'));
    xhr.open('POST', `/upload?token=${TOKEN}&from=${ROLE}`);
    xhr.send(fd);
  });
}

// ── Desktop init ──────────────────────────────────────────────────────────────
function initDesktop() {
  const el = {
    view:      document.getElementById('desktop'),
    dot:       document.getElementById('d-dot'),
    statusTxt: document.getElementById('d-status-text'),
    grid:      document.getElementById('ws-grid'),
    empty:     document.getElementById('ws-empty'),
    count:     document.getElementById('ws-count'),
    fileInput: document.getElementById('d-file-input'),
    progress:  document.getElementById('d-progress'),
    pname:     document.getElementById('d-pname'),
    pfill:     document.getElementById('d-pfill'),
    resetBtn:  document.getElementById('d-reset'),
    dragOver:  document.getElementById('drag-overlay'),
  };
  el.view.style.display = 'flex';

  // QR
  const pairUrl = `${location.origin}/?token=${TOKEN}&role=phone`;
  QRCode.toCanvas(document.getElementById('qr-canvas'), pairUrl, {
    width: 200, margin: 2, color: { dark: '#000', light: '#fff' },
  });

  // State
  const cardIds = new Set();

  function setStatus(on, text) {
    el.dot.className = `dot ${on ? 'on' : ''}`;
    el.statusTxt.textContent = text;
  }

  function updateCount() {
    const n = cardIds.size;
    el.count.textContent = n ? `${n} file${n > 1 ? 's' : ''}` : '';
    el.empty.style.display = n ? 'none' : '';
  }

  // Add a file card
  function addCard(file) {
    const id = file.id || file.fileId;
    if (!id || cardIds.has(id)) return;
    cardIds.add(id);
    updateCount();

    const isImg  = (file.mimeType || '').startsWith('image/');
    const fromLbl = file.from === 'mobile' ? '📱' : '💻';

    const card = document.createElement('div');
    card.className = 'file-card fresh';
    card.dataset.id = id;
    setTimeout(() => card.classList.remove('fresh'), 800);

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    if (isImg) {
      const img = document.createElement('img');
      img.src     = `/preview/${id}`;
      img.alt     = '';
      img.loading = 'lazy';
      img.onerror = () => {
        thumb.innerHTML = '';
        const s = document.createElement('span');
        s.className   = 'card-emoji';
        s.textContent = fileEmoji(file.mimeType);
        thumb.appendChild(s);
      };
      thumb.appendChild(img);
    } else {
      const s = document.createElement('span');
      s.className   = 'card-emoji';
      s.textContent = fileEmoji(file.mimeType);
      thumb.appendChild(s);
    }

    // Body
    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <div class="card-name" title="${escHtml(file.name)}">${escHtml(file.name)}</div>
      <div class="card-meta">
        <span class="card-from">${fromLbl}</span>
        <span>${fmtSize(file.size)}</span>
      </div>`;

    // Footer
    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const dl = document.createElement('a');
    dl.className = 'btn-dl';
    dl.href      = `/download/${id}`;
    dl.download  = file.name;
    dl.textContent = '↓ Download';

    const del = document.createElement('button');
    del.className = 'btn-del';
    del.title     = 'Remove';
    del.innerHTML = '×';
    del.onclick   = () => {
      fetch(`/files/${id}?token=${TOKEN}`, { method: 'DELETE' })
        .then(() => { card.remove(); cardIds.delete(id); updateCount(); });
    };

    foot.append(dl, del);
    card.append(thumb, body, foot);
    el.grid.insertBefore(card, el.grid.firstChild);
  }

  // Load existing files
  fetch(`/files/${TOKEN}`).then(r => r.json()).then(list => list.forEach(addCard));

  // WebSocket
  connectWS(msg => {
    if (msg.type === 'mobile_connected')    setStatus(true,  'Phone connected');
    if (msg.type === 'mobile_disconnected') setStatus(false, 'Waiting for phone…');
    if (msg.type === 'file_ready')          addCard(msg);
  });

  // Upload files
  let uploading = false;
  async function sendFiles(files) {
    if (!files.length || uploading) return;
    uploading = true;
    for (const file of files) {
      el.progress.style.display = 'flex';
      el.pname.textContent      = file.name;
      el.pfill.style.width      = '0%';
      try {
        await upload(file, r => { el.pfill.style.width = `${Math.round(r * 100)}%`; });
        el.pfill.style.width = '100%';
        await sleep(900);
      } catch (err) {
        el.pname.textContent = `Error: ${err.message}`;
        await sleep(2500);
      }
    }
    el.progress.style.display = 'none';
    uploading = false;
  }

  el.fileInput.addEventListener('change', () => {
    sendFiles([...el.fileInput.files]);
    el.fileInput.value = '';
  });

  // Drag & drop
  let dragN = 0;
  document.addEventListener('dragenter', e => { e.preventDefault(); if (++dragN === 1) el.dragOver.classList.add('active'); });
  document.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; el.dragOver.classList.remove('active'); } });
  document.addEventListener('dragover',  e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault(); dragN = 0; el.dragOver.classList.remove('active');
    sendFiles([...e.dataTransfer.files]);
  });

  // Reset
  el.resetBtn.addEventListener('click', () => {
    if (!confirm('Start a new session? This clears your current workspace.')) return;
    localStorage.removeItem('qrs_token');
    location.replace('/');
  });
}

// ── Mobile init ───────────────────────────────────────────────────────────────
function initMobile() {
  const el = {
    view:     document.getElementById('mobile'),
    dot:      document.getElementById('m-dot'),
    statusTxt:document.getElementById('m-status-text'),
    list:     document.getElementById('m-list'),
    progress: document.getElementById('m-progress'),
    pname:    document.getElementById('m-pname'),
    pfill:    document.getElementById('m-pfill'),
    ppct:     document.getElementById('m-ppct'),
  };
  el.view.style.display = 'flex';

  function setStatus(on, text) {
    el.dot.className      = `dot ${on ? 'on' : ''}`;
    el.statusTxt.textContent = text;
  }

  // Add file item to mobile list
  const seen = new Set();
  function addItem(file) {
    const id = file.id || file.fileId;
    if (!id || seen.has(id)) return;
    seen.add(id);

    const emp = el.list.querySelector('.m-empty');
    if (emp) emp.remove();

    const div = document.createElement('div');
    div.className = 'm-file-item';
    div.id        = `mf-${id}`;
    div.innerHTML = `
      <span class="m-file-emoji">${fileEmoji(file.mimeType)}</span>
      <div class="m-file-info">
        <div class="m-file-name">${escHtml(file.name)}</div>
        <div class="m-file-size">${fmtSize(file.size)}</div>
      </div>
      <a class="m-dl-btn" href="/download/${id}" download="${escHtml(file.name)}">↓</a>`;
    el.list.prepend(div);
  }

  // Load desktop files waiting for mobile
  fetch(`/files/${TOKEN}`)
    .then(r => r.json())
    .then(list => list.filter(f => f.from === 'desktop').forEach(addItem));

  // WebSocket
  connectWS(msg => {
    if (msg.type === 'desktop_connected')    setStatus(true,  'Connected to Mac');
    if (msg.type === 'desktop_disconnected') setStatus(false, 'Mac disconnected');
    if (msg.type === 'file_ready' && msg.from === 'desktop') addItem(msg);
  });

  // Upload
  let uploading = false;
  async function sendFiles(files) {
    if (!files.length || uploading) return;
    uploading = true;
    for (const file of Array.from(files)) {
      el.progress.style.display = 'flex';
      el.pname.textContent = file.name;
      el.pfill.style.width = '0%';
      el.ppct.textContent  = '0%';
      try {
        await upload(file, r => {
          const p = Math.round(r * 100);
          el.pfill.style.width = `${p}%`;
          el.ppct.textContent  = `${p}%`;
        });
        el.pfill.style.width = '100%';
        el.ppct.textContent  = '✓';
        await sleep(900);
      } catch (err) {
        el.ppct.textContent = '!';
        await sleep(2200);
      }
    }
    el.progress.style.display = 'none';
    uploading = false;
  }

  ['m-cam', 'm-photos', 'm-any'].forEach(id => {
    const inp = document.getElementById(id);
    inp.addEventListener('change', () => { sendFiles(inp.files); inp.value = ''; });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!TOKEN) {
    document.body.innerHTML = '<p style="color:#ff453a;padding:2rem;font-family:monospace">Missing session token</p>';
    return;
  }
  if (ROLE === 'mobile') initMobile();
  else                   initDesktop();
});
