import { getAuthHeaders, fetchCurrentUser } from './auth.js';
let CURRENT_USER = localStorage.getItem('inat_username') || null;

// ---- Taxon name resolver ----
async function resolveTaxonTitle(taxonId) {
  const cache = (resolveTaxonTitle._cache ||= new Map());
  if (cache.has(taxonId)) return cache.get(taxonId);
  let title = `Taxon ${taxonId}`;
  try {
    const r = await fetch(`https://api.inaturalist.org/v1/taxa/${taxonId}`);
    const j = await r.json();
    const t = j?.results?.[0];
    if (t?.name) title = t.name; // scientific name only
  } catch {}
  cache.set(taxonId, title);
  return title;
}
let currentTaxonId = null, currentDates = [], debounceTimer = null;
let currentCpTabId = null; // active checkpoint tab to render into
const cpMarkmaps = Object.create(null); // tabId -> Markmap instance
const firstSeenCacheByTaxon = Object.create(null);

const API_BASE = window.CF_API_BASE;
const listUrl = `${API_BASE}/checkpoints/list`;
const saveUrl = `${API_BASE}/checkpoints/save`;
const deleteUrl = `${API_BASE}/checkpoints/delete`;
const treeFromSpeciesUrl = `${API_BASE}/tree-from-species`;
const firstSeenUrl = `${API_BASE}/timeline/first-seen`;
const PRE_CACHE_COUNT = 8; // number of quantized dates to prefetch per taxon
const preCacheDatesByTaxon = Object.create(null); // taxonId -> iso[]
const preCacheInFlight = Object.create(null); // key -> Promise

// ----- Timeline color helpers (palette + painters) -----
let cpTimelineState = null; // { taxonId, dates: string[], colors: string[], eraIndexByTaxonId: { [taxonId:number]: number } }

function buildTimelinePalette(n) {
  // Smooth, intuitive left→right progression:
  // blue → cyan → green → lime → yellow → orange → red → purple
  const base = ['#2563eb', '#06b6d4', '#10b981', '#84cc16', '#eab308', '#f59e0b', '#ef4444', '#a855f7'];
  if (n <= base.length) return base.slice(0, n);
  // If we need more, interpolate in HSL across 0..n-1
  const cols = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    // hue 210°→330°; sat=80%; light=55%
    const h = 210 + (330 - 210) * t;
    cols.push(`hsl(${h} 80% 55%)`);
  }
  return cols;
}

function paintSliderGradient(slider, colors) {
  if (!slider || !colors?.length) return;
  const n = colors.length;
  const stops = [];
  for (let i = 0; i < n; i++) {
    const p1 = (i / n) * 100;
    const p2 = ((i + 1) / n) * 100;
    stops.push(`${colors[i]} ${p1}%`, `${colors[i]} ${p2}%`);
  }
  slider.style.background = `linear-gradient(to right, ${stops.join(',')})`;
  slider.style.height = slider.style.height || '6px'; // make the band visible if the UA renders it thin
}

function paintTickDots(container, dates, colors) {
  if (!container) return;
  const dots = Array.from(container.children);
  const n = Math.min(dots.length, dates?.length || 0, colors?.length || 0);
  for (let i = 0; i < n; i++) {
    const dot = dots[i];
    dot.style.background = colors[i];
    dot.title = dates[i]; // hover shows the quantized date
    dot.style.boxShadow = '0 0 0 1px rgba(0,0,0,.2) inset';
  }
  // Dark theme tweak
  if (document.body.classList.contains('dark-theme')) {
    dots.forEach(d => d.style.boxShadow = '0 0 0 1px rgba(255,255,255,.25) inset');
  }
}

// After a Markmap render/update, paint links/connectors/labels with era colors.
// We infer the taxon id from the label's <a class="taxon-link" href=".../taxa/ID">.
function paintMarkmapByEra(svg, state = cpTimelineState) {
  if (!svg || !state?.colors?.length || !state.eraIndexByTaxonId) return;

  // Build data-path → color map by scanning node labels
  const colorByPath = new Map();
  svg.querySelectorAll('g.markmap-node').forEach(g => {
    const f = g.querySelector('foreignObject');
    if (!f) return;
    const a = f.querySelector('a.taxon-link[href*="/taxa/"]');
    if (!a) return;
    const m = a.getAttribute('href').match(/\/taxa\/(\d+)/);
    if (!m) return;
    const tid = Number(m[1]);
    const eraIdx = state.eraIndexByTaxonId[tid];
    if (eraIdx == null) return;
    const color = state.colors[eraIdx];
    if (!color) return;

    // Remember for the curved link
    const key = g.getAttribute('data-path');
    if (key) colorByPath.set(key, color);

    // Color the short connector + label
    const line = g.querySelector('line');
    if (line) { line.setAttribute('stroke', color); line.style.stroke = color; }
    // Brighten the label text (HTML labels): color only the anchor so badges stay readable
    try { a.style.color = color; } catch (_) {}
  });

  // Paint the curved links (edges)
  svg.querySelectorAll('path.markmap-link').forEach(path => {
    let key = path.getAttribute('data-path');
    if (!key && path.__data__?.target?.path) key = path.__data__.target.path;
    const color = key && colorByPath.get(key);
    if (!color) return;
    path.setAttribute('stroke', color);
    path.style.stroke = color;
    path.style.strokeOpacity = '1';
    path.style.fill = 'none';
  });
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// ===== Simple local cache (LRU in localStorage) =====
const CP_CACHE_INDEX_KEY = 'cp_cache_index_v1';
const CP_CACHE_PREFIX = 'cp_cache_v1:';
const CP_CACHE_MAX = 50; // max cached trees
const CP_CACHE_BYTES_MAX = 4 * 1024 * 1024; // ~4MB budget

function cpCacheKeyForCheckpoint(cpId, taxonId, userLogin, thresholdIso) {
  return `${CP_CACHE_PREFIX}user:${userLogin}:taxon:${taxonId}:checkpoint:${cpId}${thresholdIso ? `:threshold:${thresholdIso}` : ''}`;
}
function cpCacheKeyForDate(taxonId, userLogin, isoDate) {
  return `${CP_CACHE_PREFIX}user:${userLogin}:taxon:${taxonId}:date:${isoDate}`;
}
function cpCacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    // move to front of index
    const idx = JSON.parse(localStorage.getItem(CP_CACHE_INDEX_KEY) || '[]').filter(k => k !== key);
    idx.unshift(key);
    localStorage.setItem(CP_CACHE_INDEX_KEY, JSON.stringify(idx.slice(0, CP_CACHE_MAX)));
    return obj?.markdown || null;
  } catch { return null; }
}
function cpCacheSet(key, markdown) {
  try {
    localStorage.setItem(key, JSON.stringify({ markdown, ts: Date.now() }));
    let idx = JSON.parse(localStorage.getItem(CP_CACHE_INDEX_KEY) || '[]').filter(k => k !== key);
    idx.unshift(key);
    // evict overflow by count first
    while (idx.length > CP_CACHE_MAX) {
      const evict = idx.pop();
      try { localStorage.removeItem(evict); } catch {}
    }
    // evict overflow by approximate byte size
    const sizeOf = k => {
      try { const v = localStorage.getItem(k); return v ? v.length : 0; } catch { return 0; }
    };
    let total = 0;
    for (const k of idx) total += sizeOf(k);
    while (total > CP_CACHE_BYTES_MAX && idx.length > 0) {
      const evict = idx.pop();
      try { const len = sizeOf(evict); localStorage.removeItem(evict); total -= len; } catch {}
    }
    localStorage.setItem(CP_CACHE_INDEX_KEY, JSON.stringify(idx));
  } catch {}
}

// ===== Checkpoint tabs (like Explore) =====
function ensureCpTab(tabId, title) {
  const tabs = document.getElementById('cpTreeTabs');
  const content = document.getElementById('cpTreeTabContent');
  let link = document.getElementById(`${tabId}-tab`);
  let pane = document.getElementById(`${tabId}-content`);
  if (!link) {
    const li = document.createElement('li');
    li.className = 'nav-item';
    li.innerHTML = `
      <a class="nav-link" id="${tabId}-tab" data-bs-toggle="tab" href="#${tabId}-content" role="tab" aria-controls="${tabId}-content" aria-selected="false">
        <span class="tab-title">${title}</span>
      </a>`;
    tabs.appendChild(li);
    link = li.querySelector('a');
  }
  if (!pane) {
    pane = document.createElement('div');
    pane.className = 'tab-pane fade';
    pane.id = `${tabId}-content`;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', `${tabId}-tab`);
    const svgWrap = document.createElement('div');
    svgWrap.className = 'markmap-container';
    svgWrap.innerHTML = `<svg id="${tabId}-svg" style="width:100%; height:700px;"></svg>`;
    pane.appendChild(svgWrap);
    content.appendChild(pane);
  }
  // update title if changed
  try { link.querySelector('.tab-title').textContent = title; } catch {}
  
  // Resolve taxon name if missing or generic
  const span = link.querySelector('.tab-title');
  if (span && /^Taxon \d+$/.test(title)) {
    const id = Number(title.replace('Taxon ', '')) || null;
    if (id) resolveTaxonTitle(id).then(n => { span.textContent = n; });
  }
  
  // activate
  try { new bootstrap.Tab(link).show(); } catch {}
  currentCpTabId = tabId;
  return document.getElementById(`${tabId}-svg`);
}
function renderMarkdownToTab(tabId, markdown) {
  const svg = document.getElementById(`${tabId}-svg`);
  if (!svg) return;
  const { Transformer, Markmap } = window.markmap || {};
  if (!Transformer || !Markmap) return;
  const transformer = new Transformer();
  const { root } = transformer.transform(markdown);
  try {
    if (cpMarkmaps[tabId]) {
      // Smooth update of existing tree (grow/shrink branches)
      cpMarkmaps[tabId].setData(root);
    } else {
      svg.innerHTML = '';
      cpMarkmaps[tabId] = Markmap.create(svg, {
        htmlLabels: true,
        duration: 500,
        autoFit: true,
        fitRatio: 0.98,
        initialExpandLevel: -1,
        pan: true,
        zoom: true,
        scrollForPan: false
      }, root);
    }
  } catch (_) {
    // Fallback to full re-render if update fails
    svg.innerHTML = '';
    cpMarkmaps[tabId] = Markmap.create(svg, null, root);
  }

  // Defer paint until Markmap has laid out nodes & links
  setTimeout(() => {
    try { paintMarkmapByEra(svg, cpTimelineState); } catch(_) {}
  }, 120);

  // Re-apply after user expands/collapses
  svg.addEventListener('click', () => {
    setTimeout(() => {
      try { paintMarkmapByEra(svg, cpTimelineState); } catch(_) {}
    }, 120);
  }, { passive: true });
}

async function fetchCheckpoints(userLogin) {
  const url = new URL(listUrl);
  url.searchParams.set('user_login', userLogin);
  url.searchParams.set('include', 'full');
  const r = await fetch(url, { headers: { ...getAuthHeaders() }});
  if (!r.ok) throw new Error('Failed to list checkpoints');
  const data = await r.json();
  return data.checkpoints || [];
}

function groupByTaxon(checkpoints) {
  const map = new Map();
  for (const cp of checkpoints) {
    const key = String(cp.taxon_id);
    if (!map.has(key)) map.set(key, { taxonId: cp.taxon_id, taxonName: cp.taxon_name || `Taxon ${cp.taxon_id}`, items: [] });
    map.get(key).items.push(cp);
  }
  for (const g of map.values()) {
    g.items.sort((a,b) => (a.created_at < b.created_at ? -1 : 1));
  }
  return Array.from(map.values()).sort((a,b) => a.taxonName.localeCompare(b.taxonName));
}

function renderTaxaList(groups) {
  const list = document.getElementById('checkpointTaxaList');
  list.innerHTML = '';
  for (const g of groups) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';

    const label = document.createElement('span');
    label.className = 'js-taxon-label';
    label.textContent = g.taxonName;
    btn.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'badge bg-secondary rounded-pill';
    badge.textContent = g.items.length;
    btn.appendChild(badge);

    btn.addEventListener('click', () => selectTaxonGroup(g));
    list.appendChild(btn);
  }
}

function selectTaxonGroup(group) {
  window.__cpSelectedGroup = group;
  const title = document.getElementById('checkpointSelectedTitle');
  title.textContent = `${group.taxonName} — ${group.items.length} timelines`;
  // If the name is still "Taxon ####", resolve it and update header and group
  if (/^Taxon \d+$/.test(group.taxonName)) {
    resolveTaxonTitle(group.taxonId).then(name => {
      group.taxonName = name;
      const head = document.getElementById('checkpointSelectedTitle');
      if (head) head.textContent = `${name} — ${group.items.length} timelines`;
    }).catch(() => {});
  }
  const cpSlider = document.getElementById('checkpointSlider');
  cpSlider.disabled = false;
  cpSlider.min = 0;
  cpSlider.max = Math.max(0, group.items.length - 1);
  cpSlider.value = cpSlider.max;
  cpSlider.step = 1;
  document.getElementById('checkpointStart').textContent = fmtDate(group.items[0]?.created_at);
  document.getElementById('checkpointEnd').textContent = fmtDate(group.items[group.items.length - 1]?.created_at);
  document.getElementById('requeryCompareBtn').disabled = false;
  renderCheckpointSummary(group, Number(cpSlider.value));
  // Immediately render the selected checkpoint tree
  renderCheckpointTree(group, Number(cpSlider.value)).catch(console.error);
  // Initialize real-date timeline for this taxon as well (after base tab exists)
  initTimelineForTaxon(group.taxonId, group.taxonName || `Taxon ${group.taxonId}`).catch(console.error);
  // Ensure the visualization card is visible alongside the timeline
  try {
    const cpCard = document.getElementById('cpResultsCard');
    if (cpCard) {
      cpCard.style.display = 'block';
      try { cpCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch(_) {}
    }
  } catch (_) {}
  // Slider events for timeline are handled by initTimelineForTaxon (quantized dates)
  document.getElementById('requeryCompareBtn').onclick = async () => {
    const sel = group.items[Number(cpSlider.value)];
    const btn = document.getElementById('requeryCompareBtn');
    const spn = document.getElementById('requerySpinner');
    btn.disabled = true; if (spn) spn.classList.remove('d-none');
    
    // Restore date filters from checkpoint if they exist
    if (sel.filters) {
      const obsStart = document.getElementById('obsStart');
      const obsEnd = document.getElementById('obsEnd');
      if (obsStart && sel.filters.observed_d1) obsStart.value = sel.filters.observed_d1;
      if (obsEnd && sel.filters.observed_d2) obsEnd.value = sel.filters.observed_d2;
    }
    
    // For now, just refetch build-taxonomy to show current state
    const payload = {
      username: localStorage.getItem('inat_username') || '',
      taxonId: group.taxonId
    };
    const r = await fetch(`${API_BASE}/build-taxonomy`, { method:'POST', headers: { 'Content-Type':'application/json', ...getAuthHeaders() }, body: JSON.stringify(payload) });
    const res = await r.json();
    const newest = new Set((res.speciesTaxonIds || []));
    const previous = JSON.parse(sel.species_ids_json || '[]');
    const prevSet = new Set(previous);
    const added = Array.from(newest).filter(id => !prevSet.has(id));
    const div = document.getElementById('checkpointSummary');
    div.innerHTML = `<div class="alert alert-info">Compared to ${fmtDate(sel.created_at)}: +${added.length} species</div>`;
    btn.disabled = false; if (spn) spn.classList.add('d-none');
  };
}

// ===== Timeline (real dates) =====
function daysBetween(a, b) {
  const d1 = new Date(a + 'T00:00:00Z');
  const d2 = new Date(b + 'T00:00:00Z');
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}
function dateAdd(base, days) {
  const d = new Date(base + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const dd = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function buildDateArray(minDate, maxDate) {
  const n = daysBetween(minDate, maxDate);
  const arr = [];
  for (let i = 0; i <= n; i++) arr.push(dateAdd(minDate, i));
  return arr;
}
function buildQuantizedDates(minDate, maxDate, count) {
  const totalDays = Math.max(0, daysBetween(minDate, maxDate));
  const steps = Math.max(1, count - 1);
  const step = Math.max(1, Math.floor(totalDays / steps));
  const dates = [];
  for (let i = 0; i <= steps; i++) {
    dates.push(dateAdd(minDate, Math.min(totalDays, i * step)));
  }
  // ensure max included
  if (dates[dates.length - 1] !== maxDate) dates[dates.length - 1] = maxDate;
  return dates;
}
function nearestPrecachedDate(taxonId, targetIso) {
  const list = preCacheDatesByTaxon[taxonId] || [];
  if (!list.length) return targetIso;
  const t = new Date(targetIso).getTime();
  let best = list[0], bestDiff = Math.abs(new Date(best).getTime() - t);
  for (let i = 1; i < list.length; i++) {
    const d = Math.abs(new Date(list[i]).getTime() - t);
    if (d < bestDiff) { best = list[i]; bestDiff = d; }
  }
  return best;
}
async function ensurePreCachedDates(username, taxonId) {
  const list = preCacheDatesByTaxon[taxonId] || [];
  for (const iso of list) {
    const key = cpCacheKeyForDate(taxonId, username, iso);
    if (cpCacheGet(key)) continue;
    const inflightKey = `${taxonId}:${iso}`;
    if (preCacheInFlight[inflightKey]) continue;
    preCacheInFlight[inflightKey] = fetch(`${API_BASE}/timeline/tree-at-date`, {
      method: 'POST', headers: { 'Content-Type':'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ username, taxonId, date: iso })
    }).then(r => r.json()).then(data => { if (data?.markdown) cpCacheSet(key, data.markdown); }).catch(() => {})
      .finally(() => { delete preCacheInFlight[inflightKey]; });
  }
}
function setSliderEnabled(enabled, min=0, max=0, value=0) {
  const cpSlider = document.getElementById('checkpointSlider');
  cpSlider.disabled = !enabled;
  cpSlider.min = String(min);
  cpSlider.max = String(max);
  cpSlider.value = String(value);
}

async function initTimelineForTaxon(taxonId, taxonName) {
  currentTaxonId = Number(taxonId);
  const card = document.getElementById('cpResultsCard');
  if (card) card.style.display = 'block';
  const head = document.getElementById('checkpointSelectedTitle');
  if (head) head.textContent = `${taxonName || ('Taxon ' + taxonId)} — Date Timeline`;

  if (!CURRENT_USER) {
    setSliderEnabled(false);
    document.getElementById('checkpointSummary').textContent = 'Connect your iNaturalist account to build a date timeline.';
    return;
  }

  const params = new URLSearchParams({ user_login: CURRENT_USER, taxon_id: String(currentTaxonId) });
  const r = await fetch(`${API_BASE}/timeline/date-range?${params}`, { headers: { ...getAuthHeaders() } });
  const range = await r.json();

  if (!range.minDate || !range.maxDate) {
    setSliderEnabled(false);
    document.getElementById('checkpointStart').textContent = '';
    document.getElementById('checkpointEnd').textContent = '';
    document.getElementById('checkpointSummary').innerHTML = `<em>No timeline index yet for this taxon.</em> <button id="buildTimelineBtn" class="btn btn-sm btn-primary ms-2">Build Timeline</button>`;
    const btn = document.getElementById('buildTimelineBtn');
    if (btn) btn.onclick = async () => { await buildTimelineIndex(); await initTimelineForTaxon(currentTaxonId, taxonName); };
    return;
  }

  currentDates = buildDateArray(range.minDate, range.maxDate);
  document.getElementById('checkpointStart').textContent = range.minDate;
  document.getElementById('checkpointEnd').textContent = range.maxDate;

  // Build quantized pre-cache dates and prefetch in background
  preCacheDatesByTaxon[taxonId] = buildQuantizedDates(range.minDate, range.maxDate, PRE_CACHE_COUNT);
  // Switch slider to quantized positions (0..N-1)
  const qDates = preCacheDatesByTaxon[taxonId];
  setSliderEnabled(true, 0, qDates.length - 1, qDates.length - 1);
  try { const cur = document.getElementById('checkpointCurrent'); if (cur) cur.textContent = qDates[qDates.length - 1]; } catch(_) {}
  // Render tick bubbles
  const ticks = document.getElementById('checkpointTicks');
  if (ticks) {
    ticks.innerHTML = '';
    const dates = preCacheDatesByTaxon[taxonId];
    for (let i = 0; i < dates.length; i++) {
      const dot = document.createElement('div');
      dot.className = 'text-muted';
      dot.style.width = '8px';
      dot.style.height = '8px';
      dot.style.borderRadius = '50%';
      ticks.appendChild(dot);
    }
  }
  // Build + apply the color system for this taxon's timeline
  const palette = buildTimelinePalette(qDates.length);
  const sliderEl = document.getElementById('checkpointSlider');
  paintSliderGradient(sliderEl, palette);
  paintTickDots(ticks, qDates, palette);

  // Fetch/cache first-seen map (species taxon id → ISO date)
  const cacheKey = `${CURRENT_USER}:${taxonId}`;
  let firstSeenMap = firstSeenCacheByTaxon[cacheKey];
  if (!firstSeenMap) {
    try {
      const tResp = await fetch(firstSeenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ username: CURRENT_USER, taxonId })
      });
      const tData = await tResp.json();
      if (tResp.ok && tData && tData.firstSeen) {
        firstSeenMap = tData.firstSeen; // { [speciesTaxonId]: 'YYYY-MM-DD' }
        firstSeenCacheByTaxon[cacheKey] = firstSeenMap;
      } else {
        firstSeenMap = {};
      }
    } catch (_) { firstSeenMap = {}; }
  }

  // Map each species → era index (which quantized bucket it lands in)
  const eraIndexByTaxonId = {};
  const dateToIdx = (d) => {
    if (!d) return 0;
    // find the first quantized date >= d
    for (let i = 0; i < qDates.length; i++) if (d <= qDates[i]) return i;
    return qDates.length - 1;
  };
  for (const [tid, iso] of Object.entries(firstSeenMap)) {
    eraIndexByTaxonId[Number(tid)] = dateToIdx(iso);
  }

  // Save state so the Markmap painter can use it for every render/update
  cpTimelineState = { taxonId: Number(taxonId), dates: qDates, colors: palette, eraIndexByTaxonId };

  ensurePreCachedDates(CURRENT_USER, taxonId);

  // Render latest using pre-cached if available (or fetch once if missing)
  const latest = qDates[qDates.length - 1];
  const cached = cpCacheGet(cpCacheKeyForDate(taxonId, CURRENT_USER, latest));
  if (cached && currentCpTabId) {
    renderMarkdownToTab(currentCpTabId, cached);
  } else {
    await drawTreeAtDate(latest);
  }

  const handleSliderInput = (e) => {
    const idx = Number(e.target.value);
    const snapped = (preCacheDatesByTaxon[taxonId] || [])[idx];
    if (!snapped) return;
    try { const cur = document.getElementById('checkpointCurrent'); if (cur) cur.textContent = snapped; } catch(_) {}
    const cached = cpCacheGet(cpCacheKeyForDate(taxonId, CURRENT_USER, snapped));
    if (cached && currentCpTabId) {
      renderMarkdownToTab(currentCpTabId, cached);
    }
    // opportunistically continue prefetching in background
    ensurePreCachedDates(CURRENT_USER, taxonId);
  };
  // Bind cross-browser events
  sliderEl.oninput = handleSliderInput;
  sliderEl.addEventListener('change', handleSliderInput);
}

async function drawTreeAtDate(isoDate) {
  if (!CURRENT_USER || !currentTaxonId) return;
  const sum = document.getElementById('checkpointSummary');
  if (sum) sum.textContent = `Showing observations on or before ${isoDate}`;
  const cpLoad = document.getElementById('cpLoading');
  if (cpLoad) cpLoad.style.display = 'flex';
  const r = await fetch(`${API_BASE}/timeline/tree-at-date`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ username: CURRENT_USER, taxonId: currentTaxonId, date: isoDate })
  });
  const data = await r.json();
  if (!r.ok || !data?.markdown) { console.error('tree-at-date error', data); return; }
  const pre = document.getElementById('cpMarkdownResult');
  try {
    const plain = data.plainMarkdown || String(data.markdown).replace(/<a[^>]*class=\"taxon-link\"[^>]*>(.*?)<\/a>/gi,'$1').replace(/<span[^>]*>.*?<\/span>/gi,'').replace(/<[^>]+>/g,'').replace(/\s+$/gm,'');
    if (pre) pre.textContent = plain;
  } catch(_) { if (pre) pre.textContent = data.markdown; }
  const tabId = currentCpTabId || `cp-live-${currentTaxonId}`;
  if (!currentCpTabId) ensureCpTab(tabId, 'Timeline');
  renderMarkdownToTab(tabId, data.markdown);
  // cache
  cpCacheSet(cpCacheKeyForDate(currentTaxonId, CURRENT_USER, isoDate), data.markdown);
  if (cpLoad) cpLoad.style.display = 'none';
}

async function buildTimelineIndex() {
  if (!CURRENT_USER || !currentTaxonId) return;
  const btn = document.getElementById('buildTimelineBtn') || document.getElementById('requeryCompareBtn');
  const spinner = document.getElementById('requerySpinner');
  if (btn && spinner) spinner.classList.remove('d-none');
  try {
    const r = await fetch(`${API_BASE}/timeline/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ username: CURRENT_USER, taxonId: currentTaxonId })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'Indexing failed');
  } finally {
    if (btn && spinner) spinner.classList.add('d-none');
  }
}

async function renderCheckpointTree(group, idx) {
  const sel = group.items[idx];
  if (!sel) return;
  const username = localStorage.getItem('inat_username') || '';
  const species = JSON.parse(sel.species_ids_json || '[]');
  // If the slider has a data-date threshold, filter by first-seen timeline
  const cpSlider = document.getElementById('checkpointSlider');
  const threshold = cpSlider && cpSlider.dataset && cpSlider.dataset.thresholdDate ? cpSlider.dataset.thresholdDate : null;
  let filtered = species;
  if (threshold) {
    try {
      const key = `${username}:${group.taxonId}`;
      let firstSeenMap = firstSeenCacheByTaxon[key];
      if (!firstSeenMap) {
        const cpLoad = document.getElementById('cpLoading');
        if (cpLoad) cpLoad.style.display = 'flex';
        const tResp = await fetch(firstSeenUrl, { method:'POST', headers: { 'Content-Type':'application/json', ...getAuthHeaders() }, body: JSON.stringify({ username, taxonId: group.taxonId }) });
        const tData = await tResp.json();
        if (tResp.ok && tData && tData.firstSeen) {
          firstSeenMap = tData.firstSeen;
          firstSeenCacheByTaxon[key] = firstSeenMap;
        }
        if (cpLoad) cpLoad.style.display = 'none';
      }
      if (firstSeenMap) {
        filtered = species.filter(id => {
          const d = firstSeenMap[id];
          return !d || d <= threshold;
        });
      }
    } catch (e) { console.warn('timeline first-seen fetch failed', e); }
  }
  // Tab per checkpoint (plus date threshold in title when used)
  const cp = group.items[idx];
  const tabTitle = cp.taxon_name || group.taxonName || `Taxon ${group.taxonId}`;
  const tabId = `cp-${group.taxonId}-${cp.id}`;
  ensureCpTab(tabId, tabTitle);
  // Cache check first
  const cachedKey = cpCacheKeyForCheckpoint(cp.id, group.taxonId, username, threshold);
  const cached = cpCacheGet(cachedKey);
  if (cached) {
    renderMarkdownToTab(tabId, cached);
    const pre = document.getElementById('cpMarkdownResult');
    if (pre) pre.textContent = cached;
    return;
  }
  const r = await fetch(treeFromSpeciesUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ speciesTaxonIds: filtered, baseTaxonId: group.taxonId })
  });
  const data = await r.json();
  if (!r.ok) return;
  const markdown = data.markdown || '';
  // Render directly in the Checkpoints pane SVG so it's visible on that tab
  try {
    renderMarkdownToTab(tabId, markdown);
    const pre = document.getElementById('cpMarkdownResult');
    try {
      const plain = data.plainMarkdown || String(markdown).replace(/<a[^>]*class=\"taxon-link\"[^>]*>(.*?)<\/a>/gi,'$1').replace(/<span[^>]*>.*?<\/span>/gi,'').replace(/<[^>]+>/g,'').replace(/\s+$/gm,'');
      if (pre) pre.textContent = plain;
    } catch(_) { if (pre) pre.textContent = markdown; }
    cpCacheSet(cachedKey, markdown);
  } catch (e) { console.error('checkpoint markmap render', e); }
}

function renderCheckpointSummary(group, idx) {
  const sel = group.items[idx];
  const div = document.getElementById('checkpointSummary');
  div.innerHTML = `
    <div>
      <div><strong>Date:</strong> ${fmtDate(sel.created_at)}</div>
      <div><strong>Taxon ID:</strong> ${group.taxonId}</div>
    </div>
  `;
}

async function initCheckpointsUI() {
  if (!CURRENT_USER) {
    try {
      const u = await fetchCurrentUser();
      if (u?.login) {
        CURRENT_USER = u.login;
        localStorage.setItem('inat_username', CURRENT_USER);
      }
    } catch {}
  }
  
  // Rename the card header from "Saved Checkpoints" → "Saved Timelines" (handles common markup)
  const header =
    document.querySelector('#cpResultsCard .card-header .card-title') ||
    document.querySelector('#cpResultsCard .card-header h5') ||
    document.querySelector('#cpResultsCard .card-title');
  if (header) header.textContent = 'Saved Timelines';
  
  const btn = document.getElementById('saveCheckpointBtn');
  if (btn) {
    // Front-facing label
    btn.textContent = 'Save Timeline';
    btn.addEventListener('click', async () => {
      const payload = window.__lastBuild;
      if (!payload || !payload.taxonId) {
        alert('Build a tree first before saving a timeline.');
        return;
      }
      const spinner = document.getElementById('saveCpSpinner');
      try { if (spinner) spinner.classList.remove('d-none'); btn.disabled = true; } catch(_) {}
      const username = localStorage.getItem('inat_username') || (await fetchCurrentUser())?.login;
      const r = await fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          username,
          taxonId:   payload.taxonId,
          taxonName: payload.taxonName,
          speciesTaxonIds: payload.speciesTaxonIds || [],
          rankCounts:      payload.rankCounts || {},
          highWatermarkUpdatedAt: payload.highWatermarkUpdatedAt || null,
          filters: {
            observed_d1: document.getElementById('obsStart')?.value || null,
            observed_d2: document.getElementById('obsEnd')?.value   || null
          }
        })
      });
      if (!r.ok) {
        const t = await r.text();
        alert('Failed to save timeline: ' + t);
        return;
      }
      await loadAndRenderList();
      alert('Timeline saved.');
      try { if (spinner) spinner.classList.add('d-none'); btn.disabled = false; } catch(_) {}
    });
  }
  await loadAndRenderList();
  // Hook up cp clear button
  const cpClearBtn = document.getElementById('cpClearBtn');
  if (cpClearBtn) {
    // Front-facing label
    cpClearBtn.textContent = 'Delete Timeline';
    cpClearBtn.addEventListener('click', async () => {
      const group = window.__cpSelectedGroup;
      const slider = document.getElementById('checkpointSlider');
      const idx = Number(slider?.value || 0);
      const cp = group?.items?.[idx];
      if (!cp) return;
      if (!confirm('Delete this timeline?')) return;
      const r = await fetch(deleteUrl, { method:'POST', headers:{ 'Content-Type':'application/json', ...getAuthHeaders() }, body: JSON.stringify({ id: cp.id }) });
      if (r.ok) {
        await loadAndRenderList();
        const card = document.getElementById('cpResultsCard');
        if (card) card.style.display = 'none';
      }
    });
  }
}

async function loadAndRenderList() {
  const username = localStorage.getItem('inat_username') || '';
  const token = localStorage.getItem('inat_token') || '';
  if (!username || !token) return;  // avoid 403 until signed in properly

  const cps    = await fetchCheckpoints(username);
  const groups = groupByTaxon(cps);

  // Initial fast render (may include "Taxon ####")
  renderTaxaList(groups);

  // Resolve any generic names, then re-render the list once
  const need = groups.filter(g => /^Taxon \d+$/.test(g.taxonName));
  if (need.length) {
    Promise.allSettled(
      need.map(async g => {
        const name = await resolveTaxonTitle(g.taxonId);
        g.taxonName = name;
      })
    ).then(() => {
      // Re-render with resolved scientific names
      renderTaxaList(groups);

      // If the currently selected group was generic, update the header too
      if (window.__cpSelectedGroup) {
        const cur = groups.find(x => x.taxonId === window.__cpSelectedGroup.taxonId);
        if (cur) {
          window.__cpSelectedGroup = cur;
          const head = document.getElementById('checkpointSelectedTitle');
          if (head) head.textContent = `${cur.taxonName} — ${cur.items.length} timelines`;
        }
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Optional: sweep any remaining static HTML text nodes
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const swaps = [
    [/\bCheckpoints\b/g, 'Timelines'],
    [/\bcheckpoints\b/g, 'timelines'],
    [/\bCheckpoint\b/g,  'Timeline'],
    [/\bcheckpoint\b/g,  'timeline'],
  ];
  let n; while ((n = w.nextNode())) {
    let t = n.nodeValue; if (!t) continue;
    swaps.forEach(([re, to]) => { t = t.replace(re, to); });
    if (t !== n.nodeValue) n.nodeValue = t;
  }
  
  initCheckpointsUI().catch(err => console.error('init checkpoints ui', err));
});


