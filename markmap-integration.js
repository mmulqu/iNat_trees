// ===== MM DEBUG HARNESS =====
(() => {
  if (window.__mmDebugInit) return;
  window.__mmDebugInit = true;

  // Turn on/off
  window.MM_DEBUG = true;

  const t0 = performance.now();
  const stamp = () => `${Math.round(performance.now() - t0)}ms`;
  const safe = (v) => {
    try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
  };

  const mdStats = (md) => {
    const s = String(md || '');
    return {
      len: s.length,
      lines: s.split(/\r?\n/).length,
      colorOpen: (s.match(/\{color:/g) || []).length,
      colorClose: (s.match(/\{\/color\}/g) || []).length,
      hasList: /^(\s*(?:[-*+]|\d+\.))\s+/m.test(s),
      hasHeading: /^\s*#{1,6}\s+/m.test(s),
      head: s.slice(0, 400)
    };
  };

  const elStats = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const box = { w: el.clientWidth, h: el.clientHeight };
    return {
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      position: cs.position, ...box
    };
  };

  const log = (msg, data) => {
    if (!window.MM_DEBUG) return;
    console.debug(`[MM][${stamp()}] ${msg}`, data === undefined ? '' : safe(data));
  };

  // Global quick helpers
  window.__mmdbg = { log, mdStats, elStats };

  // Catch silent errors
  window.addEventListener('error', (e) => log('window.error', { msg: e.message, src: e.filename, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => log('unhandledrejection', { reason: String(e.reason) }));

  // Environment snapshot once
  log('env', {
    markmapKeys: Object.keys(window.markmap || {}),
    d3Version: window.d3?.version || null,
    hasForeignObject: 'SVGForeignObjectElement' in window,
    userAgent: navigator.userAgent
  });

  // Panic test: render a tiny Markmap right now (no app plumbing)
  window.mmSmokeTest = () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:auto 12px 12px auto;z-index:9999;background:#fff;border:1px solid #ddd;width:360px;height:220px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.2);';
    host.innerHTML = `<svg id="mm-smoke" style="width:100%;height:100%"></svg>`;
    document.body.appendChild(host);
    try {
      const { Transformer, Markmap } = window.markmap;
      const { root } = new Transformer().transform('# Smoke\n- A\n- B\n- C');
      Markmap.create(host.querySelector('#mm-smoke'), { autoFit: true }, root);
      log('smoke ok');
    } catch (e) {
      log('smoke FAILED', { e: String(e) });
    }
  };
  // Loud sentinel so we know the harness actually executed
  console.log('[MM] harness loaded?', !!window.__mmdbg);
})();

// markmap-integration.js

// SAFER: convert {color:...} tags without breaking lists/blocks.
// - Handles inline pairs on a single line.
// - If a color block spans multiple lines, it wraps only the label portion
//   of each list line (or heading) and never emits a <span> across lines.
// - Any leftover tokens are stripped so the parser never sees raw {color:...}.
window.mmPreprocessColors = function mmPreprocessColors(md) {
  if (!md) return md;
  return String(md).replace(/\{\/?color:[^}]*\}/g, '');
};



document.addEventListener('DOMContentLoaded', function() {
  const style = document.createElement('style');
  style.textContent = `
    .user1-node {
      color: #ff6b6b !important;
      font-weight: bold !important;
    }
    .user2-node {
      color: #4dabf7 !important;
      font-weight: bold !important;
    }
    .shared-node {
      color: #cc5de8 !important;
      font-weight: bold !important;
    }
    .battle-summary {
      margin-top: 20px;
      border-radius: 8px;
      overflow: hidden;
    }
    .vs-badge {
      background-color: #f8f9fa;
      color: #495057;
      padding: 3px 8px;
      border-radius: 4px;
      font-weight: bold;
    }
  `;
  document.head.appendChild(style);
});

// === Inline chip + preview styles and controller ===
(() => {
  const style = document.createElement('style');
  style.textContent += `
  .mm-badge{
  display:inline-block;
  font-size:.72rem;
  line-height:1;
  padding:.18rem .36rem;
  border-radius:.4rem;
  margin-left:.3rem;
  background:#eef2f7;
  color:#334155;
  vertical-align:middle;
  border:1px solid rgba(0,0,0,.08);
}

/* Rank badge pill (multi-char friendly) */
.mm-badge.mm-rank{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  margin-left:.35em;
  padding:0 .30em;
  min-width:1.2em;
  border:1px solid currentColor;
  border-radius:.5em;
  font-weight:600;
  font-size:.70em;
  line-height:1.1;
  letter-spacing:.02em;
  vertical-align:baseline;
  opacity:.95;
  background:#e2e8f0;
  color:#111827;
}

.mm-badge.mm-count{
  background:#e6f4ea;
  color:#1e4620;
}

.mm-badge.mm-photo{
  text-decoration:none;
  background:#e8f0fe;
  cursor:pointer;
  padding:0;
  width:18px;
  height:18px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  border:1px solid transparent;
}

.mm-badge.mm-photo::before{
  content:'';
  width:12px;
  height:12px;
  display:block;
  background:#334155;
  -webkit-mask:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23000"><path d="M9 3l-1.8 2H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2h-3.2L15 3H9zm3 4a5 5 0 110 10 5 5 0 010-10zm0 2.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/></svg>') no-repeat center / contain;
  mask:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23000"><path d="M9 3l-1.8 2H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2h-3.2L15 3H9zm3 4a5 5 0 110 10 5 5 0 010-10zm0 2.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/></svg>') no-repeat center / contain;
}

.mm-badge.mm-range{
  background:#fef3c7;
  border:1px solid #f59e0b;
  color:#7c2d12;
}

/* Dark theme overrides for badges */
body.dark-theme .mm-badge{
  background:#2a2d2f;
  color:#e6e6e6 !important;
  border-color:#3a3f42;
}
body.dark-theme .mm-badge.mm-rank{
  background:#334155;
  color:#f8fafc !important;
}
body.dark-theme .mm-badge.mm-count{
  background:#123524;
  color:#a7f3d0;
}
body.dark-theme .mm-badge.mm-photo::before{
  background:#e5e7eb;
}
body.dark-theme .mm-badge.mm-range{
  background:#3a2e12;
  border-color:#a16207;
  color:#fde68a;
}

.mm-common{opacity:.7;}


  /* Color preprocessing for checklist seen/missing */
  .mm-color { font-weight: 600; }
  .markmap-container svg path.seen-edge   { stroke:#22c55e !important; stroke-opacity:.98; }
  .markmap-container svg path.unseen-edge,
  .markmap-container svg path.missing-edge{ stroke:#9ca3af !important; stroke-opacity:.9; }

  /* Draggable first-observation popup */
  .first-obs-preview{
    position:fixed;               /* <-- fixed so it doesn't jump on scroll */
    z-index:9999; width:300px; max-width:44vw;
    box-shadow:0 8px 24px rgba(0,0,0,.18);
    border:1px solid rgba(0,0,0,.08);
    border-radius:10px; overflow:hidden; background:#fff
  }
  .first-obs-preview header{
    display:flex; justify-content:space-between; align-items:center;
    padding:.5rem .7rem; font-size:.9rem; background:#f8fafc; border-bottom:1px solid #eee; color:#111827;
    cursor:move; user-select:none;           /* <-- drag handle UX */
  }
  .first-obs-preview header.drag-handle{ cursor:move; }
  .first-obs-preview .body{padding:.5rem .7rem}
  .first-obs-preview img{width:100%; height:auto; display:block}
  .first-obs-preview .actions{display:flex; gap:.5rem; margin-top:.5rem}
  .first-obs-spinner{width:100%; padding:1rem; text-align:center; font-size:.9rem; color:#6b7280}

  /* Dark theme overrides for preview */
  body.dark-theme .first-obs-preview{background:#1d1f20; border-color:#3a3f42}
  body.dark-theme .first-obs-preview header{background:#202324; color:#e6e6e6}
  body.dark-theme .first-obs-preview .text-muted{color:#cfd6d8 !important}
  `;
  document.head.appendChild(style);
})();

(() => {
  const API_BASE = window.CF_API_BASE;
  if (!API_BASE) return;

  const cache = new Map();
  let previewEl = null;

  function authHeaders(){
    const headers = { 'Accept': 'application/json' };
    const jwt = localStorage.getItem('inat_jwt');
    const token = localStorage.getItem('inat_token');
    if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
    else if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  function closestPane(el){ return el.closest('.tab-pane'); }
  function key(u,t){ return `${u}:${t}`; }

  async function fetchFirstObs(username, taxonId){
    const k = key(username, taxonId);

    // localStorage cache (persist across reloads)
    try {
      const raw = localStorage.getItem('firstObsCache');
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && obj[k]) return obj[k];
      }
    } catch(_) {}

    if (cache.has(k)) return cache.get(k);

    const u = new URL(`${API_BASE}/first-observation`);
    u.searchParams.set('username', username);
    u.searchParams.set('taxon_id', String(taxonId));
    const r = await fetch(u.toString(), { headers: authHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    cache.set(k, data);
    try {
      const raw = localStorage.getItem('firstObsCache');
      const obj = raw ? JSON.parse(raw) : {};
      obj[k] = data;
      // cap size to ~100 entries
      const keys = Object.keys(obj);
      if (keys.length > 100) delete obj[keys[0]];
      localStorage.setItem('firstObsCache', JSON.stringify(obj));
    } catch(_) {}
    return data;
  }

  function ensurePreview(){
    if (previewEl) return previewEl;
    previewEl = document.createElement('div');
    previewEl.className='first-obs-preview';
    previewEl.style.display='none';
    previewEl.dataset.dragged = '0';
    document.body.appendChild(previewEl);

    // --- Drag support (delegated to header) ---
    enableDrag(previewEl);

    // Close on ESC
    document.addEventListener('keydown', e=>{
      if(e.key==='Escape') previewEl.style.display='none';
    });

    // Outside click close (bubble phase) and ignore clicks on chips
    document.addEventListener('click', e=>{
      const t = e && e.target;
      if (!t || typeof t.closest !== 'function') return; // bail safely
      if (t.closest('a.first-obs-trigger')) return;
      if (previewEl && previewEl.style.display!=='none' && !previewEl.contains(t)) {
        previewEl.style.display='none';
      }
    });
    return previewEl;
  }

  // Auto position near the triggering rect (do not override if user dragged)
  function position(rect){
    const el = ensurePreview();
    if (el.dataset.dragged === '1') return; // user moved it; don't snap back

    const m = 8;
    // For position: fixed, rect.{left,bottom} are viewport-relative
    const top  = Math.min(window.innerHeight - el.offsetHeight - m, Math.max(m, rect.bottom + m));
    const left = Math.min(window.innerWidth  - el.offsetWidth  - m, Math.max(m, rect.left));

    el.style.top  = `${top}px`;
    el.style.left = `${left}px`;
  }

  function spinner(rect){
    const el = ensurePreview();
    el.dataset.dragged = '0';
    el.innerHTML = `
      <header class="drag-handle">
        <strong>Loading image…</strong>
        <button class="btn btn-sm btn-link" onclick="this.closest('.first-obs-preview').style.display='none'">✕</button>
      </header>
      <div class="first-obs-spinner">Loading…</div>
    `;
    el.style.display='block';
    // position after it's visible (so offsetWidth/Height are measurable)
    requestAnimationFrame(() => position(rect));
  }

  function render(rect, username, taxonId, payload){
    const el = ensurePreview();
    el.dataset.dragged = '0';

    if(!payload||payload.notFound){
      el.innerHTML = `
        <header class="drag-handle">
          <strong>No photo found</strong>
          <button class="btn btn-sm btn-link" onclick="this.closest('.first-obs-preview').style.display='none'">✕</button>
        </header>
        <div class="body"><div class="text-muted">Try relaxing filters on iNat</div></div>
      `;
      el.style.display='block';
      requestAnimationFrame(() => position(rect));
      return;
    }

    const {obs_url, observed_on, image_urls} = payload;
    const img  = image_urls?.medium || image_urls?.small || image_urls?.thumb || '';
    const full = image_urls?.original || img || obs_url;

    el.innerHTML = `
      <header class="drag-handle">
        <div>First photo • <span class="text-muted">${observed_on?new Date(observed_on).toLocaleDateString():'date unknown'}</span></div>
        <button class="btn btn-sm btn-link" onclick="this.closest('.first-obs-preview').style.display='none'">✕</button>
      </header>
      <div class="body">
        ${img?`<img alt="First observation photo" src="${img}">`:''}
        <div class="actions">
          <a class="btn btn-sm btn-primary" href="${obs_url}" target="_blank" rel="noopener">Open observation</a>
          ${full?`<a class="btn btn-sm btn-outline-secondary" href="${full}" target="_blank" rel="noopener">Open image</a>`:''}
        </div>
      </div>
    `;
    el.style.display='block';
    requestAnimationFrame(() => position(rect));
  }

  // Hover prefetch
  let t=null;
  document.addEventListener('mouseenter', e=>{
    const target = e && e.target;
    if (!target || typeof target.closest !== 'function') return;
    const a = target.closest('a.first-obs-trigger');
    if(!a) return;
    const pane=closestPane(a);
    const username=a.dataset.username||pane?.dataset.username;
    const taxonId=a.dataset.taxonId||a.getAttribute('data-taxon-id');
    if(!username||!taxonId) return;
    t=setTimeout(async ()=>{
      try{
        await fetchFirstObs(username, taxonId);
      }catch(_){}
    },250);
  }, true);

  document.addEventListener('mouseleave', ()=>{
    if(t){clearTimeout(t); t=null;}
  }, true);

  // Click to open
  document.addEventListener('click', async e=>{
    const target = e && e.target;
    if (!target || typeof target.closest !== 'function') return;
    const a = target.closest('a.first-obs-trigger');
    if(!a) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const pane=closestPane(a);
    const username=a.dataset.username||pane?.dataset.username||a.dataset.username1||a.dataset.username2;
    const taxonId=a.dataset.taxonId||a.getAttribute('data-taxon-id');
    if(!username||!taxonId) return;

    const rect=a.getBoundingClientRect();
    spinner(rect);

    try{
      const payload=await fetchFirstObs(username, taxonId);
      if(e.metaKey||e.ctrlKey){
        if(payload&&payload.obs_url) window.open(payload.obs_url,'_blank');
        ensurePreview().style.display='none';
        return;
      }
      render(rect, username, taxonId, payload);
    }catch(err){
      ensurePreview().style.display='none';
      console.error('first-observation error', err);
    }
  }, true);

  // ---- draggable support ----
  function enableDrag(box){
    let dragging = false, sx=0, sy=0, sl=0, st=0;

    const onDown = (e) => {
      const header = e.target.closest('.drag-handle, .first-obs-preview > header');
      if (!header || !box.contains(header)) return;
      dragging = true;
      const rect = box.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY;
      sl = rect.left; st = rect.top;
      box.dataset.dragged = '1';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      let left = sl + (e.clientX - sx);
      let top  = st + (e.clientY - sy);

      const m = 8;
      const maxL = window.innerWidth  - box.offsetWidth  - m;
      const maxT = window.innerHeight - box.offsetHeight - m;
      left = Math.max(m, Math.min(maxL, left));
      top  = Math.max(m, Math.min(maxT, top));

      box.style.left = `${left}px`;
      box.style.top  = `${top}px`;
    };

    const onUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousedown', onDown);
  }
})();