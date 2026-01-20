// tree-manager.js

// ----- API Configuration -----
const API_BASE = (window.API_BASE
  || localStorage.getItem('apiBase')
  || 'https://inat-trees-worker.intrinsic3141.workers.dev'
).replace(/\/+$/,'');

// ----- Canonical rank mapping (fine rank -> band) -----
const RANK_BAND = Object.freeze({
  // very high
  stateofmatter: 'state',

  // kingdom tier
  domain: 'kingdom', superkingdom: 'kingdom', kingdom: 'kingdom',

  // phylum tier
  phylum: 'phylum', subphylum: 'phylum',

  // class tier
  superclass: 'class', class: 'class', subclass: 'class', subterclass: 'class', infraclass: 'class',

  // order tier
  superorder: 'order', order: 'order', suborder: 'order', infraorder: 'order', parvorder: 'order',
  zoosection: 'order', zoosubsection: 'order',

  // family tier
  superfamily: 'family', epifamily: 'family', family: 'family', subfamily: 'family',

  // tribe tier (optional band between family and genus)
  supertribe: 'tribe', tribe: 'tribe', subtribe: 'tribe',

  // genus tier
  genus: 'genus', genushybrid: 'genus', subgenus: 'genus', section: 'genus', subsection: 'genus',

  // species tier
  complex: 'species', species: 'species', hybrid: 'species', infrahybrid: 'species',
  subspecies: 'species', variety: 'species', form: 'species'
});

// ----- Colors by band (reuse your palette; add a tribe tint) -----
const BAND_COLOR = Object.freeze({
  state:   '#64748b',   // stateofmatter
  kingdom: '#a855f7',   // kingdom/domain/superkingdom
  phylum:  '#ef4444',   // phylum/subphylum
  class:   '#f59e0b',   // class/sub-/infra-/subterclass/superclass
  order:   '#6366f1',   // order family of ranks incl. zoo(section)s
  family:  '#06b6d4',   // super/epi/family/subfamily
  tribe:   '#0ea5e9',   // super/tribe/subtribe (between family & genus)
  genus:   '#10b981',   // genus/genushybrid/subgenus/section/subsection
  species: '#22c55e'    // complex/species/*infraspecific*
});

// Convert a fine rank to a color (falls back to band name already)
function colorForRank(rank) {
  if (!rank) return null;
  const r = String(rank).toLowerCase();
  const band = RANK_BAND[r] || r;       // if already a band like "family"
  return BAND_COLOR[band] || null;
}

// ---- Bands & helpers -------------------------------------------------------
const GENUS_BAND = new Set(['genus','genushybrid','subgenus','section','subsection']);
const SPECIES_BAND = new Set(['complex','species','hybrid','infrahybrid','subspecies','variety','form']);

const BAND_ORDER = ['state','kingdom','phylum','class','order','family','tribe','genus','species'];
const BAND_INDEX = BAND_ORDER.reduce((m,b,i)=> (m[b]=i,m), {});

function bandOf(rank){
  const r = String(rank||'').toLowerCase();
  return RANK_BAND[r] || r; // if already a band (e.g. 'family')
}

function parseAncestors(a){
  if (!a) return [];
  if (Array.isArray(a)) return a.map(Number).filter(n=>Number.isFinite(n));
  // "{1,2,3}" → [1,2,3]
  const m = String(a).match(/\{([^}]*)\}/);
  if (!m) return [];
  return m[1].split(',').map(s=>parseInt(s.trim(),10)).filter(n=>Number.isFinite(n));
}

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

// ---- Markmap mini-map + scroll gutters (global styles) ----
(() => {
  if (document.getElementById('mm-ux-styles')) return;
  const s = document.createElement('style');
  s.id = 'mm-ux-styles';
  s.textContent = `
    :root{
      --mm-minimap-w: 180px;
      --mm-minimap-h: 120px;
      /* canvas height you prefer overall; page CSS can override if needed */
      --mm-canvas-h: clamp(420px, 62vh, 900px);
    }

    /* Markmap window frame */
    .markmap-container{
      position: relative;
      border: 1px solid rgba(0,0,0,.12);
      border-radius: 12px;
      background: #ffffff;
      overflow: hidden;
      box-shadow: 0 2px 12px rgba(0,0,0,.06);
      /* NEW: only keep a small ledge equal to minimap height + 6px */
      padding-bottom: calc(var(--mm-minimap-h) + 6px);
      /* NEW: kill any page-level fixed heights */
      height: auto !important;
      min-height: clamp(420px, 50vh, 900px);
    }
    body.dark-theme .markmap-container{
      background: #111827;
      border-color: #3a3f42;
      box-shadow: 0 2px 12px rgba(0,0,0,.35);
    }

    /* Mini-map box now uses vars */
    .mm-minimap {
      position: absolute; right: 12px; bottom: 12px;
      width: var(--mm-minimap-w); height: var(--mm-minimap-h);
      border-radius: 10px;
      background: rgba(255,255,255,.82);
      border: 1px solid rgba(0,0,0,.15);
      box-shadow: 0 8px 24px rgba(0,0,0,.25);
      z-index: 5;
      pointer-events: none;
    }
    body.dark-theme .mm-minimap {
      background: rgba(0,0,0,.52);
      border-color: rgba(255,255,255,.22);
    }
    .mm-minimap.hidden { display: none; }

    /* Mini-map link + connector strokes */
    .mm-minimap .mm-mini-links path,
    .mm-minimap .mm-mini-links line,
    .mm-minimap .mm-mini-conns line {
      vector-effect: non-scaling-stroke;
      stroke-width: .9;
      stroke: #6b7280;
      stroke-opacity: .65;
      fill: none;
    }
    body.dark-theme .mm-minimap .mm-mini-links path,
    body.dark-theme .mm-minimap .mm-mini-links line,
    body.dark-theme .mm-minimap .mm-mini-conns line {
      stroke: #a8b1b8;
      stroke-opacity: .75;
    }

    /* Color the mini-map edges to match PVP */
    .mm-minimap .user1-edge { stroke: #dc2626 !important; stroke-opacity: .95; }
    .mm-minimap .user2-edge { stroke: #2563eb !important; stroke-opacity: .95; }
    .mm-minimap .shared-edge { stroke: #9333ea !important; stroke-opacity: .95; }
    /* Checklist: labels + edges */
    .seen-node   { color:#22c55e; font-weight:600; }
    .unseen-node { color:#9ca3af; opacity:.95; }
    .markmap-container svg path.seen-edge   { stroke:#22c55e !important; stroke-opacity:.98; }
    .markmap-container svg path.unseen-edge,
    .markmap-container svg path.missing-edge{ stroke:#9ca3af !important; stroke-opacity:.9; }
    .mm-minimap .seen-edge   { stroke:#22c55e !important; stroke-opacity:.95; }
    .mm-minimap .unseen-edge { stroke:#9ca3af !important; stroke-opacity:.95; }

    /* Hide labels in the mini-map */
    .mm-minimap text, .mm-minimap foreignObject { display: none !important; }

    /* High-visibility live viewport box in the mini-map */
    .mm-minimap .mm-mini-viewport{
      fill: rgba(255, 215, 0, 0.14);    /* soft gold fill */
      stroke: #facc15;                  /* yellow-400 outline */
      stroke-width: 3.5;                /* thicker to track easily */
      stroke-opacity: 1;
      rx: 4; ry: 4;
    }
    body.dark-theme .mm-minimap .mm-mini-viewport{
      stroke: #fde047;                  /* yellow-300 on dark */
      fill: rgba(250, 204, 21, 0.20);
    }

    /* Scroll gutters */
    :root { --mm-scroll-gutter: 36px; }
    @media (min-width: 992px) { :root { --mm-scroll-gutter: 48px; } }
    .mm-scroll-gutter {
      position: absolute; top: 0; bottom: 0; width: var(--mm-scroll-gutter);
      background: transparent; z-index: 8; pointer-events: auto;
    }
    .mm-scroll-gutter.left  { left: 0; }
    .mm-scroll-gutter.right { right: 0; }
    .mm-scroll-gutter.left:hover  { background: linear-gradient(to right, rgba(0,0,0,.06), transparent); }
    .mm-scroll-gutter.right:hover { background: linear-gradient(to left,  rgba(0,0,0,.06), transparent); }
    body.dark-theme .mm-scroll-gutter.left:hover  { background: linear-gradient(to right, rgba(255,255,255,.06), transparent); }
    body.dark-theme .mm-scroll-gutter.right:hover { background: linear-gradient(to left,  rgba(255,255,255,.06), transparent); }

    /* Toolbar is above gutters and offset from the right gutter */
    .mm-toolbar{
      position:absolute; top:8px; right:calc(var(--mm-scroll-gutter) + 8px);
      z-index:50; display:flex; gap:.5rem; align-items:center; pointer-events:auto;
      background:rgba(255,255,255,.9); backdrop-filter:blur(6px);
      border:1px solid rgba(0,0,0,.12); border-radius:10px; padding:6px;
    }
    body.dark-theme .mm-toolbar{
      background:rgba(29,31,32,.9); border-color:#3a3f42;
    }
    .mm-toolbar .form-select.form-select-sm{ padding:.15rem .5rem; height:28px; }
    .mm-toolbar .btn.btn-sm{ height:28px; display:flex; align-items:center; }
    .mm-toolbar .btn,
    .mm-toolbar .form-select { box-shadow: 0 2px 6px rgba(0,0,0,.15); }


    /* Optional: slightly tighter dropdown on the export group */
    .mm-toolbar .dropdown-menu { min-width: 10rem; }

    /* Bluesky composer: dark theme polish */
    body.dark-theme .modal-content{
      background:#1f2937;            /* slate-800 */
      color:#e5e7eb;                  /* slate-200 */
      border-color:#374151;           /* slate-700 */
    }
    body.dark-theme .modal-header,
    body.dark-theme .modal-footer{ border-color:#374151; }

    body.dark-theme .form-label{ color:#e5e7eb; }
    body.dark-theme .form-control{
      background:#111827;             /* slate-900 */
      color:#e5e7eb;
      border-color:#374151;
    }
    body.dark-theme .form-control::placeholder{ color:#9ca3af; } /* slate-400 */
    body.dark-theme .ratio.border{ border-color:#374151 !important; }
    body.dark-theme .btn.btn-light{
      background:#2d333b;
      color:#e5e7eb;
      border-color:#3a3f42;
    }
  `;
  document.head.appendChild(s);
})();


// Helper to convert bullet lists to heading hierarchies
function listToHeadings(md, title) {
  md = String(md || '');
  md = md.replace(/\{\/?color:[^}]*\}/g, ''); // Strip color tokens first

  // Convert <span class="mm-badge mm-rank" ...> into a stable {rank:*} token
  md = md.replace(
    /<span\s+class="mm-badge\s+mm-rank"[^>]*?(?:data-rank="([^"]+)"|title="([^"]+)")[^>]*>[\s\S]*?<\/span>/gi,
    (_, dRank, title) => ` {rank:${(dRank || title || '').toLowerCase()}}`
  );

  // Step 1: Temporarily replace image links with a unique, safe placeholder.
  const placeholders = new Map();
  let placeholderId = 0;
  md = md.replace(/<a\s+href="[^"]+"[^>]*>\s*🖼️\s*<\/a>/gi, (match) => {
    const key = `__IMG_LINK_PLACEHOLDER_${placeholderId++}__`;
    placeholders.set(key, match);
    return key;
  });

  // Step 2: Now, safely strip all OTHER HTML tags.
  // The placeholder is just plain text, so it will survive this step.
  md = md
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1') // Keep text from other links
    .replace(/<[^>]+>/g, '')                 // Strip all remaining tags
    .trim();

  // Step 3: Restore the protected image links from the placeholders.
  for (const [key, value] of placeholders.entries()) {
    md = md.replace(key, value);
  }

  // The rest of the function continues as before, converting the cleaned list to headings.
  const lines = md.split(/\r?\n/);
  const out = [];
  if (title) out.push(`# ${title}`);

  for (const line of lines) {
    const m = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    const level = Math.min(6, 2 + Math.floor(indent / 2));
    const text = m[2].trim();
    out.push(`${'#'.repeat(level)} ${text}`);
  }
  return out.join('\n');
}





class TreeManager {
  constructor(opts = {}) {
    this.trees = [];
    this.currentId = 0;

    // NEW: unique ID prefix so PvP and Explore never collide
    this.idPrefix = opts.idPrefix || 'tree';

    // Containers
    this.resultsCardId       = opts.resultsCardId       || 'resultsCard';
    this.tabsContainer       = document.getElementById(opts.tabsId      || 'treeTabs');
    this.tabContentContainer = document.getElementById(opts.contentId   || 'treeTabContent');
    this.deleteBtnId         = opts.deleteBtnId         || 'deleteAllTrees';

    const delBtn = document.getElementById(this.deleteBtnId);
    if (delBtn) delBtn.addEventListener('click', () => this.clearAllTrees());

    // Render coordination: debounce + in-flight guard
    this._renderTimers = new Map();
    this._renderingNow = new Set();
  }

  _scheduleRender(tree, delay = 50) {
    const key = tree.id;
    if (this._renderTimers.has(key)) clearTimeout(this._renderTimers.get(key));
    this._renderTimers.set(key, setTimeout(() => {
      this._renderTimers.delete(key);
      this._safeRender(tree);
    }, delay));
  }

  _safeRender(tree) {
    if (this._renderingNow.has(tree.id)) {
      __mmdbg?.log && __mmdbg.log('render skipped (in-flight)', { id: tree.id });
      return;
    }
    this._renderingNow.add(tree.id);
    try {
      if (tree.isComparison) this.renderComparisonTree(tree);
      else this.renderTree(tree);
    } finally {
      setTimeout(() => this._renderingNow.delete(tree.id), 120);
    }
  }

  /**
   * Build markdown from flat taxon rows, ensuring species attach under the nearest
   * available GENUS_BAND ancestor (subgenus/section/subsection/genus).
   * Each row should have: { taxon_id, name, rank, parent_id, ancestor_ids }
   * ancestor_ids may be "{...}" or an array.
   */
  _rowsToMarkdown(rows, baseId) {
    // normalize & index
    const nodeById = new Map();
    for (const r of rows || []) {
      if (!r || !r.taxon_id) continue;
      const anc = parseAncestors(r.ancestor_ids).filter(x => x !== 48460); // drop Life
      nodeById.set(+r.taxon_id, {
        id: +r.taxon_id,
        name: String(r.name || `Taxon ${r.taxon_id}`),
        rank: String(r.rank || '').toLowerCase(),
        parent_id: r.parent_id != null ? +r.parent_id : null,
        ancestor_ids: anc
      });
    }
    if (nodeById.size === 0) return '';

    // choose best display parent for a row (uses only ids present in this payload)
    const pickDisplayParent = (row) => {
      // 0) Always keep the explicit parent if it's in the current payload.
      if (row.parent_id && nodeById.has(row.parent_id)) return row.parent_id;

      const anc = Array.isArray(row.ancestor_ids) ? row.ancestor_ids : [];
      const band = (RANK_BAND[row.rank] || row.rank || '').toLowerCase();

      if (band === 'species') {
        // 1) Prefer nearest *species-band* ancestor present (keeps complexes/infraspecific structure)
        for (let i = anc.length - 1; i >= 0; i--) {
          const a = anc[i], ar = nodeById.get(a);
          if (!ar) continue;
          const aBand = (RANK_BAND[ar.rank] || ar.rank || '').toLowerCase();
          if (SPECIES_BAND.has(aBand)) return a;
        }
        // 2) Otherwise, nearest *genus-band* ancestor (puts species under subgenus/genus)
        for (let i = anc.length - 1; i >= 0; i--) {
          const a = anc[i], ar = nodeById.get(a);
          if (!ar) continue;
          const aBand = (RANK_BAND[ar.rank] || ar.rank || '').toLowerCase();
          if (GENUS_BAND.has(aBand)) return a;
        }
      }

      // 3) Fallback: first ancestor in the set
      for (let i = anc.length - 1; i >= 0; i--) if (nodeById.has(anc[i])) return anc[i];
      return null;
    };

    // build parent→children edges
    const children = new Map(); // id -> []
    const roots = new Set(nodeById.keys());
    for (const row of nodeById.values()) {
      const p = pickDisplayParent(row);
      if (p != null && nodeById.has(p)) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(row.id);
        roots.delete(row.id);
      }
    }

    // prefer the requested baseId as the single root when present
    let topIds = Array.from(roots);
    if (baseId && nodeById.has(+baseId)) {
      topIds = [ +baseId ];
    }

    // sort helper: band→order, then alpha by name
    const cmp = (aId, bId) => {
      const a = nodeById.get(aId), b = nodeById.get(bId);
      const ba = BAND_INDEX[bandOf(a.rank)] ?? 999;
      const bb = BAND_INDEX[bandOf(b.rank)] ?? 999;
      if (ba !== bb) return ba - bb;
      return a.name.localeCompare(b.name, undefined, { sensitivity:'base' });
    };

    // DFS emit into bullet markdown; append {rank:*} token for badge injector
    const out = [];
    const emit = (id, depth) => {
      const r = nodeById.get(id); if (!r) return;
      const label = `${r.name} {rank:${r.rank||bandOf(r.rank)||''}}`;
      out.push(`${'  '.repeat(depth)}- ${label}`);
      const kids = (children.get(id) || []).slice().sort(cmp);
      for (const k of kids) emit(k, depth + 1);
    };

    // walk all roots
    topIds.sort(cmp).forEach(id => emit(id, 0));
    return out.join('\n');
  }

  generateTreeId() {
    return `${this.idPrefix}-${++this.currentId}`;
  }

  activateTab(treeId) {
    const link = document.getElementById(`${treeId}-tab`);
    const pane = document.getElementById(`${treeId}-content`);
    if (!link || !pane) return;

    // Deactivate other tabs in THIS manager only
    this.tabsContainer?.querySelectorAll('.nav-link.active')?.forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    this.tabContentContainer?.querySelectorAll('.tab-pane.show.active')?.forEach(p => {
      p.classList.remove('show', 'active');
    });

    // Activate this tab
    if (typeof bootstrap !== 'undefined' && bootstrap.Tab) {
      new bootstrap.Tab(link).show();
    } else {
      link.classList.add('active');
      link.setAttribute('aria-selected', 'true');
      pane.classList.add('show', 'active');
    }

    // Ensure this manager's results card is visible
    const card = document.getElementById(this.resultsCardId);
    if (card) card.style.display = 'block';
  }

  addTree(username, taxonName, taxonId, markdown, opts = {}) {
    const treeId = this.generateTreeId();

    // NEW: if caller passed raw rows, build correct markdown first
    if (!markdown && Array.isArray(opts.rows) && opts.rows.length) {
      try {
        markdown = this._rowsToMarkdown(opts.rows, taxonId);
      } catch (e) {
        console.error('rows→markdown failed:', e);
      }
    }

    // Process markdown to extract statistics if not already provided
    let stats = null;
    try {
      if (window.taxonomyStats && typeof window.taxonomyStats.processMarkdown === 'function') {
        stats = window.taxonomyStats.processMarkdown(markdown || '');
      }
    } catch (error) {
      console.error('Error in TreeManager.addTree calculating statistics:', error);
    }

    const tree = {
      id: treeId,
      username,
      taxonName,
      taxonId,
      markdown: markdown || '',   // <- use the built or provided markdown
      stats,
      isChecklist: opts.mode === 'checklist',
      timestamp: new Date()
    };
    // Persist this tree's markdown for auto-restore (Explore only)
    try {
      if (!opts.mode && window.treeKey && window.cacheTree) {
        const scope  = (window.getLifelistScope?.() || 'global');  // 'global' | 'region'
        const region = window.currentRegionCode || '';
        const k = window.treeKey(String(username), Number(taxonId), scope, region);
        // Fire-and-forget; store markdown (JSON tree optional)
        window.cacheTree(k, null, markdown).catch(()=>{});
      }
    } catch (e) {
      console.warn('IDB cache write failed', e);
    }
    this.trees.push(tree);
    this.createTreeTab(tree);
    this.activateTab(treeId);
    this._scheduleRender(tree, 100);
    
    // Tag new trees with cache info so the ✖ can delete them from IDB
    const scope = (window.getLifelistScope?.() || 'global');
    const region = scope === 'region' ? (window.currentRegionCode || '') : '';
    tree.scope = tree.scope || scope;
    tree.region_code = tree.region_code || region;
    tree.cacheKey = tree.cacheKey || window.treeKey?.(tree.username, tree.taxonId, tree.scope, tree.region_code);

    const tabEl = document.getElementById(`${tree.id}-tab`);
    if (tabEl && tree.cacheKey) {
      tabEl.dataset.cacheKey = tree.cacheKey;
      console.log('[addTree] tagged new tab with cacheKey:', tree.cacheKey);
    }
    
    return treeId;
  }

  reRenderActiveTab() {
    // Find active tab in THIS manager
    let activeTabLink = this.tabsContainer?.querySelector('.nav-link.active');

    // If none, prefer the most recent tree and ACTIVATE it
    if (!activeTabLink && this.trees.length > 0) {
      const last = this.trees[this.trees.length - 1];
      this.activateTab(last.id);
      activeTabLink = document.getElementById(`${last.id}-tab`);
    }
    if (!activeTabLink) return;

    const treeId = activeTabLink.id.replace('-tab', '');
    const tree = this.trees.find(t => t.id === treeId);
    if (!tree) return;

    // Render into the now-active pane (debounced / guarded)
    this._scheduleRender(tree, 50);
  }

  // Add this method to the TreeManager class
  reactivateVisibleTrees() {
    // This method will be called when the main tabs are switched
    // Find all visible tree tabs and re-render them
    const visibleTabs = document.querySelectorAll('.tab-pane.show.active .tab-pane.active');
    visibleTabs.forEach(tab => {
      const treeId = tab.id.replace('-content', '');
      const tree = this.trees.find(t => t.id === treeId);
      if (tree) this._scheduleRender(tree, 80);
    });
  }

  createTreeTab(tree) {
    const tabHeader = document.createElement('li');
    tabHeader.className = 'nav-item';
    tabHeader.innerHTML = `
      <a class="nav-link" id="${tree.id}-tab" data-bs-toggle="tab" href="#${tree.id}-content" role="tab" 
         aria-controls="${tree.id}-content" aria-selected="false">
        <span class="tab-title">${this.formatTabTitle(tree)}</span>
        <button class="btn-close ms-2 btn-close-white text-sm" aria-label="Close" 
                style="font-size: 0.5rem; opacity: 0.5;" data-tree-id="${tree.id}"></button>
      </a>
    `;
    const tabContent = document.createElement('div');
    if (this.trees.length === 1) {
      tabContent.className = 'tab-pane fade show active';
      tabHeader.querySelector('a').setAttribute('aria-selected', 'true');
    } else {
      tabContent.className = 'tab-pane fade';
    }
    tabContent.id = `${tree.id}-content`;
    // expose username for downstream controllers
    tabContent.dataset.username = tree.username;
    tabContent.setAttribute('role', 'tabpanel');
    tabContent.setAttribute('aria-labelledby', `${tree.id}-tab`);
    const svgContainer = document.createElement('div');
    svgContainer.className = 'markmap-container';
    svgContainer.innerHTML = `<svg id="${tree.id}-svg" style="width:100%; height: var(--mm-canvas-h, 700px);"></svg>`;
    tabContent.appendChild(svgContainer);
    const treeInfo = document.createElement('div');
    treeInfo.className = 'tree-info mt-3 p-2 bg-light rounded';
    treeInfo.innerHTML = `
      <small class="text-muted">
        Username: <strong>${tree.username}</strong> | 
        Taxon: <strong class="js-taxon-label">${tree.taxonName || tree.taxonId}</strong> | 
        Generated: <strong>${tree.timestamp.toLocaleTimeString()}</strong>
      </small>
    `;
    tabContent.appendChild(treeInfo);
    this.tabsContainer.appendChild(tabHeader);
    this.tabContentContainer.appendChild(tabContent);
    
    // Add cache key data attribute if available
    const tabBtn = document.getElementById(`${tree.id}-tab`);
    if (tabBtn) {
      tabBtn.dataset.cacheKey = tree.cacheKey
        || (window.treeKey?.(tree.username, tree.taxonId, tree.scope || 'global', tree.region_code || '') ?? '');
    }
    
    const closeBtn = tabHeader.querySelector('.btn-close');
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.removeTree(tree.id);
    });
    const tabTrigger = tabHeader.querySelector('a');
    tabTrigger.addEventListener('click', (e) => {
      e.preventDefault();
      new bootstrap.Tab(tabTrigger).show();
    });
    // When the tab is shown, clear the SVG and schedule a re-render
    tabTrigger.addEventListener('shown.bs.tab', () => {
      __mmdbg?.log && __mmdbg.log('tab shown', { treeId: tree.id });
      const svg = document.getElementById(`${tree.id}-svg`);
      if (svg) svg.innerHTML = '';
      this._scheduleRender(tree, 80);
    });
    // Note: do not auto-show here; activateTab handles showing

    // Resolve taxon name if missing or generic
    const span = tabHeader.querySelector('.tab-title');
    const taxonInfoEl = tabContent.querySelector('.tree-info .js-taxon-label');
    if (span && (!tree.taxonName || /^Taxon \d+$/.test(span.textContent))) {
      resolveTaxonTitle(tree.taxonId).then(title => {
        span.textContent = title;
        if (taxonInfoEl) taxonInfoEl.textContent = title;
        tree.taxonName = title;
      });
    }
  }

  formatTabTitle(tree) {
    let title = tree.taxonName || `Taxon ${tree.taxonId}`;
    if (title.length > 20) {
      title = title.substring(0, 18) + '...';
    }
    return title;
  }

  renderTree(tree) {
    const svg = document.getElementById(`${tree.id}-svg`);
    if (!svg) return;
    console.count(`[MM] renderTree begin ${tree.id}`);
    svg.innerHTML = '';
  
    // --- 1) pick source markdown ---
    const mdRaw = tree.markdown || tree.md || '';
    let md = mdRaw;
  
    svg.dataset.mode = tree.isChecklist ? 'checklist' : 'explore';
  
    if (tree.isChecklist) {
      md = this.processChecklistMarkdown(mdRaw);
    } else {
      const looksBulleted = /^\s*(?:[-*+]|\d+\.)\s+/m.test(mdRaw);
      md = looksBulleted ? mdRaw : listToHeadings(mdRaw, null);
      if (!looksBulleted) {
        console.debug('[MM] Explore headings md >>>', md.slice(0, 200));
      }
    }
  
    const { Transformer, Markmap } = window.markmap;
  
    // --- helpers ---
    const transform = (s) => {
      const t = new Transformer();
      return t.transform(String(s)).root;
    };
    const stripColorTokens = (s) => String(s).replace(/\{\/?color:[^}]*\}/g, '');
    const stripRiskyHtml = (s) => String(s)
      .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')
      .replace(/<\/?span\b[^>]*>/gi, '')
      .replace(/<[^>]+>/g, '');
    const bulletize = (s) => String(s).split(/\r?\n/).map(l => {
      if (!l.trim()) return l;
      return /^(\s*(?:[-*+]|\d+\.))\s+/.test(l) ? l : `- ${l}`;
    }).join('\n');
  
    // --- 2) transform pipeline ---
    let root = null;
    try {
      root = transform(md);
      console.debug('[MM][xform A headings] children:', root?.children?.length || 0);

      // ⬅️ inject badges AFTER AST exists (Explore only)
      if (!tree.isChecklist) {
        this._injectRankBadgesIntoAst(root);
      }

    } catch (e) {
      console.error('xform A failed:', e);
      root = null;
    }
  
    if (!root?.children?.length) {
      try {
        root = transform(stripColorTokens(md));
        console.debug('[MM][xform B no-color] children:', root?.children?.length || 0);
        
        // ⬅️ inject badges in fallback AST too (Explore only)
        if (!tree.isChecklist && root) {
          this._injectRankBadgesIntoAst(root);
        }
      } catch (e) {
        console.error('xform B failed:', e);
        root = null;
      }
    }
  
    if (!root?.children?.length) {
      console.error('Explore: empty AST after all passes. Preview:', String(md).slice(0, 400));
      const tabContent = document.getElementById(`${tree.id}-content`);
      const host = tabContent?.querySelector('.markmap-container');
      if (host) {
        host.innerHTML = `<div class="alert alert-warning m-3">
          ⚠️ Couldn’t build a tree. Check the /build-taxonomy payload.
        </div>`;
      }
      return;
    }
  
    // --- 3) create markmap ---
    const opts = {
      htmlLabels: true,   // <-- critical for badge spans
      duration: 500,
      autoFit: true,
      fitRatio: 0.98,
      initialExpandLevel: -1,
      pan: true,
      zoom: true,
      scrollForPan: false
    };
  
    const mm = Markmap.create(svg, opts, root);
  
    // After create, sanity-check
    setTimeout(() => {
      const nodes = svg.querySelectorAll('g.markmap-node').length;
      const paths = svg.querySelectorAll('path.markmap-link').length;
      console.debug('[MM] after-create counts', { nodes, links: paths });
      if (nodes > 0) {
        setTimeout(() => requestAnimationFrame(() => this._colorLinksAndTagEdges(svg, mm)), 350);
        svg.addEventListener('click', () => {
          setTimeout(() => requestAnimationFrame(() => this._colorLinksAndTagEdges(svg, mm)), 250);
        });
      }
    }, 120);
  
    // keep handles + fit
    tree._mm = mm;
    const pane = svg.closest('.tab-pane');
    if (tree._ro) try { tree._ro.disconnect(); } catch(_) {}
    tree._ro = new ResizeObserver(() => { try { mm.fit(); } catch(_){} });
    if (pane) tree._ro.observe(pane);
    requestAnimationFrame(() => mm.fit());
  
    // --- 4) rank-based coloring ---
    if (!tree.isChecklist) {
      const getRankColor = (gNode) => {
        const badge = gNode.querySelector('.mm-badge.mm-rank');
        if (!badge) return null;
        // Prefer explicit data-rank if present, else the badge title ("family", "order", etc.)
        const rank = (badge.getAttribute('data-rank') || badge.getAttribute('title') || '').trim().toLowerCase();
        return colorForRank(rank);
      };

      const colorByRank = () => {
        const colorByPath = new Map();
        svg.querySelectorAll('g.markmap-node').forEach((g) => {
          const c = getRankColor(g);
          if (!c) return;
          const key = g.getAttribute('data-path');
          if (key) colorByPath.set(key, c);
          const ln = g.querySelector('line'); if (ln) ln.setAttribute('stroke', c);
          const circle = g.querySelector('circle'); if (circle) { circle.setAttribute('stroke', c); circle.setAttribute('fill', c); }
        });
        svg.querySelectorAll('path.markmap-link').forEach((p) => {
          let key = p.getAttribute('data-path');
          let gNode = key ? svg.querySelector(`g.markmap-node[data-path="${key}"]`) : null;
          const rankColor = (gNode && getRankColor(gNode)) || (key && colorByPath.get(key));
          if (!rankColor) return;
          p.setAttribute('stroke', rankColor);
          p.style.stroke = rankColor; p.style.strokeOpacity = '1'; p.style.fill = 'none';
        });
      };

      setTimeout(() => requestAnimationFrame(colorByRank), 400);
      svg.addEventListener('click', () => setTimeout(() => requestAnimationFrame(colorByRank), 250));
    }
  
    // toolbar, gutters, minimap
    this.installToolbar(tree, mm, root);
    this._ensureScrollGutters(svg.closest('.markmap-container'));
    this._ensureMiniMap(tree.id, svg);
  }
  

  // Create statistics dashboard for a single tree
  createStatsDashboard(tree) {
    try {
      if (!window.taxonomyStats || !tree.stats) {
        return null;
      }
      // Create title based on tree data
      const title = `Taxonomic Statistics for ${tree.username} - ${tree.taxonName}`;
      return window.taxonomyStats.createStatsDashboard(tree.stats, title);
    } catch (error) {
      console.error('Error creating statistics dashboard:', error);
      return null;
    }
  }

  async removeTree(treeId) {
    const index = this.trees.findIndex(t => t.id === treeId);
    if (index === -1) return;
    
    const tree = this.trees[index];
    
    // Delete from cache before removing from UI
    try {
      const key =
        tree.cacheKey ||
        document.getElementById(`${treeId}-tab`)?.dataset.cacheKey ||
        (window.treeKey?.(tree.username, tree.taxonId, tree.scope || 'global', tree.region_code || '') ?? '');

      if (key) {
        console.log('[tabs] closing; deleting cache key:', key);
        await window.deleteCachedTreeByKey?.(key);
      } else {
        console.log('[tabs] closing; no cache key on tree', tree);
      }
    } catch (e) {
      console.warn('[tabs] cache delete on close failed', e);
    }

    this.trees.splice(index, 1);
    const tabHeader = document.getElementById(`${treeId}-tab`).parentNode;
    const tabContent = document.getElementById(`${treeId}-content`);
    let activateTabId = null;
    if (tabHeader.querySelector('.nav-link').classList.contains('active')) {
      if (this.trees.length > 0) {
        activateTabId = this.trees[this.trees.length - 1].id;
      }
    }
    tabHeader.remove();
    tabContent.remove();
    if (activateTabId) {
      const tabToActivate = document.getElementById(`${activateTabId}-tab`);
      if (tabToActivate) {
        new bootstrap.Tab(tabToActivate).show();
      }
    }
    if (this.trees.length === 0) {
      const card = document.getElementById(this.resultsCardId);
      if (card) card.style.display = 'none';
    }
  }

  clearAllTrees() {
    if (!confirm('Are you sure you want to clear all trees?')) return;
    this.trees = [];
    this.tabsContainer.innerHTML = '';
    this.tabContentContainer.innerHTML = '';
    this.currentId = 0;
    const card = document.getElementById(this.resultsCardId);
    if (card) card.style.display = 'none';
    // Also clear persisted trees so they don't restore on next load
    window.clearAllTreeCaches?.().catch(()=>{});
  }

  // Updated: For comparison trees, we now only create one tab.
  addComparisonTree(username1, username2, taxonName, taxonId, markdown, existingStats = null) {
    const treeId = this.generateTreeId();

    // Process comparison markdown to extract statistics for both users
    let stats = existingStats;
    try {
      if (!stats && window.taxonomyStats && typeof window.taxonomyStats.processComparisonMarkdown === 'function') {
        stats = window.taxonomyStats.processComparisonMarkdown(markdown);
      }
    } catch (error) {
      console.error('Error processing comparison statistics:', error);
    }

    const tree = {
      id: treeId,
      username1,
      username2,
      taxonName,
      taxonId,
      markdown,
      stats,
      isComparison: true,
      timestamp: new Date()
    };
    this.trees.push(tree);
    this.createComparisonTreeTab(tree);
    this.activateTab(treeId);
    return treeId;
  }

  createComparisonTreeTab(tree) {
    const tabHeader = document.createElement('li');
    tabHeader.className = 'nav-item';
    tabHeader.innerHTML = `
      <a class="nav-link" id="${tree.id}-tab" data-bs-toggle="tab" href="#${tree.id}-content" role="tab" 
         aria-controls="${tree.id}-content" aria-selected="false">
        <span class="tab-title">${this.formatComparisonTabTitle(tree)}</span>
        <button class="btn-close ms-2 btn-close-white text-sm" aria-label="Close" 
                style="font-size: 0.5rem; opacity: 0.5;" data-tree-id="${tree.id}"></button>
      </a>
    `;
    const tabContent = document.createElement('div');
    if (this.trees.length === 1) {
      tabContent.className = 'tab-pane fade show active';
      tabHeader.querySelector('a').setAttribute('aria-selected', 'true');
    } else {
      tabContent.className = 'tab-pane fade';
    }
    tabContent.id = `${tree.id}-content`;
    tabContent.setAttribute('role', 'tabpanel');
    tabContent.setAttribute('aria-labelledby', `${tree.id}-tab`);
    // expose usernames for first-observation controller (comparison mode)
    tabContent.dataset.username1 = tree.username1;
    tabContent.dataset.username2 = tree.username2;
    const svgContainer = document.createElement('div');
    svgContainer.className = 'markmap-container';
    svgContainer.innerHTML = `<svg id="${tree.id}-svg" style="width:100%; height: var(--mm-canvas-h, 700px);"></svg>`;
    tabContent.appendChild(svgContainer);
    this.tabsContainer.appendChild(tabHeader);
    this.tabContentContainer.appendChild(tabContent);
    const closeBtn = tabHeader.querySelector('.btn-close');
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.removeTree(tree.id);
    });
    const tabTrigger = tabHeader.querySelector('a');
    tabTrigger.addEventListener('click', (e) => {
      e.preventDefault();
      new bootstrap.Tab(tabTrigger).show();
    });
    // When the compare tab is shown, schedule re-render (guarded)
    tabTrigger.addEventListener('shown.bs.tab', () => {
      // Clear any existing renderers first to prevent memory leaks
      const svg = document.getElementById(`${tree.id}-svg`);
      if (svg) svg.innerHTML = '';
      this._scheduleRender(tree, 80);
    });
    // Note: do not auto-show here; activateTab handles showing
  }

  formatComparisonTabTitle(tree) {
    let title = `${tree.username1} vs ${tree.username2}`;
    if (title.length > 25) {
      const maxLength = 10;
      const u1 = tree.username1.substring(0, maxLength);
      const u2 = tree.username2.substring(0, maxLength);
      title = `${u1} vs ${u2}`;
    }
    return title;
  }

  processComparisonMarkdown(markdown) {
    // Turn {color:*}...{/color} into spans Markmap can render as HTML labels
    return String(markdown)
      .replace(/\{color:red\}([\s\S]*?)\{\/color\}/gi, '<span class="user1-node">$1</span>')
      .replace(/\{color:blue\}([\s\S]*?)\{\/color\}/gi, '<span class="user2-node">$1</span>')
      .replace(/\{color:purple\}([\s\S]*?)\{\/color\}/gi, '<span class="shared-node">$1</span>');
  }

  // Checklist: mirror PvP approach with semantic classes (seen/unseen)
  processChecklistMarkdown(markdown) {
    return String(markdown)
      .replace(/\{color:#22c55e\}([\s\S]*?)\{\/color\}/gi, '<span class="seen-node">$1</span>')
      .replace(/\{color:#9ca3af\}([\s\S]*?)\{\/color\}/gi, '<span class="unseen-node">$1</span>');
  }
  

  renderComparisonTree(tree) {
    const svg = document.getElementById(`${tree.id}-svg`);
    if (!svg) return;
    svg.innerHTML = '';
  
    // Preprocess markdown for color tokens
    let md = tree.markdown || tree.md || '';
    const processedMarkdown = this.processComparisonMarkdown(md);

    // Tag the mode for any helpers that look at it (mini-map, etc.)
    svg.dataset.mode = 'pvp';

    const { Transformer, Markmap } = window.markmap;
    const transformer = new Transformer();
    const { root } = transformer.transform(processedMarkdown);
  
    const opts = {
      htmlLabels: true,
      duration: 500,
      autoFit: true,
      fitRatio: 0.98,
      initialExpandLevel: -1,   // show full tree now
      pan: true,
      zoom: true,
      scrollForPan: false   // wheel = zoom; gutters = page scroll
    };

    // Add color function for PvP comparison trees
    opts.color = (node) => {
      const hay = [node.v, node.content, node.payload?.content];
      for (const s of hay) {
        if (s && typeof s === 'string') {
          if (s.includes('user1-node')) return '#dc2626';
          if (s.includes('user2-node')) return '#2563eb';
          if (s.includes('shared-node')) return '#9333ea';
        }
      }
      return undefined;
    };

    const mm = Markmap.create(svg, opts, root);

    // Keep a handle + keep fitting
    tree._mm = mm;
    const pane = svg.closest('.tab-pane');
    if (tree._ro) try { tree._ro.disconnect(); } catch(_) {}
    tree._ro = new ResizeObserver(() => { try { mm.fit(); } catch(_){} });
    if (pane) tree._ro.observe(pane);
    requestAnimationFrame(() => mm.fit());

    // Color links and tag classes (comparison too)
    setTimeout(() => requestAnimationFrame(() => this._colorLinksAndTagEdges(svg, mm)), 350);
    // Reapply on expand/collapse
    svg.addEventListener('click', () => {
      setTimeout(() => requestAnimationFrame(() => this._colorLinksAndTagEdges(svg, mm)), 250);
    });
  
    // Dark mode handling
    try {
      const isDark = document.body.classList.contains('dark-theme');
      if (isDark) {
        setTimeout(() => {
          const texts = svg.querySelectorAll('text, tspan, .markmap-node text');
          texts.forEach(t => { 
            t.setAttribute('fill', '#f8fafc');
            t.style.opacity = '0.96';
          });
          const foreign = svg.querySelectorAll('.markmap-foreign *');
          foreign.forEach(el => { el.style.color = '#f8fafc'; });
        }, 0);
      }
    } catch (_) {}

    // (Optional) stats dashboard
    const tabContent = document.getElementById(`${tree.id}-content`);
    if (tabContent) {
      const existingStats = tabContent.querySelectorAll('.comparison-stats, .battle-summary');
      existingStats.forEach(el => el.remove());
    }
    if (tree.stats && window.taxonomyStats) {
      try {
        const comparisonDashboard = window.taxonomyStats.createComparisonDashboard(
          tree.stats, tree.username1, tree.username2
        );
        if (comparisonDashboard && tabContent) {
          tabContent.appendChild(comparisonDashboard);
          this.applyComparisonStatsColors(tree);
          this.createBattleSummary(tree);
        }
      } catch (error) {
        console.error('Error creating comparison dashboard:', error);
      }
    }

    // --- ALWAYS add these, regardless of stats ---
    this.installToolbar(tree, mm, root);
    this._ensureScrollGutters(svg.closest('.markmap-container'));
    this._ensureMiniMap(tree.id, svg);

  }
  

  createBattleSummary(tree) {
    // First, remove any existing battle-summary elements to prevent duplicates
    const tabContent = document.getElementById(`${tree.id}-content`);
    const existingBattleSummary = tabContent?.querySelector('.battle-summary');
    if (existingBattleSummary) existingBattleSummary.remove();
  
    // App colors (same as your markmap palette)
    const COLOR_USER1  = '#dc2626'; // red
    const COLOR_USER2  = '#2563eb'; // blue
    const COLOR_SHARED = '#9333ea'; // purple

    const statsContainer = document.createElement('div');
    statsContainer.className = 'battle-summary mt-4';

    // Use the statistics data if available
    let user1Count = 0, user2Count = 0, user1Only = 0, user2Only = 0, shared = 0;

    if (tree.stats && tree.stats.user1 && tree.stats.user2 && tree.stats.shared) {
      user1Count = tree.stats.user1.withShared.total || 0;
      user2Count = tree.stats.user2.withShared.total || 0;
      user1Only  = tree.stats.user1.unique.total     || 0;
      user2Only  = tree.stats.user2.unique.total     || 0;
      shared     = tree.stats.shared.total           || 0;
    } else if (tree.stats) {
      // Fallback to the original stats format if available
      user1Count = tree.stats.user1Total || 0;
      user2Count = tree.stats.user2Total || 0;
      user1Only  = tree.stats.user1Only  || 0;
      user2Only  = tree.stats.user2Only  || 0;
      shared     = tree.stats.shared     || 0;
    }

    const total = user1Only + user2Only + shared;
    const user1Percent  = total > 0 ? Math.round((user1Only / total) * 100) : 0;
    const user2Percent  = total > 0 ? Math.round((user2Only / total) * 100) : 0;
    const sharedPercent = total > 0 ? Math.round((shared    / total) * 100) : 0;
  
    // Render
    statsContainer.innerHTML = `
      <div class="battle-summary-header">
        <div class="battle-user battle-user-1">
          <div class="battle-user-avatar">${tree.username1.charAt(0).toUpperCase()}</div>
          <div class="battle-user-name">${tree.username1}</div>
        </div>
        <div class="battle-vs">VS</div>
        <div class="battle-user battle-user-2">
          <div class="battle-user-avatar">${tree.username2.charAt(0).toUpperCase()}</div>
          <div class="battle-user-name">${tree.username2}</div>
        </div>
      </div>
      <div class="battle-stats">
        <div class="battle-stat battle-stat-user1">
          <div class="battle-stat-value">${user1Only}</div>
          <div class="battle-stat-label">Unique to ${tree.username1}</div>
        </div>
        <div class="battle-stat battle-stat-shared">
          <div class="battle-stat-value">${shared}</div>
          <div class="battle-stat-label">Shared</div>
        </div>
        <div class="battle-stat battle-stat-user2">
          <div class="battle-stat-value">${user2Only}</div>
          <div class="battle-stat-label">Unique to ${tree.username2}</div>
        </div>
      </div>
      <div class="battle-progress">
        <div class="battle-progress-bar user1-bar"  style="width:${user1Percent}%;">${user1Percent}%</div>
        <div class="battle-progress-bar shared-bar" style="width:${sharedPercent}%;">${sharedPercent}%</div>
        <div class="battle-progress-bar user2-bar"  style="width:${user2Percent}%;">${user2Percent}%</div>
      </div>
    `;
  
    // Apply consistent colors (light & dark themes)
    const applyColors = (root) => {
      // Avatars
      const av1 = root.querySelector('.battle-user-1 .battle-user-avatar');
      const av2 = root.querySelector('.battle-user-2 .battle-user-avatar');
      if (av1) { av1.style.background = COLOR_USER1; av1.style.color = '#fff'; }
      if (av2) { av2.style.background = COLOR_USER2; av2.style.color = '#fff'; }
  
      // Numbers
      const v1 = root.querySelector('.battle-stat-user1 .battle-stat-value');
      const vs = root.querySelector('.battle-stat-shared .battle-stat-value');
      const v2 = root.querySelector('.battle-stat-user2 .battle-stat-value');
      if (v1) v1.style.color = COLOR_USER1;
      if (vs) vs.style.color = COLOR_SHARED;
      if (v2) v2.style.color = COLOR_USER2;
  
      // Labels (subtle tint)
      const l1 = root.querySelector('.battle-stat-user1 .battle-stat-label');
      const ls = root.querySelector('.battle-stat-shared .battle-stat-label');
      const l2 = root.querySelector('.battle-stat-user2 .battle-stat-label');
      if (l1) l1.style.color = COLOR_USER1 + 'cc';
      if (ls) ls.style.color = COLOR_SHARED + 'cc';
      if (l2) l2.style.color = COLOR_USER2 + 'cc';
  
      // Progress bars
      const pb1 = root.querySelector('.battle-progress .user1-bar');
      const pbs = root.querySelector('.battle-progress .shared-bar');
      const pb2 = root.querySelector('.battle-progress .user2-bar');
      if (pb1) pb1.style.background = COLOR_USER1;
      if (pbs) pbs.style.background = COLOR_SHARED;
      if (pb2) pb2.style.background = COLOR_USER2;
  
      // Optional: a thin accent border that stays visible in dark mode
      root.style.borderLeft = `4px solid ${COLOR_USER1}`;
      root.style.borderRight = `4px solid ${COLOR_USER2}`;
      root.style.borderRadius = '10px';
      root.style.paddingLeft = '8px';
      root.style.paddingRight = '8px';
    };

    if (tabContent) {
      tabContent.appendChild(statsContainer);
      applyColors(statsContainer);
    }
  }

  // Force user colors in the comparison dashboard (works in dark & light)
  applyComparisonStatsColors(tree) {
    const tabContent = document.getElementById(`${tree.id}-content`);
    const root = tabContent?.querySelector('.comparison-stats');
    if (!root) return;

    // Same palette you use for nodes/links
    const COLOR_USER1  = '#dc2626'; // red
    const COLOR_USER2  = '#2563eb'; // blue
    const COLOR_SHARED = '#9333ea'; // purple

    // Find the panel that contains "<username>'s Observations"
    const findPanelByHeading = (username) => {
      const needle = `${username}'s Observations`;
      let headingEl = null;

      // Find the element that contains the heading text
      root.querySelectorAll('*').forEach(el => {
        if (!headingEl && el.firstElementChild && el.textContent && el.textContent.includes(needle)) {
          headingEl = el;
        }
      });
      if (!headingEl) return null;

      // Walk up until we hit a direct child "panel" under the comparison root
      let p = headingEl;
      while (p && p.parentElement && p.parentElement !== root) p = p.parentElement;
      return p || headingEl;
    };

    const paintPanel = (panel, color) => {
      if (!panel) return;

      // Accent borders so the column is clearly tied to the user color
      panel.style.setProperty('border-left',  `4px solid ${color}`, 'important');
      panel.style.setProperty('border-radius', '10px');
      panel.style.setProperty('padding-left', '8px');

      // Color the big numbers (and any other numeric KPIs)
      // We apply with !important to override dark-theme palette.
      const maybeNumbers = panel.querySelectorAll(
        '.stat-value, .value, .count, .metric-value, .big-number, .kpi-value, .summary-number, .card .display-4, .card h1, .card h2, .card .h1, .card .h2, *'
      );
      maybeNumbers.forEach(el => {
        const txt = (el.textContent || '').trim();
        if (/^\d{1,4}$/.test(txt)) {
          el.style.setProperty('color', color, 'important');
        }
      });

      // Also tint any progress/underline accents if present
      panel.querySelectorAll('.progress-bar, .bar, .underline, .accent').forEach(el => {
        el.style.setProperty('background', color, 'important');
        el.style.setProperty('border-color', color, 'important');
      });
    };

    const panel1 = findPanelByHeading(tree.username1);
    const panel2 = findPanelByHeading(tree.username2);

    paintPanel(panel1, COLOR_USER1);
    paintPanel(panel2, COLOR_USER2);

    // If there are any "Shared" labels/values in the dashboard, tint them purple
    root.querySelectorAll('*').forEach(el => {
      const t = (el.textContent || '').trim();
      if (/^shared$/i.test(t)) {
        el.style.setProperty('color', COLOR_SHARED, 'important');
      }
    });
  }

  installToolbar(tree, mm, root) {
    const tabContent = document.getElementById(`${tree.id}-content`);
    if (!tabContent) return;

    const host = tabContent.querySelector('.markmap-container');
    if (!host) return;

    // Remove any existing toolbar for this tree
    host.querySelector('.mm-toolbar')?.remove();

    const toolbar = document.createElement('div');
    toolbar.className = 'mm-toolbar';

    // Fit • Center (tree icon) • Export • Bluesky
    toolbar.innerHTML = `
      <button class="btn btn-sm btn-light" data-act="fit" title="Fit to view">
        <i class="bi bi-aspect-ratio"></i>
      </button>

      <button class="btn btn-sm btn-light" data-act="center" title="Center on root">
        <!-- inline 'hierarchy/tree' icon (no dependency on Bootstrap Icons) -->
        <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"
             style="display:block">
          <!-- boxes -->
          <rect x="7"  y="1.5"  width="6" height="3.5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/>
          <rect x="1.5" y="14.8" width="5" height="3.5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/>
          <rect x="7.5" y="14.8" width="5" height="3.5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/>
          <rect x="13.5" y="14.8" width="5" height="3.5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/>
          <!-- connectors -->
          <path d="M10 5.2v3.1M10 8.3H3.9v3.1M10 8.3H10v3.1M10 8.3h6.1v3.1"
                fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          <!-- down stems to bottom boxes -->
          <path d="M3.9 11.4v2.6M10 11.4v2.6M16.1 11.4v2.6"
                fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </button>

      <div class="btn-group">
        <button class="btn btn-sm btn-light dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false" title="Export">
          <i class="bi bi-download"></i> Export
        </button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li><a class="dropdown-item" href="#" data-act="export-png">Export PNG</a></li>
          <li><a class="dropdown-item" href="#" data-act="export-html">Interactive HTML</a></li>
          <li><a class="dropdown-item" href="#" data-act="export-newick">Newick (.nwk)</a></li>
          <li><a class="dropdown-item" href="#" data-act="export-nhx">Newick (NHX)</a></li>
          <li><a class="dropdown-item" href="#" data-act="export-phyloxml">phyloXML</a></li>
          <li><a class="dropdown-item" href="#" data-act="export-nodes-csv">Nodes CSV</a></li>
          <li><a class="dropdown-item" href="#" data-act="export-edges-csv">Edges CSV</a></li>
        </ul>
      </div>

      <button class="btn btn-sm btn-light" data-act="share-bsky" title="Share on Bluesky">
        <span style="font-size:14px;line-height:1">🦋</span>
      </button>
    `;

    host.appendChild(toolbar);

    // actions
    toolbar.querySelector('[data-act="fit"]')
      ?.addEventListener('click', () => { try { mm.fit(); } catch {} });

    toolbar.querySelector('[data-act="center"]')
      ?.addEventListener('click', async () => {
        try {
          if (typeof mm.centerNode === 'function') await mm.centerNode(mm.state.data);
          else mm.fit();
        } catch { mm.fit(); }
      });

    toolbar.querySelector('[data-act="export-png"]')
      ?.addEventListener('click', (e)=>{ e.preventDefault(); this._exportPNG(tree); });

    toolbar.querySelector('[data-act="export-html"]')
      ?.addEventListener('click', (e)=>{ e.preventDefault(); this._exportInteractiveHtml(tree, {}); });

    toolbar.querySelector('[data-act="export-newick"]')
      ?.addEventListener('click', (e) => {
        e.preventDefault();
        this._exportNewick(tree, root);
      });

    toolbar.querySelector('[data-act="export-nhx"]')
      ?.addEventListener('click', (e)=>{ e.preventDefault(); this._exportTreeFile(tree, 'nhx', 'nhx'); });

    toolbar.querySelector('[data-act="export-phyloxml"]')
      ?.addEventListener('click', (e)=>{ e.preventDefault(); this._exportTreeFile(tree, 'phyloxml', 'phyloxml'); });

    toolbar.querySelector('[data-act="export-nodes-csv"]')
      ?.addEventListener('click', (e)=>{ e.preventDefault(); this._exportTreeFile(tree, 'csv_nodes', 'csv'); });

    toolbar.querySelector('[data-act="export-edges-csv"]')
      ?.addEventListener('click', (e)=>{ e.preventDefault(); this._exportTreeFile(tree, 'csv_edges', 'csv'); });

    toolbar.querySelector('[data-act="share-bsky"]')
      ?.addEventListener('click', () => this._openBskyComposer(tree));
  }

  // Always keep page-scrollable gutters around the map
  _ensureScrollGutters(host) {
    if (!host) return;
    if (!host.querySelector('.mm-scroll-gutter.left')) {
      host.appendChild(Object.assign(document.createElement('div'), { className: 'mm-scroll-gutter left' }));
    }
    if (!host.querySelector('.mm-scroll-gutter.right')) {
      host.appendChild(Object.assign(document.createElement('div'), { className: 'mm-scroll-gutter right' }));
    }
  }

 // Mini-map with live viewport; mirrors link colors and connector lines
_ensureMiniMap(treeId, svg) {
  const host = svg.closest('.markmap-container');
  if (!host) return;

  const NS = 'http://www.w3.org/2000/svg';
  let mini = host.querySelector('.mm-minimap');
  if (!mini) {
    mini = document.createElementNS(NS, 'svg');
    mini.classList.add('mm-minimap');
    mini.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const linksLayer = document.createElementNS(NS, 'g');
    linksLayer.classList.add('mm-mini-links');
    mini.appendChild(linksLayer);

    const connsLayer = document.createElementNS(NS, 'g');
    connsLayer.classList.add('mm-mini-conns');
    mini.appendChild(connsLayer);

    const vp = document.createElementNS(NS, 'rect');
    vp.classList.add('mm-mini-viewport');
    mini.appendChild(vp);

    host.appendChild(mini);
  }

  const linksLayer = mini.querySelector('.mm-mini-links');
  const connsLayer = mini.querySelector('.mm-mini-conns');
  const vpRect     = mini.querySelector('.mm-mini-viewport');

  const getContentBBox = () => {
    const els = svg.querySelectorAll('path.markmap-link, g.markmap-node');
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    els.forEach(el => {
      try {
        const b = el.getBBox();
        x1 = Math.min(x1, b.x);
        y1 = Math.min(y1, b.y);
        x2 = Math.max(x2, b.x + b.width);
        y2 = Math.max(y2, b.y + b.height);
      } catch(_) {}
    });
    if (!isFinite(x1)) return { x: 0, y: 0, width: 100, height: 100 };
    return { x: x1, y: y1, width: (x2 - x1), height: (y2 - y1) };
  };

  // Transform a point through element CTM into "content" coordinates
  const toContentCoords = (x, y, el) => {
    const contentG = svg.querySelector('g') || svg;
    const pt = svg.createSVGPoint();
    pt.x = x; pt.y = y;
    const toViewport = el.getCTM && el.getCTM();
    if (!toViewport) return { x, y };
    const pV = pt.matrixTransform(toViewport);
    const invContent = contentG.getCTM && contentG.getCTM().inverse();
    return invContent ? pV.matrixTransform(invContent) : pV;
  };

  // Clone links + connector lines into mini-map
  const rebuildMini = () => {
    linksLayer.innerHTML = '';
    connsLayer.innerHTML = '';

    const readStroke = (el) => {
      if (!el) return null;
      const attr = el.getAttribute('stroke');
      if (attr && attr !== 'none') return attr;
      const inline = el.style && el.style.stroke;
      if (inline && inline !== 'none') return inline;
      try {
        const cs = getComputedStyle(el);
        if (cs && cs.stroke && cs.stroke !== 'none') return cs.stroke;
      } catch (_) {}
      return null;
    };

    const styleStrokeImportant = (el, stroke, opacity = '1') => {
      el.setAttribute('stroke', stroke);
      el.style.setProperty('stroke', stroke, 'important');           // force over gray CSS
      el.style.setProperty('stroke-opacity', opacity, 'important');
      el.style.setProperty('fill', 'none', 'important');
    };

    const targetNodeForPath = (pathEl) => {
      // Prefer data-path on the path, else use bound datum
      let key = pathEl.getAttribute('data-path');
      if (!key) {
        const d = pathEl.__data__;
        const target = d && d.target;
        if (target && target.path) key = target.path;
      }
      return key ? svg.querySelector(`g.markmap-node[data-path="${key}"]`) : null;
    };

    // 1) Curved links
    svg.querySelectorAll('path.markmap-link').forEach(p => {
      const miniPath = document.createElementNS(NS, 'path');
      miniPath.setAttribute('d', p.getAttribute('d') || '');

      // keep comparison classes if present
      const cls = p.getAttribute('class') || '';
      const keep = cls.split(/\s+/).filter(c =>
        c === 'user1-edge' || c === 'user2-edge' || c === 'shared-edge'
      );
      if (keep.length) miniPath.setAttribute('class', keep.join(' '));

      // try to read the actual stroke; if absent/gray, fall back to node connector color
      let stroke = readStroke(p);

      // fallback via the target node's connector (rank color)
      if (!stroke || /rgb\(\s*107\s*,\s*114\s*,\s*128\s*\)/i.test(stroke)) { // gray #6b7280
        const g = targetNodeForPath(p);
        const ln = g && g.querySelector('line');
        const s2 = readStroke(ln);
        if (s2) stroke = s2;
      }

      if (stroke) styleStrokeImportant(miniPath, stroke, '1');

      linksLayer.appendChild(miniPath);
    });

    // 2) Node connector lines
    svg.querySelectorAll('g.markmap-node line').forEach(ln => {
      const x1 = parseFloat(ln.getAttribute('x1') || '0');
      const y1 = parseFloat(ln.getAttribute('y1') || '0');
      const x2 = parseFloat(ln.getAttribute('x2') || '0');
      const y2 = parseFloat(ln.getAttribute('y2') || '0');

      const p1 = toContentCoords(x1, y1, ln);
      const p2 = toContentCoords(x2, y2, ln);

      const miniLine = document.createElementNS(NS, 'line');
      miniLine.setAttribute('x1', p1.x);
      miniLine.setAttribute('y1', p1.y);
      miniLine.setAttribute('x2', p2.x);
      miniLine.setAttribute('y2', p2.y);

      const stroke = readStroke(ln);
      if (stroke) styleStrokeImportant(miniLine, stroke, '1');

      // keep comparison edge classes (harmless in single-user)
      const gNode = ln.closest('g.markmap-node');
      const c = this._inferNodeColorFromG(gNode);
      if (c === '#dc2626') miniLine.classList.add('user1-edge');
      else if (c === '#2563eb') miniLine.classList.add('user2-edge');
      else if (c === '#9333ea') miniLine.classList.add('shared-edge');

      connsLayer.appendChild(miniLine);
    });
  };

  const updateViewport = () => {
    const bbox = getContentBBox();
    mini.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);

    const contentG = svg.querySelector('g') || svg;
    const ctm = contentG.getCTM && contentG.getCTM();
    if (!ctm) return;

    const inv = ctm.inverse();
    const pt = svg.createSVGPoint();
    pt.x = 0; pt.y = 0;
    const tl = pt.matrixTransform(inv);
    pt.x = svg.clientWidth; pt.y = svg.clientHeight;
    const br = pt.matrixTransform(inv);

    const vx = Math.min(tl.x, br.x);
    const vy = Math.min(tl.y, br.y);
    const vw = Math.abs(br.x - tl.x);
    const vh = Math.abs(br.y - tl.y);

    vpRect.setAttribute('x', vx);
    vpRect.setAttribute('y', vy);
    vpRect.setAttribute('width',  vw);
    vpRect.setAttribute('height', vh);
  };

  // Initial build & viewport
  rebuildMini();
  updateViewport();

  // Watch DOM changes to re-sync
  if (!host._miniObserver) {
    const mo = new MutationObserver(() => {
      clearTimeout(host._miniDeb);
      host._miniDeb = setTimeout(() => { rebuildMini(); updateViewport(); }, 120);
    });
    mo.observe(svg, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: [
        'd','transform','class','style',     // added 'style'
        'x1','y1','x2','y2','stroke','stroke-opacity'
      ]
    });
    host._miniObserver = mo;
  }

  // Recompute viewport on size/interaction
  if (!host._miniResize) {
    const ro = new ResizeObserver(updateViewport);
    ro.observe(svg);
    host._miniResize = ro;
  }
  try {
    if (window.d3?.select) {
      window.d3.select(svg).on('zoom.mmMini', () => requestAnimationFrame(updateViewport));
    } else {
      ['wheel','pointermove','pointerup','transitionend','resize'].forEach(ev =>
        svg.addEventListener(ev, () => requestAnimationFrame(updateViewport), { passive: true })
      );
    }
  } catch (_) {}
}

  _fileSafeName(s) {
    return String(s || '').replace(/[^\w\-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  }

  prepareSvgCloneForExport(svg) {
    const ns = 'http://www.w3.org/2000/svg';
    const clone = svg.cloneNode(true);

    // Size
    const vb = svg.viewBox?.baseVal;
    const w = vb ? vb.width  : svg.getBoundingClientRect().width  || 1200;
    const h = vb ? vb.height : svg.getBoundingClientRect().height || 800;
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
    clone.setAttribute('width',  String(w));
    clone.setAttribute('height', String(h));

    const isDark = document.body.classList.contains('dark-theme');

    // Background (match theme)
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x','0'); bg.setAttribute('y','0');
    bg.setAttribute('width', String(w)); bg.setAttribute('height', String(h));
    bg.setAttribute('fill', isDark ? '#1d1f20' : '#ffffff');
    clone.insertBefore(bg, clone.firstChild);

    // Inline label colors so they survive export
    const textColor = isDark ? '#f8fafc' : '#111827';
    clone.querySelectorAll('text, tspan, .markmap-node text').forEach(t => {
      t.setAttribute('fill', textColor);
      t.style.fill = textColor;
      t.style.opacity = isDark ? '0.96' : '1';
    });
    // HTML labels inside foreignObject (don't clobber PvP colors)
    clone.querySelectorAll('.markmap-foreign *:not(.user1-node):not(.user2-node):not(.shared-node)')
         .forEach(el => { el.style.color = textColor; });

    // Re-assert PvP label colors (if present)
    [['.user1-node','#dc2626'],['.user2-node','#2563eb'],['.shared-node','#9333ea']]
      .forEach(([sel,col]) => clone.querySelectorAll(sel).forEach(el => { el.style.color = col; }));

    return clone;
  }

  _treeLabel(tree) {
    const who = tree.isComparison ? `${tree.username1}_vs_${tree.username2}` : (tree.username || 'user');
    const what = tree.taxonName || `Taxon_${tree.taxonId}`;
    const dateBadge = this._currentDateWindowBadge(tree.filters?.observed_d1, tree.filters?.observed_d2);
    return `${who}-${what}${dateBadge}`;
  }

  _currentDateWindowBadge(d1, d2) {
    if (!d1 && !d2) return '';
    const text = d1 && d2 ? `${d1} → ${d2}` : d1 ? `${d1} → …` : `… → ${d2}`;
    return ` <span class="mm-badge mm-rank" title="Observed date window">${text}</span>`;
  }

  /** Get the top-level content group (Markmap uses a single <g> under the SVG root). */
  _getContentGroup(svg) {
    // Prefer direct child <g> of the svg; fallback to first <g>
    return svg.querySelector(':scope > g') || svg.querySelector('g');
  }

  /** Compute a tight bbox that includes nodes, links, labels & connectors in *content coords*. */
  _getTightContentBBox(svg) {
    const g = this._getContentGroup(svg);
    if (!g) {
      // fallback: whole svg viewport
      return { x: 0, y: 0, width: svg.clientWidth || 1200, height: svg.clientHeight || 800 };
    }
    // getBBox on the content group already includes its descendants
    const b = g.getBBox(); // in the group's local user space
    // small padding so strokes/text aren't clipped
    const pad = 4;
    return { x: b.x - pad, y: b.y - pad, width: b.width + 2*pad, height: b.height + 2*pad };
  }

  /** Clone the SVG with pan/zoom neutralized (remove transform on content group) and a tight viewBox. */
  _serializeSvgForExport(svg) {
    // Use the new helper to prepare the clone with proper theme handling
    const clone = this.prepareSvgCloneForExport(svg);

    // Normalize the content group: drop any pan/zoom transform
    const g = this._getContentGroup(clone);
    if (g) g.removeAttribute('transform');

    // Compute tight bbox *after* neutralizing transform
    // (use the original SVG to read geometry; it's fine, both share structure)
    const bbox = this._getTightContentBBox(svg);

    clone.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
    clone.setAttribute('width', Math.ceil(bbox.width));
    clone.setAttribute('height', Math.ceil(bbox.height));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

    // Minimal embedded style so links/text render correctly when standalone
    const style = document.createElement('style');
    style.textContent = `
      text, tspan { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
      .markmap-link { fill: none; }
    `;
    clone.insertBefore(style, clone.firstChild);

    const svgText = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
    return { svgText, bbox };
  }
  _downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  /** Build a PNG Blob from the current SVG (tight bbox, centered). */
  _makePNGBlobFromSVG(svg, scale = 2) {
    return new Promise((resolve, reject) => {
      const { svgText, bbox } = this._serializeSvgForExport(svg);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        const w = Math.max(1, Math.ceil(bbox.width  * scale));
        const h = Math.max(1, Math.ceil(bbox.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;

        const ctx = canvas.getContext('2d', { alpha: false });
        const isDark = document.body.classList.contains('dark-theme');
        ctx.fillStyle = isDark ? '#1d1f20' : '#ffffff';
        ctx.fillRect(0, 0, w, h);

        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encode failed')), 'image/png');
      };
      img.onerror = () => reject(new Error('Failed to rasterize SVG'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
    });
  }
  _exportSVG(tree) {
    const svg = document.getElementById(`${tree.id}-svg`);
    if (!svg) return;
    const { svgText } = this._serializeSvgForExport(svg);
    const name = this._fileSafeName(`${this._treeLabel(tree)}_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.svg`);
    this._downloadBlob(name, new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
  }

  // --- Newick export helpers (improved) ---

  // Decode HTML entities -> plain text (so we can remove emoji reliably)
  _decodeEntities(s = '') {
    const el = document.createElement('textarea');
    el.innerHTML = String(s);
    return el.value;
  }

  // Strip HTML/tokens in Markmap label -> clean text (no emoji/entities)
  _labelFromHtml(html = '') {
    let s = String(html);

    // Remove markmap tokens + tags first
    s = s.replace(/\{color:[^}]+\}/gi, '')
         .replace(/\{\/color\}/gi, '')
         .replace(/<a[^>]*class="taxon-link"[^>]*>(.*?)<\/a>/gi, '$1')
         .replace(/<span[^>]*>.*?<\/span>/gi, '')
         .replace(/<[^>]+>/g, '');

    // Decode any HTML entities (eg. &#x1f5bc;, &amp;, &nbsp;)
    s = this._decodeEntities(s);

    // Remove the camera/pictograph emoji and variation selectors
    // - specifically remove U+1F5BC (🖼) with optional U+FE0F
    s = s.replace(/\u{1F5BC}\u{FE0F}?/gu, '');

    // (optional) remove any other pictographic emojis that might slip in
    // Comment out if you want to keep other emojis.
    s = s.replace(/\p{Extended_Pictographic}/gu, '');

    // Collapse whitespace
    return s.replace(/\s+/g, ' ').trim();
  }

  // Quote labels if they contain spaces/specials per Newick (single quotes doubled)
  _escapeNewickLabel(label = '') {
    if (!label) return '';
    return /[()\[\],:;\s]/.test(label)
      ? `'${String(label).replace(/'/g, "''")}'`
      : label;
  }

  // Convert Markmap AST -> Newick string (no branch lengths)
  // options: { includeInternalLabels: boolean }
  _buildNewickFromMarkmap(mmRoot, fallbackRootLabel = 'root', opts = {}) {
    const { includeInternalLabels = false } = opts;
    if (!mmRoot) return `${this._escapeNewickLabel(fallbackRootLabel)};`;

    // Unwrap container nodes the transformer may have added
    const firstReal = (node) => {
      if (!node) return null;
      const hasContent = node.content && String(node.content).trim().length > 0;
      if (hasContent) return node;
      if (node.children && node.children.length === 1) return firstReal(node.children[0]);
      return node;
    };

    const cleanNode = firstReal(mmRoot);

    const walk = (node, isRoot = false) => {
      const kids = Array.isArray(node.children) ? node.children.filter(Boolean) : [];
      const labelText = this._labelFromHtml(node.content || '');
      const label = this._escapeNewickLabel(labelText);

      if (kids.length === 0) {
        // leaf
        return label || this._escapeNewickLabel(fallbackRootLabel);
      }
      const childStr = kids.map((k) => walk(k, false)).join(',');

      // Internal-node labels often clutter; omit unless explicitly requested
      const internal = includeInternalLabels && label ? label : '';

      // If the very top is an unlabeled multi-child container, synthesize a root label
      if (isRoot && !internal && (!labelText || !labelText.trim())) {
        return `(${childStr})${this._escapeNewickLabel(fallbackRootLabel)}`;
      }
      return `(${childStr})${internal}`;
    };

    const isContainerNoLabel =
      (!cleanNode.content || !String(cleanNode.content).trim()) &&
      Array.isArray(cleanNode.children) && cleanNode.children.length > 1;

    const core = isContainerNoLabel
      ? `(${cleanNode.children.map((k) => walk(k)).join(',')})${this._escapeNewickLabel(fallbackRootLabel)}`
      : walk(cleanNode, true);

    return core + ';';
  }

  _exportNewick(tree, mmRoot) {
    const fallback = tree.taxonName || (tree.taxonId ? `Taxon ${tree.taxonId}` : 'root');
    // Default: hide internal labels for cleaner output
    const newick = this._buildNewickFromMarkmap(mmRoot, fallback, { includeInternalLabels: false });
    const name = this._fileSafeName(`${this._treeLabel(tree)}_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.nwk`);
    this._downloadBlob(name, new Blob([newick], { type: 'text/x-nh' }));
  }

  async _exportTreeFile(tree, format, ext) {
    if (this._exportBusy) return;
    this._exportBusy = true;
    try {
      const url = `${API_BASE}/export?format=${encodeURIComponent(format)}`;

      // Build graph from the SAME markdown you render
      const { Transformer } = window.markmap;
      const t  = new Transformer();
      const md = tree.markdown || tree.md || '';
      const { root } = t.transform(md);
      const graph = this.astToGraph(root);

      const body = {
        mode: tree.isComparison ? 'compare' : 'single',
        username: tree.username,
        username1: tree.username1,
        username2: tree.username2,
        taxonId: tree.taxonId,
        taxonName: tree.taxonName,
        graph // << send only this; no rows required
      };

      const doFetch = () => fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(window.authHeader ? { Authorization: window.authHeader } : {})
        },
        body: JSON.stringify(body)
      }).then(async r => {
        if (r.status === 429) throw new Error('export HTTP 429');
        if (!r.ok) throw new Error(`export ${r.status}: ${(await r.text().catch(()=>'')) || 'unknown error'}`);
        return r;
      });

      const r = await this._withBackoff(doFetch);
      const blob = await r.blob();
      this._downloadBlob(`${this._fileSafeName(this._treeLabel(tree))}.${ext}`, blob);
    } finally {
      this._exportBusy = false;
    }
  }

  // Exponential backoff helper
  async _withBackoff(fn, { tries = 4, base = 400 } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { 
        return await fn(); 
      } catch (e) {
        lastErr = e;
        if (!/HTTP 429/.test(String(e))) break;
        const wait = base * Math.pow(2, i) + Math.random() * 150;
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  // Convert Markmap AST to graph format for export
  astToGraph(mmRoot) {
    const nodes = [], edges = [];
    let id = 0;

    const clean = (s='') =>
      String(s)
        .replace(/\{color:[^}]+\}|\{\/color\}/gi,'')
        .replace(/\{rank:[^}]+\}/gi,'')
        .replace(/<[^>]+>/g,'')
        .replace(/\u{1F5BC}\u{FE0F}?/gu,'') // 🖼️
        // drop trailing rank glyphs (e.g., " F", " sF", " SF", " iO", " eF", etc.)
        .replace(/\s(?:[FGSOCPKD]|s[FGCODKP]|e[FG]|i[O])\s*$/i, '')
        .replace(/\s+/g,' ')
        .trim();

    const getRank = (s='') => {
      const m = String(s).match(/\{rank:([a-z]+)\}/i);
      return m ? m[1].toLowerCase() : '';
    };

    const unwrap = n =>
      (n && (!n.content || !String(n.content).trim()) && (n.children||[]).length === 1)
        ? unwrap(n.children[0]) : n;

    const walk = (node, parentId=null) => {
      if (!node) return;
      const label = clean(node.content || '');
      const rank  = getRank(node.content || '');
      const myId  = `n${++id}`;
      nodes.push({ id: myId, name: label || `node_${id}`, rank });
      if (parentId) edges.push({ parent_id: parentId, child_id: myId });
      (node.children || []).forEach(ch => walk(ch, myId));
    };

    walk(unwrap(mmRoot), null);
    return { nodes, edges };
  }

  async _exportPNG(tree, scale = 2) {
    const svg = document.getElementById(`${tree.id}-svg`);
    if (!svg) return;
    const blob = await this._makePNGBlobFromSVG(svg, scale);
    const name = this._fileSafeName(`${this._treeLabel(tree)}_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.png`);
    this._downloadBlob(name, blob);
  }

  /** Export a self-contained interactive HTML (Markmap) of the current tree. */
_exportInteractiveHtml(tree, { title } = {}) {
  const defaultTitle = tree.isComparison
    ? `iNaturalist Tree PVP: ${tree.username1} vs ${tree.username2} — ${tree.taxonName || `Taxon ${tree.taxonId}`}`
    : `iNaturalist Taxa Tree: ${tree.username} — ${tree.taxonName || `Taxon ${tree.taxonId}`}`;
  const pageTitle = title || defaultTitle;

  const isDarkNow =
    document.body.classList.contains('dark-theme') ||
    document.documentElement.classList.contains('dark-theme');

  const mdRaw = String(tree.markdown || tree.md || '');
  // Prevent closing the inline <script> in the exported HTML
  const mdEsc = mdRaw.replace(/<\/script>/gi, '<\\/script>');

  const html = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${pageTitle}</title>
<style>
  html,body{margin:0;height:100%}
  body{background:#ffffff;color:#111827}
  body.dark{background:#111827;color:#f8fafc}
  .wrap{height:100vh}
  .wrap svg{width:100%;height:100%}
  .dark svg text, .dark svg tspan{fill:#f8fafc !important;opacity:.98 !important}
  .markmap-foreign, .markmap-foreign *{pointer-events:auto}
  .dark .markmap-foreign{color:#f8fafc !important}
  .dark .markmap-foreign *:not(.user1-node):not(.user2-node):not(.shared-node){color:inherit !important}
  .mm-badge.mm-rank{display:inline-block;border:1px solid rgba(0,0,0,.18);border-radius:4px;padding:0 4px;margin-left:.25rem;font-weight:600;line-height:1.2}
  .dark .mm-badge.mm-rank{color:#f8fafc !important;border-color:rgba(255,255,255,.35);background:rgba(255,255,255,.06)}
  .user1-node, .user1-node a, .user1-node *{color:#dc2626 !important}
  .user2-node, .user2-node a, .user2-node *{color:#2563eb !important}
  .shared-node, .shared-node a, .shared-node *{color:#9333ea !important}
  .seen-node, .seen-node a, .seen-node *{color:#22c55e !important}
  .unseen-node, .unseen-node a, .unseen-node *{color:#9ca3af !important}
</style>
<body${isDarkNow ? ' class="dark"' : ''}>
<div class="wrap" id="wrap"><svg id="mm"></svg></div>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script src="https://cdn.jsdelivr.net/npm/markmap-lib"></script>
<script src="https://cdn.jsdelivr.net/npm/markmap-view"></script>
<script>
  const rawMd = ${JSON.stringify(mdEsc)};

  // --- Remove picture-chip emojis & links entirely ---
  function stripPictureChips(md){
    return String(md)
      // HTML: <a ...> 🖼️ </a>
      .replace(/<a\b[^>]*>\s*🖼️\s*<\/a>/gi, '')
      // Markdown: [🖼️](url)
      .replace(/\[🖼️\]\([^)]+\)/gi, '')
      // any stray emoji
      .replace(/🖼️/g, '');
  }

  // --- Make common iNat links absolute in the markdown (non-chip links left intact) ---
  function absolutizeHrefInMd(md){
    return String(md)
      .replace(/href=(["'])\s*\/\/([^"']+)\1/gi, 'href=$1https://$2$1')
      .replace(/href=(["'])\s*\/(observations|taxa|photos|people|posts)\b/gi,
               'href=$1https://www.inaturalist.org/$2')
      .replace(/href=(["'])\s*(observations|taxa|photos|people|posts)\b/gi,
               'href=$1https://www.inaturalist.org/$2');
  }

  const processedMd = absolutizeHrefInMd(
    stripPictureChips(String(rawMd))
      // PvP colors
      .replace(/\{color:red\}([\s\S]*?)\{\/color\}/gi, '<span class="user1-node">$1</span>')
      .replace(/\{color:blue\}([\s\S]*?)\{\/color\}/gi, '<span class="user2-node">$1</span>')
      .replace(/\{color:purple\}([\s\S]*?)\{\/color\}/gi, '<span class="shared-node">$1</span>')
      // Checklist colors
      .replace(/\{color:#22c55e\}([\s\S]*?)\{\/color\}/gi, '<span class="seen-node">$1</span>')
      .replace(/\{color:#9ca3af\}([\s\S]*?)\{\/color\}/gi, '<span class="unseen-node">$1</span>')
  );

  const { Transformer, Markmap } = window.markmap;
  const t = new Transformer();
  const root = t.transform(processedMd).root;

  // Inject rank badges from {rank:*} tokens
  (function injectRankBadges(node){
    const visit = (n)=>{
      if (n.content){
        const m = n.content.match(/\{rank:([a-z]+)\}/i);
        if (m){
          const rank = m[1].toLowerCase();
          const letter = rank.charAt(0).toUpperCase();
          n.content = n.content.replace(/\s*\{rank:[^}]+\}\s*/i,' ');
          n.content = (n.content||'').replace(/\s*$/, ' ') +
            '<span class="mm-badge mm-rank" data-rank="'+rank+'" title="'+rank+'">'+letter+'</span>';
        }
      }
      (n.children||[]).forEach(visit);
    };
    visit(node);
  })(root);

  const svg = document.getElementById('mm');
  const mm  = Markmap.create(svg, { htmlLabels:true, initialExpandLevel:-1, autoFit:true, pan:true, zoom:true }, root);

  // Ensure readable text in dark mode after renders
  function applyDarkText(){
    if (!document.body.classList.contains('dark')) return;
    svg.querySelectorAll('text, tspan').forEach(t=>{
      t.setAttribute('fill','#f8fafc'); t.style.fill='#f8fafc'; t.style.opacity='.98';
    });
    svg.querySelectorAll('.markmap-foreign *:not(.user1-node):not(.user2-node):not(.shared-node)')
      .forEach(el=>{ el.style.color='#f8fafc'; });
  }
  applyDarkText();
  new MutationObserver(()=>applyDarkText()).observe(svg, { subtree:true, childList:true });

  // Theme toggle with 'D'
  document.addEventListener('keydown', e=>{
    if ((e.key||'').toLowerCase() === 'd'){
      document.body.classList.toggle('dark');
      setTimeout(()=>{ try{ mm.fit(); }catch(_){ } applyDarkText(); }, 0);
    }
  });

  setTimeout(()=>{ try{ mm.fit(); }catch(_){ } applyDarkText(); }, 100);
</script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const name = this._fileSafeName(
    `${this._treeLabel(tree)}_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}`
  ) + '.html';
  this._downloadBlob(name, blob);
}





  /* ------- Bluesky: confirm-then-post flow (no auto-post) ------- */

  // Build default post text
  _composeShareText(tree){
    return tree.isComparison
      ? `iNaturalist Tree PVP: ${tree.username1} vs ${tree.username2} — ${tree.taxonName || `Taxon ${tree.taxonId}`}`
      : `My iNaturalist taxonomic tree: ${tree.username} — ${tree.taxonName || `Taxon ${tree.taxonId}`}`;
  }

  // Make a <= ~1–2MB image (try WebP, fallback PNG) + preview URL
  async _makeShareImageForBsky(svg, tree){
    const { svgText, bbox } = this._serializeSvgForExport(svg);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);

    const img = await new Promise((res, rej)=>{
      const i = new Image();
      i.decoding = 'async';
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });

    // Render at ~2x then compress
    let scale = 2, quality = 0.92, blob = null, dataUrl = null;
    for (let attempts = 0; attempts < 5; attempts++){
      const w = Math.max(1, Math.ceil(bbox.width * scale));
      const h = Math.max(1, Math.ceil(bbox.height * scale));
      const canvas = Object.assign(document.createElement('canvas'), { width:w, height:h });
      const ctx = canvas.getContext('2d', { alpha:false });

      const isDark = document.body.classList.contains('dark-theme');
      ctx.fillStyle = isDark ? '#1d1f20' : '#ffffff';
      ctx.fillRect(0,0,w,h);
      ctx.drawImage(img, 0, 0, w, h);

      // Prefer WebP for size, fallback to PNG
      blob = await new Promise(r => canvas.toBlob(r, 'image/webp', quality));
      if (!blob || blob.size > 2_000_000) {
        if (quality > 0.6) { quality -= 0.12; continue; }
        scale *= 0.85; continue;
      }
      break;
    }
    if (!blob) {
      // Fallback PNG once
      const pngCanvas = Object.assign(document.createElement('canvas'), {
        width: Math.ceil(bbox.width * 2),
        height: Math.ceil(bbox.height * 2)
      });
      const ctx = pngCanvas.getContext('2d', { alpha:false });
      const isDark = document.body.classList.contains('dark-theme');
      ctx.fillStyle = isDark ? '#1d1f20' : '#ffffff';
      ctx.fillRect(0,0,pngCanvas.width,pngCanvas.height);
      ctx.drawImage(img, 0, 0, pngCanvas.width, pngCanvas.height);
      blob = await new Promise(r => pngCanvas.toBlob(r, 'image/png'));
    }

    dataUrl = URL.createObjectURL(blob);
    const alt = `Taxonomic tree for ${tree.isComparison ? `${tree.username1} vs ${tree.username2}` : tree.username}: ${tree.taxonName || `Taxon ${tree.taxonId}`}`;
    return { blob, dataUrl, alt };
  }

  // Show modal that previews image + lets user edit text, then post on confirm
  async _openBskyComposer(tree){
    // Build modal once
    let shell = document.getElementById('bskyComposeModal');
    if (!shell){
      shell = document.createElement('div');
      shell.id = 'bskyComposeModal';
      shell.innerHTML = `
        <div class="modal fade" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog modal-lg">
            <form class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">Compose to Bluesky</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <div class="row g-3">
                  <div class="col-md-7">
                    <div class="ratio ratio-4x3 border rounded">
                      <img id="bskyPreviewImg" alt="Preview" style="object-fit:contain;width:100%;height:100%">
                    </div>
                  </div>
                  <div class="col-md-5">
                    <label class="form-label">Post text</label>
                    <textarea id="bskyText" class="form-control" rows="6" maxlength="300"></textarea>
                    <div class="form-text">You can also paste a link to your app/page here.</div>
                    <hr class="my-3">
                    <label class="form-label">Bluesky handle</label>
                    <input id="bskyHandle" class="form-control" placeholder="name.bsky.social" autocomplete="username" required>
                    <label class="form-label mt-2">App password</label>
                    <input id="bskyPass" class="form-control" type="password" placeholder="xxxx-xxxx-xxxx-xxxx" autocomplete="current-password" required>
                    <div class="form-check mt-2">
                      <input id="bskyShow" class="form-check-input" type="checkbox">
                      <label class="form-check-label" for="bskyShow">Show password</label>
                    </div>
                    <div class="form-text">
                      Your handle and <strong>app password</strong> are sent <em>directly</em> to Bluesky
                      from your browser. We never store them or send them to our servers.
                    </div>
                  </div>
                </div>
              </div>
              <div class="modal-footer">
                <a id="bskyIntentLink" class="btn btn-outline-secondary" target="_blank" rel="noopener">Open Bluesky composer (text only)</a>
                <button type="submit" class="btn btn-primary">
                  Post to Bluesky
                </button>
              </div>
            </form>
          </div>
        </div>`;
      document.body.appendChild(shell);

      // Wire submit -> login + upload + create
      const form = shell.querySelector('form');
      form.addEventListener('submit', async (e)=>{
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true; btn.textContent = 'Posting…';

        try{
          const handle = form.querySelector('#bskyHandle').value.trim();
          const password = form.querySelector('#bskyPass').value.trim();
          const text = form.querySelector('#bskyText').value;

          if (!shell._shareBlob) throw new Error('Image not ready');
          const sess = await this._bskyCreateSession(handle, password);
          const uploaded = await this._bskyUploadBlob(sess, shell._shareBlob);
          const created  = await this._bskyCreateImagePost(sess, text, uploaded, shell._shareAlt);

          // Delete the session after successful post
          await this._bskyDeleteSession(sess);

          // Open the created post for the user
          const rkey = created?.uri?.split('/').pop();
          const profile = sess.handle || sess.did;
          if (rkey && profile) window.open(`https://bsky.app/profile/${encodeURIComponent(profile)}/post/${encodeURIComponent(rkey)}`, '_blank','noopener');

          bootstrap.Modal.getInstance(shell.querySelector('.modal'))?.hide();
        }catch(err){
          console.error(err);
          alert('Posting failed. Please check your handle/app password and try again.');
        }finally{
          btn.disabled = false; btn.textContent = 'Post to Bluesky';
        }
      });

      // Password toggle
      shell.querySelector('#bskyShow')?.addEventListener('change', e => {
        const pw = shell.querySelector('#bskyPass');
        pw.type = e.target.checked ? 'text' : 'password';
      });

      // Cleanup object URLs when hidden
      shell.querySelector('.modal').addEventListener('hidden.bs.modal', ()=>{
        if (shell._shareUrl) { URL.revokeObjectURL(shell._shareUrl); shell._shareUrl = null; }
        shell._shareBlob = null; shell._shareAlt = null;
        shell.querySelector('#bskyPass').value = '';
      });
    }

    // Prefill text + preview + intent link
    const modal = new bootstrap.Modal(shell.querySelector('.modal'));
    const text = this._composeShareText(tree);
    shell.querySelector('#bskyText').value = text;

    // "Intent" link (text only) as a fallback/open-in-Bluesky option
    const intent = `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.href)}`;
    shell.querySelector('#bskyIntentLink').href = intent;

    // Build the image preview from the current SVG
    try{
      const svg = document.getElementById(`${tree.id}-svg`);
      const { blob, dataUrl, alt } = await this._makeShareImageForBsky(svg, tree);
      // retain for submit
      shell._shareBlob = blob;
      shell._shareAlt  = alt;
      if (shell._shareUrl) URL.revokeObjectURL(shell._shareUrl);
      shell._shareUrl = dataUrl;

      const img = shell.querySelector('#bskyPreviewImg');
      img.alt = alt;
      img.src = dataUrl;
    }catch(err){
      console.error('Preview failed', err);
      alert('Could not prepare the image preview.');
    }

    modal.show();
  }

  // --- Minimal Bluesky API calls (app-password flow) ---

  async _bskyCreateSession(identifier, password){
    const resp = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ identifier, password })
    });
    if (!resp.ok) throw new Error('createSession failed');
    const data = await resp.json();
    return { ...data, pds: 'https://bsky.social' };
  }

  async _bskyUploadBlob(sess, blob){
    const u = `${sess.pds}/xrpc/com.atproto.repo.uploadBlob`;
    const resp = await fetch(u, {
      method:'POST',
      headers:{
        'Authorization': `Bearer ${sess.accessJwt}`,
        'Content-Type': blob.type || 'image/png'
      },
      body: blob
    });
    if (!resp.ok) throw new Error('uploadBlob failed');
    return resp.json(); // { blob:{ ref:{ $link: ... }, mimeType, size } }
  }

  async _bskyCreateImagePost(sess, text, uploadResult, alt){
    const image = uploadResult?.blob;
    const record = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      embed: { $type: 'app.bsky.embed.images', images: [{ image, alt }] }
    };
    const resp = await fetch(`${sess.pds}/xrpc/com.atproto.repo.createRecord`, {
      method:'POST',
      headers:{ 'Authorization': `Bearer ${sess.accessJwt}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ repo: sess.did, collection: 'app.bsky.feed.post', record })
    });
    if (!resp.ok) throw new Error('createRecord failed');
    return resp.json();
  }

  async _bskyDeleteSession(sess){
    try{
      await fetch(`${sess.pds}/xrpc/com.atproto.server.deleteSession`, {
        method:'POST',
        headers:{ 'Authorization': `Bearer ${sess.accessJwt}` }
      });
    }catch(_){}
  }

  // Infer user color from a node's HTML label, if present
  _inferNodeColorFromG(g) {
    if (!g) return null;
    const f = g.querySelector('foreignObject');
    if (!f) return null;
    if (f.querySelector('.shared-node')) return '#9333ea';
    if (f.querySelector('.user1-node'))  return '#dc2626';
    if (f.querySelector('.user2-node'))  return '#2563eb';
    // Checklist classes
    if (f.querySelector('.seen-node'))   return '#22c55e';
    if (f.querySelector('.unseen-node')) return '#9ca3af';
    return null;
  }

_injectRankBadgesIntoAst(root) {
  if (!root || !root.children) return;

  // Map single letters to broad bands (same as before)
  const LETTER_TO_BAND = { F:'family', G:'genus', S:'species', O:'order', C:'class', P:'phylum', K:'kingdom', D:'kingdom' };

  const addBadge = (node, rankOrBand, glyph) => {
    const fine = (rankOrBand || '').toLowerCase();
    const band = RANK_BAND[fine] || fine;      // normalize to band if needed
    const title = fine || band;                // show the fine rank if we know it
    const letter = glyph || (band[0] || '').toUpperCase(); // fallback letter
    const badge = `<span class="mm-badge mm-rank" title="${title}" data-rank="${fine || band}" data-band="${band}">${letter}</span>`;
    node.content = (node.content || '').replace(/\s*$/, ' ') + badge;
  };

  const visit = (node) => {
    if (node.content) {
      let s = node.content;

      // 1) If an explicit {rank:...} token exists, use it and strip it.
      // Accept {rank:*} anywhere, not only at EOL
      const mToken = s.match(/\{rank:([a-z]+)\}/i);
      if (mToken) {
        const fine = mToken[1].toLowerCase();
        s = s.replace(/\s*\{rank:[a-z]+\}\s*/gi, ' ');
        node.content = s;
        addBadge(node, fine);                  // badge with data-rank=fine
      } else {
        // 2) Back-compat: trailing letter code (F G S O C P K D)
        const mLetter = s.match(/(\s)([FGSOCPKD])\s*$/);
        if (mLetter) {
          node.content = s.replace(/(\s)[FGSOCPKD]\s*$/, '$1'); // drop raw letter
          const band = LETTER_TO_BAND[mLetter[2]];
          addBadge(node, band, mLetter[2]);
        }
      }
    }
    if (node.children) node.children.forEach(visit);
  };

  visit(root);
}
  
  /** Paint markmap links to match node/user colors and tag classes for mini-map. */
  _colorLinksAndTagEdges(svg, mm) {
    if (!svg) return;
    const linksBefore = svg.querySelectorAll('path.markmap-link, path.link').length;
    const nodesBefore = svg.querySelectorAll('g.markmap-node, g.node').length;
    __mmdbg?.log && __mmdbg.log('color pass: before', { nodesBefore, linksBefore });

    // Map data-path → color
    const colorByPath = new Map();
    svg.querySelectorAll('g.markmap-node, g.node').forEach(g => {
      const key = g.getAttribute('data-path');
      const c = this._inferNodeColorFromG(g);
      if (key && c) colorByPath.set(key, c);

      // Also tint the short connector line
      const ln = g.querySelector('line');
      if (ln && c) {
        ln.setAttribute('stroke', c);
        ln.style.stroke = c;
      }
    });

    // Color the curved links and tag classes
    svg.querySelectorAll('path.markmap-link, path.link').forEach(linkEl => {
      let c = null;

      // Prefer data-path
      const key = linkEl.getAttribute('data-path');
      if (key && colorByPath.has(key)) c = colorByPath.get(key);

      // Fallback: use bound datum + mm.findElement
      if (!c) {
        const d = linkEl.__data__;
        const target = d && d.target;
        if (target && typeof mm?.findElement === 'function') {
          try {
            const el = mm.findElement(target);
            if (el?.g) c = this._inferNodeColorFromG(el.g);
          } catch (_) {}
        }
      }

      if (!c) return;

      linkEl.setAttribute('stroke', c);
      linkEl.style.stroke = c;
      linkEl.style.strokeOpacity = '1';
      linkEl.style.fill = 'none';

      linkEl.classList.remove('user1-edge','user2-edge','shared-edge','seen-edge','unseen-edge','missing-edge');
      if (c === '#dc2626') linkEl.classList.add('user1-edge');
      else if (c === '#2563eb') linkEl.classList.add('user2-edge');
      else if (c === '#9333ea') linkEl.classList.add('shared-edge');
      else if (c === '#22c55e') linkEl.classList.add('seen-edge');
      else if (c === '#9ca3af') linkEl.classList.add('unseen-edge','missing-edge');
    });
    const linksAfter = svg.querySelectorAll('path.markmap-link, path.link').length;
    __mmdbg?.log && __mmdbg.log('color pass: after', { linksAfter });
  }
}


// Individual trees (Explore)
window.treeManager = window.treeManager || new TreeManager({
  idPrefix: 'tree',
  resultsCardId: 'resultsCard',
  tabsId: 'treeTabs',
  contentId: 'treeTabContent',
  deleteBtnId: 'deleteAllTrees'
});

// PvP comparison trees (PvP tab)
window.pvpManager = window.pvpManager || new TreeManager({
  idPrefix: 'pvp',
  resultsCardId: 'pvpResultsCard',
  tabsId: 'pvpTreeTabs',
  contentId: 'pvpTreeTabContent',
  deleteBtnId: 'pvpDeleteAllTrees'
});

// Checklist trees (Checklist tab)
window.checklistManager = window.checklistManager || new TreeManager({
  idPrefix: 'checklist',
  resultsCardId: 'clResultsCard',
  tabsId: 'clTreeTabs',
  contentId: 'clTreeTabContent',
  deleteBtnId: 'clClearBtn'
});