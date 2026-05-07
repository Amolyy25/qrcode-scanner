'use strict';

// ── Role detection ────────────────────────────────────────────────────────────
const params   = new URLSearchParams(location.search);
const ROLE     = params.get('role') === 'phone' ? 'mobile' : 'desktop';
const TOKEN    = ROLE === 'mobile' ? params.get('token') : desktopToken();

function desktopToken() {
  let t = localStorage.getItem('qrs_token');
  if (!t) { t = crypto.randomUUID(); localStorage.setItem('qrs_token', t); }
  return t;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function fmtSize(b) {
  if (b < 1024)       return `${b} B`;
  if (b < 1048576)    return `${(b/1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b/1048576).toFixed(1)} MB`;
  return `${(b/1073741824).toFixed(2)} GB`;
}

function fileEmoji(mime) {
  if (!mime)                      return '📁';
  if (mime.startsWith('image/'))  return '🖼️';
  if (mime.startsWith('video/'))  return '🎬';
  if (mime.startsWith('audio/'))  return '🎵';
  if (mime === 'application/pdf') return '📄';
  if (/zip|rar|7z|archive|compressed/.test(mime)) return '🗜️';
  if (/word|document|docx/.test(mime)) return '📝';
  if (/sheet|excel|xlsx/.test(mime))   return '📊';
  if (/presentation|powerpoint/.test(mime)) return '📊';
  if (mime.startsWith('text/'))   return '📄';
  return '📁';
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, dur = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), dur);
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

// ── Upload with progress ──────────────────────────────────────────────────────
function uploadFile(file, onProgress) {
  return new Promise((ok, fail) => {
    const xhr = new XMLHttpRequest();
    const fd  = new FormData();
    fd.append('file', file);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload  = () => xhr.status === 200 ? ok(JSON.parse(xhr.responseText)) : fail(new Error('Upload failed'));
    xhr.onerror = () => fail(new Error('Network error'));
    xhr.open('POST', `/upload?token=${TOKEN}&from=${ROLE}`);
    xhr.send(fd);
  });
}

// ── Save to library ───────────────────────────────────────────────────────────
async function saveToLibrary(id) {
  const res = await fetch(`/save/${id}`, { method: 'POST' });
  return res.json();
}

// ═════════════════════════════════════════════════════════════════════════════
// DESKTOP
// ═════════════════════════════════════════════════════════════════════════════
function initDesktop() {
  $('desktop').style.display = 'flex';
  $('qr-img').src = `/qr?token=${TOKEN}`;

  const wsGrid   = $('ws-grid');
  const wsEmpty  = $('ws-empty');
  const libGrid  = $('lib-grid');
  const libEmpty = $('lib-empty');
  const libBadge = $('lib-badge');

  const cardIds  = new Set();
  let   mobileOn = false;

  // ── Connection status ───────────────────────────────────────────────────────
  function setConn(on, text) {
    mobileOn = on;
    $('d-dot').className   = `dot ${on ? 'on' : ''}`;
    $('d-status').textContent = text;
    $('qr-frame')?.classList.toggle('connected', on);
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const t = btn.dataset.tab;
      $('panel-ws') .style.display = t === 'ws'  ? 'flex' : 'none';
      $('panel-lib').style.display = t === 'lib' ? 'flex' : 'none';
      if (t === 'lib') loadLibrary();
    });
  });

  // ── Library ─────────────────────────────────────────────────────────────────
  const libCardIds = new Set();

  async function loadLibrary() {
    const files = await fetch('/library').then(r => r.json());
    libBadge.textContent = files.length || '';
    libBadge.style.display = files.length ? '' : 'none';
    files.forEach(f => addLibCard(f));
  }

  function addLibCard(file) {
    const id = file.id;
    if (libCardIds.has(id)) return;
    libCardIds.add(id);
    libEmpty.style.display = 'none';

    const card = makeCard(file, 'library');
    libGrid.insertBefore(card, libGrid.firstChild);

    // Update badge
    libBadge.textContent = libCardIds.size;
    libBadge.style.display = '';
  }

  // ── Workspace cards ──────────────────────────────────────────────────────────
  function addWsCard(file) {
    const id = file.id;
    if (cardIds.has(id)) return;
    cardIds.add(id);
    wsEmpty.style.display = 'none';

    const card = makeCard(file, 'workspace');
    wsGrid.insertBefore(card, wsGrid.firstChild);
    setTimeout(() => card.classList.remove('fresh'), 900);
  }

  function makeCard(file, context) {
    const id    = file.id;
    const isLib = context === 'library';
    const isImg = (file.mimeType || '').startsWith('image/');
    const from  = file.from === 'mobile' ? '📱' : file.from === 'desktop' ? '💻' : '';

    const card = document.createElement('div');
    card.className = `file-card fresh${isLib ? ' saved' : ''}`;
    card.dataset.id = id;

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    if (isImg) {
      const img = document.createElement('img');
      img.src  = `/preview/${id}`;
      img.alt  = '';
      img.loading = 'lazy';
      img.onerror = () => { thumb.innerHTML = ''; thumb.append(mkIcon(file.mimeType)); };
      thumb.appendChild(img);
    } else {
      thumb.appendChild(mkIcon(file.mimeType));
    }

    // Body
    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <div class="card-name" title="${esc(file.name)}">${esc(file.name)}</div>
      <div class="card-meta">
        ${from ? `<span class="card-from">${from}</span>` : ''}
        <span>${fmtSize(file.size)}</span>
      </div>`;

    // Footer
    const foot = document.createElement('div');
    foot.className = 'card-foot';

    const dl = document.createElement('a');
    dl.className = 'btn-dl';
    dl.href      = `/download/${id}`;
    dl.download  = file.name;
    dl.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 1v7M3 5.5l3 3 3-3"/><path d="M1 11h10"/></svg> Download`;

    const del = document.createElement('button');
    del.className = 'btn-del';
    del.title     = 'Remove';
    del.textContent = '×';
    del.onclick = () => {
      const endpoint = isLib ? `/library/${id}` : `/files/${id}?token=${TOKEN}`;
      const method   = 'DELETE';
      fetch(endpoint, { method }).then(() => {
        card.remove();
        if (isLib) { libCardIds.delete(id); libBadge.textContent = libCardIds.size || ''; if (!libCardIds.size) { libBadge.style.display='none'; libEmpty.style.display=''; } }
        else { cardIds.delete(id); if (!cardIds.size) wsEmpty.style.display = ''; }
      });
    };

    if (!isLib) {
      const keep = document.createElement('button');
      keep.className   = 'btn-keep';
      keep.textContent = '💾 Keep';
      keep.onclick = async () => {
        keep.disabled = true;
        const r = await saveToLibrary(id);
        if (r.ok || r.already) {
          keep.textContent = '✓ Saved';
          keep.classList.add('kept');
          card.classList.add('saved');
          toast('Saved to library');
          addLibCard({ ...file, savedAt: Date.now() });
        } else {
          toast('Could not save — file may have expired');
          keep.disabled = false;
        }
      };
      foot.append(dl, keep, del);
    } else {
      foot.append(dl, del);
    }

    card.append(thumb, body, foot);
    return card;
  }

  function mkIcon(mime) {
    const s = document.createElement('span');
    s.className   = 'icon';
    s.textContent = fileEmoji(mime);
    return s;
  }

  // ── Load existing files ─────────────────────────────────────────────────────
  fetch(`/files/${TOKEN}`).then(r => r.json()).then(list => list.forEach(addWsCard));
  loadLibrary();

  // ── WebSocket ───────────────────────────────────────────────────────────────
  connectWS(msg => {
    if (msg.type === 'mobile_connected')    { setConn(true, 'Phone connected'); toast('📱 Phone connected'); }
    if (msg.type === 'mobile_disconnected') setConn(false, 'Waiting for phone…');
    if (msg.type === 'file_ready')          addWsCard(msg);
  });

  // ── Upload ──────────────────────────────────────────────────────────────────
  let busy = false;
  async function sendFiles(files) {
    if (!files.length || busy) return;
    busy = true;
    const prog     = $('d-prog');
    const progName = $('d-prog-name');
    const progFill = $('d-prog-fill');
    const progPct  = $('d-prog-pct');

    for (const file of files) {
      prog.style.display = 'flex';
      progName.textContent = file.name;
      progFill.style.width = '0%';
      progPct.textContent  = '0%';
      try {
        await uploadFile(file, r => {
          const p = Math.round(r * 100);
          progFill.style.width = `${p}%`;
          progPct.textContent  = `${p}%`;
        });
        progFill.style.width = '100%';
        progPct.textContent  = '✓';
        toast(`✓ ${file.name} sent`);
        await sleep(800);
      } catch (err) {
        progPct.textContent = '!';
        toast(`Error: ${err.message}`, 3500);
        await sleep(2000);
      }
    }
    prog.style.display = 'none';
    busy = false;
  }

  $('d-file').addEventListener('change', () => { sendFiles([...$('d-file').files]); $('d-file').value = ''; });

  // Drag & drop
  let dragN = 0;
  const overlay = $('drop-overlay');
  document.addEventListener('dragenter', e => { e.preventDefault(); if (++dragN === 1) overlay.classList.add('active'); });
  document.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; overlay.classList.remove('active'); } });
  document.addEventListener('dragover',  e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault(); dragN = 0; overlay.classList.remove('active');
    sendFiles([...e.dataTransfer.files]);
  });

  // Reset
  $('d-reset').addEventListener('click', () => {
    if (!confirm('Start a new session? Current workspace clears.')) return;
    localStorage.removeItem('qrs_token');
    location.replace('/');
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// MOBILE
// ═════════════════════════════════════════════════════════════════════════════
function initMobile() {
  $('mobile').style.display = 'flex';

  const macList = $('m-mac-list');
  const libList = $('m-lib-list');
  const seen    = new Set();

  // ── Tabs ────────────────────────────────────────────────────────────────────
  document.querySelectorAll('.m-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.m-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const t = btn.dataset.mtab;
      macList.style.display = t === 'mac' ? '' : 'none';
      libList.style.display = t === 'lib' ? '' : 'none';
      if (t === 'lib') loadMobileLibrary();
    });
  });

  // ── Connection ──────────────────────────────────────────────────────────────
  function setConn(on, text) {
    $('m-dot').className     = `dot ${on ? 'on' : ''}`;
    $('m-status').textContent = text;
  }

  // ── Add file row to "From Mac" ───────────────────────────────────────────────
  function addMacFile(file) {
    const id = file.id;
    if (seen.has(id)) return;
    seen.add(id);
    macList.querySelector('.m-empty')?.remove();

    const row = makeMobileRow(file, false);
    macList.prepend(row);
  }

  // ── Library ─────────────────────────────────────────────────────────────────
  const libSeen = new Set();

  async function loadMobileLibrary() {
    const files = await fetch('/library').then(r => r.json());
    const badge = $('m-lib-badge');
    badge.textContent   = files.length || '';
    badge.style.display = files.length ? '' : 'none';
    files.forEach(f => {
      if (!libSeen.has(f.id)) {
        libSeen.add(f.id);
        libList.querySelector('.m-empty')?.remove();
        libList.append(makeMobileRow(f, true));
      }
    });
  }

  function makeMobileRow(file, fromLib) {
    const id  = file.id;
    const row = document.createElement('div');
    row.className = 'm-file-row';

    const icon = document.createElement('span');
    icon.className   = 'm-file-icon';
    icon.textContent = fileEmoji(file.mimeType);

    const info = document.createElement('div');
    info.className = 'm-file-info';
    info.innerHTML = `<div class="m-file-name">${esc(file.name)}</div>
      <div class="m-file-meta">${fmtSize(file.size)}${fromLib ? ' · Library' : ''}</div>`;

    const dl = document.createElement('a');
    dl.className  = 'm-dl-btn';
    dl.href       = `/download/${id}`;
    dl.download   = file.name;
    dl.textContent = '↓';

    if (!fromLib) {
      const keep = document.createElement('button');
      keep.className   = 'm-keep-btn';
      keep.textContent = '💾';
      keep.title       = 'Keep in library';
      keep.onclick = async () => {
        keep.disabled = true;
        const r = await saveToLibrary(id);
        if (r.ok || r.already) {
          keep.textContent = '✓';
          keep.classList.add('kept');
          toast('Saved to library');
        } else {
          toast('File expired, cannot save');
          keep.disabled = false;
        }
      };
      row.append(icon, info, keep, dl);
    } else {
      row.append(icon, info, dl);
    }
    return row;
  }

  // ── Load existing files from Mac ─────────────────────────────────────────────
  fetch(`/files/${TOKEN}`).then(r => r.json())
    .then(list => list.filter(f => f.from === 'desktop').forEach(addMacFile));

  // ── WS ──────────────────────────────────────────────────────────────────────
  connectWS(msg => {
    if (msg.type === 'desktop_connected')    setConn(true, 'Mac connected');
    if (msg.type === 'desktop_disconnected') setConn(false, 'Mac disconnected');
    if (msg.type === 'file_ready' && msg.from === 'desktop') {
      addMacFile(msg);
      toast(`📩 ${msg.name}`);
    }
  });

  // ── Upload ──────────────────────────────────────────────────────────────────
  let busy = false;
  async function sendFiles(files) {
    if (!files.length || busy) return;
    busy = true;
    const prog = $('m-prog');
    const name = $('m-prog-name');
    const fill = $('m-prog-fill');
    const pct  = $('m-prog-pct');

    for (const file of Array.from(files)) {
      prog.style.display = 'flex';
      name.textContent   = file.name;
      fill.style.width   = '0%';
      pct.textContent    = '0%';
      try {
        await uploadFile(file, r => {
          const p = Math.round(r * 100);
          fill.style.width = `${p}%`;
          pct.textContent  = `${p}%`;
        });
        fill.style.width = '100%';
        pct.textContent  = '✓';
        toast(`✓ ${file.name} sent`);
        await sleep(800);
      } catch (err) {
        pct.textContent = '!';
        toast(`Error: ${err.message}`, 3500);
        await sleep(2000);
      }
    }
    prog.style.display = 'none';
    busy = false;
  }

  ['m-main-file','m-cam','m-media','m-audio'].forEach(id => {
    const inp = $(id);
    inp?.addEventListener('change', () => { sendFiles(inp.files); inp.value = ''; });
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (!TOKEN) {
  document.body.innerHTML = '<p style="color:#ff453a;padding:2rem;font-family:monospace">Missing session token</p>';
} else if (ROLE === 'mobile') {
  initMobile();
} else {
  initDesktop();
}
