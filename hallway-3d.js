// hallway-3d.js — 3D taxonomic hallway view.
//
// Builds an immersive branching corridor of a user's iNaturalist observations.
// The taxonomic tree is laid out as a fan of connected rooms: junctions hold
// doorways to child taxa, galleries hang species cards on the walls, and a
// lone species sits on a centerpiece pedestal. Click a gate to walk through;
// click a card to flip it for stats + a Leaflet map.
//
// Mobile: drag to look, single-tap to interact, double-tap to walk forward
// in the direction you tapped (snaps to the nearest waypoint).

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RANK_BAND = Object.freeze({
  stateofmatter: 'state',
  domain: 'kingdom', superkingdom: 'kingdom', kingdom: 'kingdom',
  phylum: 'phylum', subphylum: 'phylum',
  superclass: 'class', class: 'class', subclass: 'class', subterclass: 'class', infraclass: 'class',
  superorder: 'order', order: 'order', suborder: 'order', infraorder: 'order', parvorder: 'order',
  zoosection: 'order', zoosubsection: 'order',
  superfamily: 'family', epifamily: 'family', family: 'family', subfamily: 'family',
  supertribe: 'tribe', tribe: 'tribe', subtribe: 'tribe',
  genus: 'genus', genushybrid: 'genus', subgenus: 'genus', section: 'genus', subsection: 'genus',
  complex: 'species', species: 'species', hybrid: 'species', infrahybrid: 'species',
  subspecies: 'species', variety: 'species', form: 'species'
});

const BAND_COLOR_HEX = {
  state:   0x64748b, kingdom: 0xa855f7, phylum: 0xef4444,
  class:   0xf59e0b, order:   0x6366f1, family: 0x06b6d4,
  tribe:   0x0ea5e9, genus:   0x10b981, species: 0x22c55e
};

const BAND_COLOR_CSS = {
  state:   '#64748b', kingdom: '#a855f7', phylum: '#ef4444',
  class:   '#f59e0b', order:   '#6366f1', family: '#06b6d4',
  tribe:   '#0ea5e9', genus:   '#10b981', species: '#22c55e'
};

function bandOf(rank) {
  return RANK_BAND[String(rank || '').toLowerCase()] || 'species';
}
function colorForRank(rank) {
  return BAND_COLOR_HEX[bandOf(rank)] ?? BAND_COLOR_HEX.species;
}
function cssColorForRank(rank) {
  return BAND_COLOR_CSS[bandOf(rank)] || BAND_COLOR_CSS.species;
}
function capitalize(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// World layout
const ROOM_WIDTH      = 6.0;    // junction interior width
const ROOM_DEPTH      = 5.0;    // junction interior depth
const GALLERY_WIDTH   = 7.0;
const GALLERY_DEPTH   = 6.0;
const PEDESTAL_SIZE   = 4.2;
const WALL_HEIGHT     = 3.4;
const PILLAR_RADIUS   = 0.13;
const PILLAR_HEIGHT   = 2.2;
const ROOM_SPACING    = 14.0;   // base distance between parent + child room centers
const CARD_W          = 1.25;
const CARD_H          = 0.95;
const CARD_Y          = 1.65;
const CAMERA_HEIGHT   = 1.65;
const GATE_W          = 1.5;
const GATE_H          = 2.6;
const MAX_RENDERED    = 240;    // safety cap on number of rendered rooms+leaves
// LOD culling: rooms farther than this from the camera are hidden each tick
// (their meshes stay in the scene but skip rendering). The fog fades out
// before culling kicks in so pop-in is hidden by the fade-to-black.
const ROOM_VISIBLE_RADIUS = 60.0;
const ROOM_VISIBLE_RADIUS_SQ = ROOM_VISIBLE_RADIUS * ROOM_VISIBLE_RADIUS;

// Input tuning
const DOUBLE_TAP_MS   = 350;
const DOUBLE_TAP_PX   = 32;
const TAP_DRAG_PX     = 8;

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------
async function fetchUserSpecies({ username, baseTaxonId, d1, d2, onProgress }) {
  const per = 200;
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const u = new URL('https://api.inaturalist.org/v1/observations/species_counts');
    u.searchParams.set('user_login', username);
    u.searchParams.set('taxon_id', String(baseTaxonId));
    if (d1) u.searchParams.set('d1', d1);
    if (d2) u.searchParams.set('d2', d2);
    u.searchParams.set('verifiable', 'any');
    u.searchParams.set('quality_grade', 'any');
    u.searchParams.set('per_page', String(per));
    u.searchParams.set('page', String(page));
    const r = await fetch(u);
    if (!r.ok) throw new Error('iNat API error: ' + r.status);
    const j = await r.json();
    const rows = j.results || [];
    for (const row of rows) {
      const t = row.taxon;
      if (!t || !t.id) continue;
      out.push({
        id: t.id,
        name: t.name,
        common: t.preferred_common_name || '',
        rank: String(t.rank || 'species').toLowerCase(),
        ancestors: Array.isArray(t.ancestor_ids) ? t.ancestor_ids : [],
        count: row.count || 1,
        defaultPhoto: t.default_photo?.medium_url || t.default_photo?.square_url || null
      });
    }
    onProgress?.({ page, total: out.length });
    if (rows.length < per) break;
    await new Promise(res => setTimeout(res, 200));
  }
  return out;
}

async function fetchTaxaNames(ids, onProgress) {
  const out = {};
  const chunk = 30;
  const batches = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const c = ids.slice(i, i + chunk).filter(Boolean);
    if (c.length) batches.push(c);
  }
  if (!batches.length) { onProgress?.(0, 0); return out; }

  let done = 0;
  let next = 0;
  const concurrency = 4;
  async function worker() {
    while (next < batches.length) {
      const my = next++;
      const c = batches[my];
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const r = await fetch(
          `https://api.inaturalist.org/v1/taxa/${c.join(',')}`,
          { signal: ctrl.signal }
        );
        clearTimeout(timer);
        if (r.ok) {
          const j = await r.json();
          for (const t of (j.results || [])) {
            out[t.id] = {
              name: t.name,
              common: t.preferred_common_name || '',
              rank: String(t.rank || '').toLowerCase()
            };
          }
        }
      } catch (e) {
        // network or timeout — skip this batch silently
      }
      done++;
      onProgress?.(done, batches.length);
    }
  }
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

async function fetchObservationsForCard({ username, taxonId, max = 80 }) {
  const u = new URL('https://api.inaturalist.org/v1/observations');
  u.searchParams.set('user_login', username);
  u.searchParams.set('taxon_id', String(taxonId));
  u.searchParams.set('per_page', String(max));
  u.searchParams.set('geo', 'true');
  u.searchParams.set('order_by', 'observed_on');
  u.searchParams.set('order', 'asc');
  const r = await fetch(u);
  if (!r.ok) return { points: [], first: null };
  const j = await r.json();
  const points = [];
  let first = null;
  for (const row of (j.results || [])) {
    let lat = null, lon = null;
    if (row.location) {
      const [la, lo] = String(row.location).split(',').map(Number);
      if (Number.isFinite(la) && Number.isFinite(lo)) { lat = la; lon = lo; }
    } else if (row.geojson?.coordinates?.length === 2) {
      const [lo, la] = row.geojson.coordinates.map(Number);
      if (Number.isFinite(la) && Number.isFinite(lo)) { lat = la; lon = lo; }
    }
    if (lat != null) points.push({ lat, lon, id: row.id, observed_on: row.observed_on });
    if (!first) first = row;
  }
  return { points, first };
}

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------
function chunkLabel(node) {
  if (!node) return '';
  const rank = node.rank ? capitalize(node.rank) + ' ' : '';
  return `${rank}${node.name || ''}`.trim();
}

// Build the raw taxonomic tree from species rows + ancestor metadata.
function buildRawTree(species, baseTaxonId, ancestorMeta) {
  const nodes = new Map();
  const base = Number(baseTaxonId);

  const makeNode = (id, meta) => {
    let n = nodes.get(id);
    if (!n) {
      n = {
        id,
        name: meta?.name || `Taxon ${id}`,
        common: meta?.common || '',
        rank: String(meta?.rank || '').toLowerCase(),
        children: new Map(),
        speciesUnder: 0,
        species: null,
        parent: null
      };
      nodes.set(id, n);
    } else if (meta) {
      if (!n.name || n.name.startsWith('Taxon ')) n.name = meta.name || n.name;
      if (!n.common) n.common = meta.common || n.common;
      if (!n.rank) n.rank = String(meta.rank || '').toLowerCase();
    }
    return n;
  };

  for (const s of species) {
    let chain = [...s.ancestors];
    const baseIdx = chain.indexOf(base);
    if (baseIdx >= 0) chain = chain.slice(baseIdx);
    else chain = [base, ...chain];

    // iNat's ancestor_ids array often *already* includes the taxon's own id
    // as the last entry. Pushing s.id again would create chain[N-2] === chain[N-1],
    // which makes that node a child of itself in the loop below — and then
    // finalize() recurses forever (RangeError: Maximum call stack size exceeded).
    // De-dupe defensively and ensure s.id sits exactly once at the end.
    const seen = new Set();
    chain = chain.filter(id => {
      if (id === s.id) return false;        // we'll re-append below
      if (seen.has(id)) return false;       // drop any other dupes
      seen.add(id);
      return true;
    });
    chain.push(s.id);

    let parent = null;
    for (let i = 0; i < chain.length; i++) {
      const id = chain[i];
      const meta = (i === chain.length - 1)
        ? { name: s.name, common: s.common, rank: s.rank }
        : ancestorMeta[id];
      const n = makeNode(id, meta);
      if (i === chain.length - 1) n.species = s;
      if (parent && parent !== n && !parent.children.has(id)) {
        parent.children.set(id, n);
        n.parent = parent;
      }
      parent = n;
    }
  }

  // Both walks carry a `visited` set so a cycle (from any source — bad iNat
  // data, future bug) can't recurse forever.
  const finalize = (n, visited = new Set()) => {
    if (visited.has(n)) return;
    visited.add(n);
    n.children = [...n.children.values()];
    n.children.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const c of n.children) finalize(c, visited);
  };
  const count = (n, visited = new Set()) => {
    if (visited.has(n)) return n.speciesUnder || 0;
    visited.add(n);
    if (n.species) { n.speciesUnder = 1; return 1; }
    let total = 0;
    for (const c of n.children) total += count(c, visited);
    n.speciesUnder = total;
    return total;
  };

  const root = nodes.get(base);
  if (!root) return null;
  finalize(root);
  count(root);
  return root;
}

// Apply collapse rules: any non-root, non-leaf node with exactly one non-leaf
// child gets folded into that child's "path prefix" so we don't render
// pointless single-doorway rooms.
function buildRenderedTree(rawRoot) {
  let nodeCount = 0;

  function makeRendered(rawNode, pathPrefix) {
    nodeCount++;
    return {
      id: rawNode.id,
      name: rawNode.name,
      common: rawNode.common,
      rank: rawNode.rank,
      pathPrefix,
      speciesUnder: rawNode.speciesUnder,
      species: rawNode.species,
      isLeafSpecies: !!rawNode.species,
      children: [],
      parent: null
    };
  }

  function build(rawNode, pathPrefix) {
    if (
      !rawNode.species &&
      rawNode.children.length === 1 &&
      !rawNode.children[0].species
    ) {
      const newPrefix = [...pathPrefix, chunkLabel(rawNode)];
      return build(rawNode.children[0], newPrefix);
    }

    const rendered = makeRendered(rawNode, pathPrefix);
    if (!rawNode.species) {
      for (const c of rawNode.children) {
        const ch = build(c, []);
        ch.parent = rendered;
        rendered.children.push(ch);
        if (nodeCount > MAX_RENDERED) break;
      }
    }
    return rendered;
  }

  // Keep the user's chosen base taxon as the visible root, even if it has
  // only one child. Recurse into its children with collapse applied.
  const root = makeRendered(rawRoot, []);
  if (!rawRoot.species) {
    for (const c of rawRoot.children) {
      const ch = build(c, []);
      ch.parent = root;
      root.children.push(ch);
      if (nodeCount > MAX_RENDERED) break;
    }
  }
  return root;
}

// Classify each node as 'junction', 'gallery', 'pedestal', or 'leaf'.
// - 'leaf'     : the node IS a species; embedded inside its parent room.
// - 'pedestal' : node whose only children are species, and only one species.
// - 'gallery'  : node whose only children are species, with 2+ species.
// - 'junction' : node with one or more sub-room children.
// Mixed nodes (some species + some sub-rooms) get the loose species moved
// into a synthetic gallery child labeled "Other species".
function classifyTree(root) {
  function visit(n) {
    if (n.isLeafSpecies) { n.roomType = 'leaf'; return; }
    n.children.forEach(visit);

    const leaves = n.children.filter(c => c.isLeafSpecies);
    const subs   = n.children.filter(c => !c.isLeafSpecies);

    if (subs.length === 0) {
      n.roomType = leaves.length === 1 ? 'pedestal' : 'gallery';
      n._cards = leaves;
    } else {
      n.roomType = 'junction';
      if (leaves.length > 0) {
        const synth = {
          id: -Math.abs(n.id) - 999, // synthetic ID
          name: leaves.length === 1
            ? leaves[0].name
            : `Other ${n.rank ? n.rank : 'taxa'}`,
          common: '',
          rank: '',
          pathPrefix: [],
          speciesUnder: leaves.length,
          species: null,
          isLeafSpecies: false,
          children: leaves.slice(),
          parent: n,
          roomType: leaves.length === 1 ? 'pedestal' : 'gallery',
          _cards: leaves.slice(),
          _isSynthetic: true
        };
        leaves.forEach(l => { l.parent = synth; });
        n.children = [...subs, synth];
      }
      // For junctions, keep n._cards empty
      n._cards = [];
    }
  }
  visit(root);
}

// Radial fan layout: each non-leaf node gets a (position, forward).
// Children fan out within the parent's allotted angular wedge, weighted by
// the species count under each child so dense branches get more breathing room.
function layoutTree(root) {
  function place(node, allottedArc) {
    const subs = (node.children || []).filter(c => c.roomType !== 'leaf');
    if (!subs.length) return;

    const totalUnder = subs.reduce((s, c) => s + Math.max(1, c.speciesUnder || 1), 0);
    const spread = Math.max(Math.PI * 0.18, Math.min(Math.PI * 0.85, allottedArc));

    let cum = 0;
    for (const c of subs) {
      const w = Math.max(1, c.speciesUnder || 1) / totalUnder;
      // Center of this child's angular slot in [-0.5, 0.5]
      const tCenter = cum + w / 2 - 0.5;
      cum += w;
      const angleOffset = tCenter * spread;

      const pf = node.forward;
      const cosA = Math.cos(angleOffset), sinA = Math.sin(angleOffset);
      const cf = new THREE.Vector3(
        pf.x * cosA + pf.z * sinA,
        0,
        -pf.x * sinA + pf.z * cosA
      ).normalize();

      const diversityBoost = Math.log2((c.speciesUnder || 1) + 1) * 1.4;
      const dist = ROOM_SPACING + diversityBoost;
      c.forward = cf;
      c.position = node.position.clone().add(cf.clone().multiplyScalar(dist));

      place(c, w * spread);
    }
  }

  root.position = new THREE.Vector3(0, 0, 0);
  root.forward  = new THREE.Vector3(0, 0, -1);
  place(root, Math.PI * 0.7);
}

function collectRoomNodes(root) {
  const out = [];
  function walk(n) {
    if (n.roomType !== 'leaf') out.push(n);
    if (n.children) for (const c of n.children) walk(c);
  }
  walk(root);
  return out;
}

function buildBreadcrumb(node) {
  const segs = [];
  let cur = node;
  while (cur) {
    if (cur.pathPrefix && cur.pathPrefix.length) {
      for (let i = cur.pathPrefix.length - 1; i >= 0; i--) {
        segs.unshift({ label: cur.pathPrefix[i], nodeId: null });
      }
    }
    segs.unshift({ label: chunkLabel(cur), nodeId: cur.id });
    cur = cur.parent;
  }
  return segs;
}

// Linear mode: ignore the tree, group species by their direct parent (the
// genus for most species) so all members of a genus stay together on the
// wall. Order down the corridor is taxonomic: alphabetical chain of
// ancestor names (Family › Genus › Species), so you walk family by family,
// genus by genus. A genus with more than `perBay` species fills consecutive
// bays. A bay never mixes species from different genera — a sparse genus
// just leaves empty slots on the wall, which keeps the structure legible.
function groupSpeciesIntoLinearBays(species, perBay = 6, ancestorMeta = {}) {
  const directParentId = (s) => {
    const a = s.ancestors || [];
    for (let i = a.length - 1; i >= 0; i--) {
      if (a[i] !== s.id) return a[i];
    }
    return 0;
  };
  const sortKey = (s) => {
    const ids = (s.ancestors || []).filter(id => id !== s.id);
    // Pad numeric IDs so unknown-name fallback sorts stably (no name => `~<id>`)
    const segs = ids.map(id => {
      const meta = ancestorMeta[id];
      return meta?.name ? meta.name.toLowerCase() : `~${id}`;
    });
    segs.push((s.name || '').toLowerCase());
    return segs.join(' / ');
  };
  const sorted = [...species].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });

  // Group consecutive sorted species by their direct parent id.
  const groups = [];
  let current = null;
  for (const s of sorted) {
    const p = directParentId(s);
    if (!current || current.parentId !== p) {
      current = { parentId: p, species: [] };
      groups.push(current);
    }
    current.species.push(s);
  }

  // Pack each group into bays without mixing groups across bays. Genera
  // with >perBay species spill into consecutive bays that share the same
  // shared-ancestor id (so the HUD continues reading "Genus Foo").
  const bays = [];
  for (const group of groups) {
    const parts = Math.max(1, Math.ceil(group.species.length / perBay));
    for (let i = 0; i < group.species.length; i += perBay) {
      const slice = group.species.slice(i, i + perBay);
      bays.push({
        species: slice,
        sharedAncestorId: group.parentId,
        partIndex: Math.floor(i / perBay),
        partTotal: parts
      });
    }
  }
  return bays;
}

// ---------------------------------------------------------------------------
// Texture helpers
// ---------------------------------------------------------------------------
const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin('anonymous');
const textureCache = new Map();

// Per-session photo diagnostics — we rate-limit to a handful of console
// warnings so a CORS-blocked CDN doesn't flood the log.
const _photoDiag = { logged: 0, hintShown: false };
function _diagnosePhotoFailure(kind, url, info) {
  if (_photoDiag.logged > 4) return;
  _photoDiag.logged++;
  console.warn(`[hallway photo] ${kind} failed for ${url} — ${info}`);
  if (!_photoDiag.hintShown) {
    _photoDiag.hintShown = true;
    console.warn(
      '[hallway] If you see "Failed to fetch" or "TypeError" above, the iNat ' +
      'photo CDN is refusing CORS — WebGL cannot upload a tainted image as a texture. ' +
      'The fix is a same-origin image proxy on the worker (e.g. /img-proxy?url=...).'
    );
  }
}

// Modern loader: fetch the bytes (respects CORS), build an ImageBitmap, hand
// to THREE.Texture. Falls back to TextureLoader if fetch isn't available
// (very old browsers) so we still try as hard as possible. Also makes
// failures observable — the old loader silently resolved null on any error.
async function loadPhotoTexture(url) {
  if (!url) return null;
  if (textureCache.has(url)) return textureCache.get(url);

  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!r.ok) {
      _diagnosePhotoFailure('HTTP', url, `status ${r.status}`);
      return null;
    }
    const blob = await r.blob();
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      _diagnosePhotoFailure('decode', url, e.message || String(e));
      return null;
    }
    const tex = new THREE.Texture(bitmap);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    textureCache.set(url, tex);
    return tex;
  } catch (e) {
    _diagnosePhotoFailure('fetch', url, e.message || String(e));
    // Fallback to TextureLoader (works when fetch is unavailable). Will
    // hit the same CORS wall in practice, but worth one more try.
    try {
      const tex = await new Promise((resolve, reject) => {
        textureLoader.load(url, resolve, undefined, reject);
      });
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      textureCache.set(url, tex);
      return tex;
    } catch {
      return null;
    }
  }
}

function loadTexture(url) {
  if (!url) return Promise.resolve(null);
  if (textureCache.has(url)) return Promise.resolve(textureCache.get(url));
  return new Promise(resolve => {
    textureLoader.load(
      url,
      tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        textureCache.set(url, tex);
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 3) {
  const words = String(text).split(/\s+/);
  let line = '';
  const lines = [];
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  const startY = y - ((shown.length - 1) * lineHeight) / 2;
  shown.forEach((ln, i) => ctx.fillText(ln, x, startY + i * lineHeight));
}

// Front-of-card placeholder shown until the user's first-observation photo
// loads (or as the permanent state if no photo is available). The species
// name lives on a separate nameplate now, so the placeholder is intentionally
// quiet — a rank-color gradient with a faint rank-initial watermark — so it
// doesn't look "wrong" when it's the final state.
function makeLabelTexture({ color = '#22c55e', rank = '' }) {
  const w = 256, h = 192;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#1f2937');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.strokeRect(3, 3, w - 6, h - 6);
  // Faint rank-initial watermark
  const letter = (rank || '?').charAt(0).toUpperCase();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.18;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 96px Georgia, serif';
  ctx.fillText(letter, w / 2, h / 2);
  ctx.globalAlpha = 1.0;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Small museum-style "nameplate" that hangs under each card with the
// scientific + common name. Always visible from the corridor side so users
// know what they're looking at even before the photo loads (or if it never
// does).
function makeNameplateTexture(species) {
  const w = 440, h = 88;  // 5:1 to match the plate plane aspect
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#1d2638');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const accent = cssColorForRank(species.rank);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (species.common) {
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'italic 700 22px Georgia, serif';
    wrapText(ctx, species.name || '—', w / 2, h / 2 - 14, w - 20, 24, 1);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 15px sans-serif';
    wrapText(ctx, species.common, w / 2, h / 2 + 14, w - 20, 18, 1);
  } else {
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'italic 700 26px Georgia, serif';
    wrapText(ctx, species.name || '—', w / 2, h / 2, w - 20, 28, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeBackTexture(species) {
  const w = 512, h = 384;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const accent = cssColorForRank(species.rank);
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#1f2937');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, w - 8, h - 8);
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'italic 700 38px Georgia, serif';
  wrapText(ctx, species.name || '—', w / 2, 90, w - 60, 42, 2);
  if (species.common) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 22px sans-serif';
    wrapText(ctx, species.common, w / 2, 160, w - 60, 26, 1);
  }
  ctx.fillStyle = accent;
  ctx.font = '700 18px sans-serif';
  ctx.fillText(`${(species.rank || '').toUpperCase()}`, w / 2, 220);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '500 20px sans-serif';
  ctx.fillText(`${species.count} observation${species.count === 1 ? '' : 's'}`, w / 2, 260);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 16px sans-serif';
  ctx.fillText('Tap to view details →', w / 2, h - 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGateSignTexture({ title, subtitle, accent, count }) {
  const w = 512, h = 192;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 36px Georgia, serif';
  wrapText(ctx, title || '—', w / 2, 60, w - 30, 40, 1);
  if (subtitle) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 22px sans-serif';
    wrapText(ctx, subtitle, w / 2, 108, w - 40, 24, 1);
  }
  if (count != null) {
    ctx.fillStyle = accent;
    ctx.font = '700 22px sans-serif';
    ctx.fillText(`${count} species ▸`, w / 2, h - 38);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRoomPlinthTexture({ title, subtitle, accent, prefix }) {
  const w = 768, h = 384;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#1d2638');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, w - 8, h - 8);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (prefix && prefix.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 22px sans-serif';
    wrapText(ctx, prefix.join(' › '), w / 2, 50, w - 40, 26, 2);
  }

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'italic 800 56px Georgia, serif';
  wrapText(ctx, title || '—', w / 2, h / 2 - 10, w - 60, 60, 2);

  if (subtitle) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 26px sans-serif';
    wrapText(ctx, subtitle, w / 2, h / 2 + 80, w - 60, 32, 1);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// HallwayScene
// ---------------------------------------------------------------------------
class HallwayScene {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.layoutMode = ctx.layoutMode || 'branching'; // 'branching' | 'linear'
    this.species = [];
    this.tree = null;
    this.linearBays = [];     // populated when layoutMode === 'linear'
    this._ancestorMeta = {};  // cached across rebuilds
    this.rooms = [];          // every room node in render order
    this.cards = [];          // { group, flipGroup, frontMesh, backMesh, species, room, ... }
    this.gates = [];          // { mesh, parentNode, childNode, position, normal }
    this.waypoints = [];      // { position, yaw, kind, ref }
    this.disposeFns = [];

    this._currentRoom = null;
    this._activeCard = null;
    this._locked = false;
    this._cameraTween = null;
    this._frameId = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06070a);
    // Tighter fog so distant rooms fade to black before they're culled.
    this.scene.fog = new THREE.Fog(0x06070a, 14, 55);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 400);
    this.camera.position.set(0, CAMERA_HEIGHT, 6);
    this.camera.rotation.order = 'YXZ';

    this.structureGroup = new THREE.Group();
    this.scene.add(this.structureGroup);
    this.cardsGroup = new THREE.Group();
    this.scene.add(this.cardsGroup);
    // Raycasting uses direct arrays (this.cards / this.gates) — we do NOT
    // re-parent meshes into a separate "interactives" group, because that
    // would steal them from their flipGroup/gateGroup transforms.

    this.raycaster = new THREE.Raycaster();
    this.mouseNdc = new THREE.Vector2();

    // Input state
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.dragging = false;
    this.lastMouse = { x: 0, y: 0 };
    this._dragTotal = 0;
    this._pointerDownPos = null;
    this._pointerDownTime = 0;
    this._lastTap = null;     // { x, y, t } for double-tap detection

    this.clock = new THREE.Clock();

    this._setupLights();
    this._attachEvents();
    this._resize();
  }

  _setupLights() {
    // We deliberately avoid per-room PointLights — they used to add one per
    // junction, which compiled hundreds of light slots into every material
    // and tanked the framerate on big taxa like Lepidoptera. Instead the
    // scene uses three global lights plus a single player-follow light that
    // moves with the camera so wherever the user looks is well-lit.
    const ambient = new THREE.AmbientLight(0xfff5e6, 0.55);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xfff0d6, 0.55);
    dir.position.set(2, 8, 6);
    this.scene.add(dir);
    const hemi = new THREE.HemisphereLight(0x8090a0, 0x0c0c12, 0.45);
    this.scene.add(hemi);
    // Player-follow point light: bright cone right around the camera, dies
    // off quickly so it doesn't affect distant rooms.
    this._followLight = new THREE.PointLight(0xffe6b8, 1.5, 14, 1.8);
    this._followLight.position.copy(this.camera.position);
    this.scene.add(this._followLight);
  }

  _attachEvents() {
    const onResize = () => this._resize();
    window.addEventListener('resize', onResize);
    this.disposeFns.push(() => window.removeEventListener('resize', onResize));

    const onKeyDown = (e) => {
      if (!this._isVisible()) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      this.keys.add(e.code);
      if (e.code === 'Escape' && this._activeCard) {
        e.preventDefault();
        this._closeActiveCard();
      }
    };
    const onKeyUp = (e) => { this.keys.delete(e.code); };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    this.disposeFns.push(() => document.removeEventListener('keydown', onKeyDown));
    this.disposeFns.push(() => document.removeEventListener('keyup', onKeyUp));

    const onPointerDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (this._activeCard) return;
      this.dragging = true;
      this._dragTotal = 0;
      this._pointerDownPos = { x: e.clientX, y: e.clientY };
      this._pointerDownTime = performance.now();
      this.lastMouse.x = e.clientX;
      this.lastMouse.y = e.clientY;
      this.canvas.classList.add('is-dragging');
      this.canvas.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      this.lastMouse.x = e.clientX;
      this.lastMouse.y = e.clientY;
      this._dragTotal += Math.abs(dx) + Math.abs(dy);
      this.yaw   -= dx * 0.0035;
      this.pitch -= dy * 0.0035;
      this.pitch = Math.max(-0.75, Math.min(0.75, this.pitch));
    };
    const onPointerUp = (e) => {
      const wasDragging = this.dragging;
      this.dragging = false;
      this.canvas.classList.remove('is-dragging');
      this.canvas.releasePointerCapture?.(e.pointerId);
      if (!wasDragging || this._activeCard) return;
      // Was it a tap? (not a drag)
      if (this._dragTotal < TAP_DRAG_PX) {
        const now = performance.now();
        const x = e.clientX, y = e.clientY;
        const prev = this._lastTap;
        const isDouble = prev
          && (now - prev.t) < DOUBLE_TAP_MS
          && Math.hypot(prev.x - x, prev.y - y) < DOUBLE_TAP_PX;
        if (isDouble) {
          this._lastTap = null;
          this._handleDoubleTap(x, y);
        } else {
          this._lastTap = { x, y, t: now };
          this._handleSingleTap(x, y);
        }
      }
    };
    this.canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    this.disposeFns.push(() => this.canvas.removeEventListener('pointerdown', onPointerDown));
    this.disposeFns.push(() => window.removeEventListener('pointermove', onPointerMove));
    this.disposeFns.push(() => window.removeEventListener('pointerup', onPointerUp));

    const onWheel = (e) => {
      if (this._activeCard) return;
      e.preventDefault();
      const fwd = this._forwardVec();
      const step = -e.deltaY * 0.006;
      this.camera.position.addScaledVector(fwd, step);
    };
    this.canvas.addEventListener('wheel', onWheel, { passive: false });
    this.disposeFns.push(() => this.canvas.removeEventListener('wheel', onWheel));

    const onContextMenu = (e) => e.preventDefault();
    this.canvas.addEventListener('contextmenu', onContextMenu);
    this.disposeFns.push(() => this.canvas.removeEventListener('contextmenu', onContextMenu));
  }

  _isVisible() {
    const el = document.getElementById('hallwayScene');
    return !!el && el.style.display !== 'none';
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _forwardVec() {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize();
    return f;
  }
  _rightVec() {
    const fwd = this._forwardVec();
    return new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  }

  // -------------------------------------------------------------------------
  // Build pipeline
  // -------------------------------------------------------------------------
  async build(species, onProgress) {
    this.species = species;
    this._onBuildProgress = onProgress || null;

    if (this.layoutMode === 'linear') {
      await this._buildLinearScene(onProgress);
    } else {
      await this._buildBranchingScene(onProgress);
    }

    onProgress?.({ pct: 1.0, label: 'Hallway ready' });

    // Async load user's first-observation photos to populate card fronts.
    this._loadUserPhotos();
    this._refreshLayoutToggleBtn();
  }

  async _buildBranchingScene(onProgress) {
    onProgress?.({ pct: 0.02, label: 'Loading taxonomy' });

    // Gather every ancestor id we touch + the base
    const ids = new Set([this.ctx.baseTaxonId]);
    for (const s of this.species) for (const a of s.ancestors) ids.add(a);
    // Reuse cached metadata across rebuilds so toggling modes is fast.
    const missing = [...ids].filter(id => !this._ancestorMeta[id]);
    if (missing.length) {
      const fetched = await fetchTaxaNames(missing, (done, total) => {
        const p = total ? done / total : 1;
        onProgress?.({ pct: 0.02 + 0.30 * p, label: `Loading taxonomy (${done}/${total})` });
      });
      Object.assign(this._ancestorMeta, fetched);
    }
    onProgress?.({ pct: 0.34, label: 'Arranging the tree' });
    await yieldFrame();

    const rawRoot = buildRawTree(this.species, this.ctx.baseTaxonId, this._ancestorMeta);
    if (!rawRoot) return;
    const rendered = buildRenderedTree(rawRoot);
    classifyTree(rendered);
    layoutTree(rendered);
    this.tree = rendered;

    this.rooms = collectRoomNodes(rendered);
    onProgress?.({ pct: 0.40, label: `Building rooms (0/${this.rooms.length})` });
    this._buildWorld();

    await this._buildAllRooms((done, total) => {
      const p = total ? done / total : 1;
      onProgress?.({ pct: 0.40 + 0.45 * p, label: `Building rooms (${done}/${total})` });
    });

    await this._buildAllConnectors((done, total) => {
      const p = total ? done / total : 1;
      onProgress?.({ pct: 0.85 + 0.10 * p, label: `Connecting rooms` });
    });

    onProgress?.({ pct: 0.97, label: 'Stepping inside' });
    this._currentRoom = rendered;
    this._enterRoom(rendered, /*instant=*/true);
  }

  async _buildLinearScene(onProgress) {
    onProgress?.({ pct: 0.03, label: 'Loading taxonomy' });
    const cap = MAX_RENDERED * 6;
    const subset = this.species.slice(0, cap);

    // Resolve every ancestor name BEFORE we sort, so the corridor order is a
    // proper alphabetical walk of the taxonomic tree (Family › Genus ›
    // Species) instead of an arbitrary order by iNat numeric IDs. Cached
    // names are reused across rebuilds, so toggling back to linear after
    // branching has filled the cache is essentially free.
    const ids = new Set();
    for (const s of subset) for (const a of s.ancestors) ids.add(a);
    const missing = [...ids].filter(id => !this._ancestorMeta[id]);
    if (missing.length) {
      const fetched = await fetchTaxaNames(missing, (done, total) => {
        const p = total ? done / total : 1;
        onProgress?.({ pct: 0.03 + 0.25 * p, label: `Loading taxonomy (${done}/${total})` });
      });
      Object.assign(this._ancestorMeta, fetched);
    }
    onProgress?.({ pct: 0.30, label: 'Grouping species by genus' });

    // Group by direct parent (genus for most species), ordered by ancestor
    // names — walking the corridor now goes family by family, genus by
    // genus. Each bay holds at most one genus; a genus with more than 6
    // species spills into consecutive bays.
    const bays = groupSpeciesIntoLinearBays(subset, 6, this._ancestorMeta);
    this.linearBays = bays;
    this.tree = null;
    this.rooms = [];

    onProgress?.({ pct: 0.34, label: `Building bays (0/${bays.length})` });
    await this._buildLinearCorridor(bays, (done, total) => {
      const p = total ? done / total : 1;
      onProgress?.({ pct: 0.34 + 0.62 * p, label: `Building bays (${done}/${total})` });
    });
  }

  // Mode swap from inside the running scene. Tears down the current geometry
  // and rebuilds with the alternate layout, reusing this.species and any
  // cached ancestor metadata.
  async setLayoutMode(mode, onProgress) {
    if (mode !== 'branching' && mode !== 'linear') return;
    if (mode === this.layoutMode) return;
    this.layoutMode = mode;
    this._resetForRebuild();
    await this.build(this.species, onProgress);
  }

  _resetForRebuild() {
    this.pause();
    if (this._activeCard) this._closeActiveCard();
    this._cameraTween = null;

    // Wipe everything that was added to the scene by previous build().
    const keep = []; // nothing — even lights get rebuilt by _setupLights below
    while (this.scene.children.length) {
      const obj = this.scene.children[this.scene.children.length - 1];
      this.scene.remove(obj);
      obj.traverse?.(c => {
        if (c.geometry) c.geometry.dispose?.();
        if (c.material) {
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          for (const m of mats) {
            if (m.map) {
              const src = m.map.source?.data?.src;
              if (!src || !textureCache.has(src)) m.map.dispose?.();
            }
            m.dispose?.();
          }
        }
      });
    }

    this.structureGroup = new THREE.Group();
    this.scene.add(this.structureGroup);
    this.cardsGroup = new THREE.Group();
    this.scene.add(this.cardsGroup);
    this._setupLights();

    this.cards = [];
    this.gates = [];
    this.rooms = [];
    this.waypoints = [];
    this.linearBays = [];
    this.tree = null;
    this._currentRoom = null;
    this._billboards = [];
    this._photosTotal = 0;
    this._photosLoaded = 0;
    this._updatePhotoProgress();

    this.camera.position.set(0, CAMERA_HEIGHT, 6);
    this.yaw = 0;
    this.pitch = 0;
    this.start();
  }

  // -------------------------------------------------------------------------
  // Linear-corridor builder
  // -------------------------------------------------------------------------
  async _buildLinearCorridor(bays, onProgress) {
    const ENTRY_DEPTH = 4.0;
    const BAY_DEPTH   = 5.0;
    const BAY_GAP     = 0.9;
    const HALF_W      = 2.5;
    const totalLength =
      ENTRY_DEPTH +
      bays.length * BAY_DEPTH +
      Math.max(0, bays.length - 1) * BAY_GAP +
      2.0;
    const startZ = ENTRY_DEPTH;
    const endZ   = startZ - totalLength;

    // Floor, ceiling, walls
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x2a2018, roughness: 0.85, metalness: 0.0
    });
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_W * 2 + 0.4, totalLength + 4),
      floorMat
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, (startZ + endZ) / 2);
    this.structureGroup.add(floor);

    const ceilMat = new THREE.MeshStandardMaterial({ color: 0x0a0a14, roughness: 1.0 });
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_W * 2 + 0.4, totalLength + 4),
      ceilMat
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, WALL_HEIGHT, (startZ + endZ) / 2);
    this.structureGroup.add(ceiling);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x252836, roughness: 0.9 });
    const wallGeo = new THREE.PlaneGeometry(totalLength + 4, WALL_HEIGHT);
    const wallLeft = new THREE.Mesh(wallGeo, wallMat);
    wallLeft.rotation.y = Math.PI / 2;
    wallLeft.position.set(-HALF_W, WALL_HEIGHT / 2, (startZ + endZ) / 2);
    this.structureGroup.add(wallLeft);
    const wallRight = new THREE.Mesh(wallGeo.clone(), wallMat);
    wallRight.rotation.y = -Math.PI / 2;
    wallRight.position.set(HALF_W, WALL_HEIGHT / 2, (startZ + endZ) / 2);
    this.structureGroup.add(wallRight);
    const cap = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_W * 2, WALL_HEIGHT),
      new THREE.MeshStandardMaterial({ color: 0x12141c, roughness: 1.0 })
    );
    cap.position.set(0, WALL_HEIGHT / 2, endZ - 0.5);
    this.structureGroup.add(cap);

    // Lighting comes from the global lights + player-follow PointLight set
    // up in _setupLights — no per-bay PointLights (they tank framerate when
    // you have a hundred bays).

    // Per-bay accent stripes + cards + waypoint
    this._linearBayInfo = [];
    let z = startZ - 1.0;
    for (let bayIdx = 0; bayIdx < bays.length; bayIdx++) {
      const bay = bays[bayIdx];
      const bayStartZ = z;
      const bayEndZ = bayStartZ - BAY_DEPTH;
      const repRank = bay.species[0]?.rank || 'species';
      const accentHex = colorForRank(repRank);
      const stripeMat = new THREE.MeshStandardMaterial({
        color: accentHex, emissive: accentHex, emissiveIntensity: 0.35, roughness: 0.4
      });
      const stripeGeo = new THREE.BoxGeometry(0.1, 0.12, BAY_DEPTH - 0.2);
      const stripeL = new THREE.Mesh(stripeGeo, stripeMat);
      stripeL.position.set(-HALF_W + 0.06, WALL_HEIGHT - 0.25, (bayStartZ + bayEndZ) / 2);
      this.structureGroup.add(stripeL);
      const stripeR = new THREE.Mesh(stripeGeo.clone(), stripeMat);
      stripeR.position.set(HALF_W - 0.06, WALL_HEIGHT - 0.25, (bayStartZ + bayEndZ) / 2);
      this.structureGroup.add(stripeR);

      // Place cards: 3 per wall
      const perSide = 3;
      const slotZs = [];
      for (let i = 0; i < perSide; i++) {
        const t = (i + 0.5) / perSide;
        slotZs.push(bayStartZ - 0.3 - t * (BAY_DEPTH - 0.6));
      }
      let cardIdx = 0;
      for (let side = 0; side < 2; side++) {
        const sign = side === 0 ? -1 : 1; // -1 = left wall
        for (let i = 0; i < perSide; i++) {
          const sp = bay.species[cardIdx++];
          if (!sp) continue;
          const cardZ = slotZs[i];
          const card = this._makeCard(sp);
          card.group.position.set(sign * (HALF_W - 0.04), CARD_Y, cardZ);
          card.group.rotation.y = sign === -1 ? Math.PI / 2 : -Math.PI / 2;
          card.frontNormal = new THREE.Vector3(-sign, 0, 0);
          card.room = null;
          this.cardsGroup.add(card.group);
          this.cards.push(card);
        }
      }

      this._linearBayInfo.push({
        z: bayStartZ,
        endZ: bayEndZ,
        sharedAncestorId: bay.sharedAncestorId,
        color: cssColorForRank(repRank),
        index: bayIdx,
        speciesCount: bay.species.length,
        partIndex: bay.partIndex ?? 0,
        partTotal: bay.partTotal ?? 1
      });

      // Waypoint at this bay's center so double-tap can hop bay-to-bay
      const wpZ = (bayStartZ + bayEndZ) / 2;
      this.waypoints.push({
        position: new THREE.Vector3(0, CAMERA_HEIGHT, wpZ),
        yaw: 0,
        kind: 'bay',
        ref: bay
      });

      z = bayEndZ - BAY_GAP;

      // Yield + report progress every few bays so the loading overlay updates
      // and the page stays responsive on hundreds-of-species users.
      if ((bayIdx + 1) % 6 === 0 || bayIdx === bays.length - 1) {
        onProgress?.(bayIdx + 1, bays.length);
        await yieldFrame();
      }
    }

    // Camera entry pose
    this.camera.position.set(0, CAMERA_HEIGHT, ENTRY_DEPTH - 0.5);
    this.yaw = 0;
    this.pitch = 0;

    // HUD: in linear mode we suppress the breadcrumb (no tree path).
    this._setLinearHud(0);
  }

  _setLinearHud(bayIdx) {
    const crumb = document.getElementById('hallwayBreadcrumb');
    if (crumb) crumb.innerHTML = '';
    const title = document.getElementById('hallwayHudTitle');
    const sub = document.getElementById('hallwayHudSub');
    const bays = this._linearBayInfo || [];
    if (!bays.length || !title || !sub) return;
    const bay = bays[bayIdx] || bays[0];
    const color = bay.color || '#22c55e';
    const anc = this._ancestorMeta?.[bay.sharedAncestorId];
    const rankPrefix = anc?.rank ? capitalize(anc.rank) + ' ' : '';
    const baseLabel = anc ? `${rankPrefix}${anc.name}` : `Bay ${bayIdx + 1} of ${bays.length}`;
    const label = bay.partTotal > 1 ? `${baseLabel} · part ${bay.partIndex + 1} of ${bay.partTotal}` : baseLabel;
    title.textContent = label;
    title.style.borderLeft = `4px solid ${color}`;
    title.style.paddingLeft = '10px';

    // Real species range: sum the actual lengths of preceding bays (genera
    // can leave empty slots when their species count isn't a multiple of 6).
    let cardsBefore = 0;
    for (let i = 0; i < bayIdx; i++) {
      cardsBefore += bays[i].speciesCount || 0;
    }
    const bayCount = bay.speciesCount || 0;
    sub.textContent =
      `Species ${cardsBefore + 1}–${cardsBefore + bayCount} of ${this.species.length} · ` +
      `${this.ctx.username} @ ${this.ctx.taxonName}`;
  }

  _buildWorld() {
    // Compute the overall footprint to size the floor + ceiling planes.
    let min = new THREE.Vector3(Infinity, 0, Infinity);
    let max = new THREE.Vector3(-Infinity, 0, -Infinity);
    for (const r of this.rooms) {
      min.x = Math.min(min.x, r.position.x);
      min.z = Math.min(min.z, r.position.z);
      max.x = Math.max(max.x, r.position.x);
      max.z = Math.max(max.z, r.position.z);
    }
    if (!Number.isFinite(min.x)) { min.set(-1, 0, -1); max.set(1, 0, 1); }
    const PAD = 14;
    const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2;
    const w = Math.max(20, max.x - min.x + PAD * 2);
    const d = Math.max(20, max.z - min.z + PAD * 2);

    // Big ground plane
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ color: 0x1c1610, roughness: 0.95, metalness: 0.0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz);
    this.structureGroup.add(floor);
    this._floorPlane = floor;

    // Track total bounds for clamping
    this._worldBounds = { min, max, w, d, cx, cz };
  }

  async _buildAllRooms(onProgress) {
    const total = this.rooms.length;
    for (let i = 0; i < total; i++) {
      const r = this.rooms[i];
      if (r.roomType === 'junction')   this._buildJunctionRoom(r);
      else if (r.roomType === 'gallery')  this._buildGalleryRoom(r);
      else if (r.roomType === 'pedestal') this._buildPedestalRoom(r);
      // Yield every few rooms so the browser repaints + progress text advances.
      if ((i + 1) % 6 === 0 || i === total - 1) {
        onProgress?.(i + 1, total);
        await yieldFrame();
      }
    }
  }

  // Position helper: rotate a local-XZ offset into world space using node.forward.
  _toWorld(node, localX, localZ) {
    // Node's local axes:
    //   local +Z (forward) = node.forward
    //   local +X (right)   = node.forward rotated -90° around Y (i.e., y-cross-forward)
    const f = node.forward;
    const rx = -f.z, rz = f.x; // (right vector = (-fz, 0, fx))
    return new THREE.Vector3(
      node.position.x + localX * rx + localZ * f.x,
      0,
      node.position.z + localX * rz + localZ * f.z
    );
  }

  // Parent a mesh under the node's per-room group so distance-based culling
  // can hide the whole room's meshes with one .visible toggle each frame.
  _addToRoom(node, obj) {
    if (!node._roomGroup) {
      node._roomGroup = new THREE.Group();
      this.structureGroup.add(node._roomGroup);
    }
    node._roomGroup.add(obj);
  }

  _addPillars(node, halfW, halfD) {
    const tint = colorForRank(node.rank);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0xd4cfb8,
      roughness: 0.6,
      metalness: 0.05
    });
    const capMat = new THREE.MeshStandardMaterial({
      color: tint, emissive: tint, emissiveIntensity: 0.45, roughness: 0.4
    });
    const corners = [
      [-halfW, -halfD], [+halfW, -halfD],
      [+halfW, +halfD], [-halfW, +halfD]
    ];
    for (const [lx, lz] of corners) {
      const p = this._toWorld(node, lx, lz);
      const col = new THREE.Mesh(
        new THREE.CylinderGeometry(PILLAR_RADIUS, PILLAR_RADIUS, PILLAR_HEIGHT, 10),
        pillarMat
      );
      col.position.set(p.x, PILLAR_HEIGHT / 2, p.z);
      this._addToRoom(node, col);
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(PILLAR_RADIUS * 1.7, PILLAR_RADIUS * 1.3, 0.18, 10),
        capMat
      );
      cap.position.set(p.x, PILLAR_HEIGHT + 0.04, p.z);
      this._addToRoom(node, cap);
    }
  }

  _addRoomFloor(node, w, d, tintHex) {
    const accent = tintHex ?? colorForRank(node.rank);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x232a3a, roughness: 0.7, metalness: 0.0
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(node.position.x, 0.01, node.position.z);
    // Orient floor's local axes with the room's forward
    const angle = Math.atan2(node.forward.x, node.forward.z);
    floor.rotation.z = -angle; // counter-rotate plane after x-rotation
    this._addToRoom(node, floor);

    // Rank-colored inlay strip along the room boundary
    const inlay = new THREE.Mesh(
      new THREE.PlaneGeometry(w - 0.4, d - 0.4),
      new THREE.MeshStandardMaterial({
        color: 0x2c3447, roughness: 0.6, metalness: 0.0,
        emissive: accent, emissiveIntensity: 0.12
      })
    );
    inlay.rotation.x = -Math.PI / 2;
    inlay.position.set(node.position.x, 0.02, node.position.z);
    inlay.rotation.z = -angle;
    this._addToRoom(node, inlay);
  }

  _addRoomLight(/* node */) {
    // No-op: removed per-room PointLights for perf. Lighting comes from the
    // global lights + the player-follow PointLight in _setupLights, plus
    // emissive materials on accent stripes and gate beams.
  }

  _addRoomSign(node) {
    const halfD = (this._roomSize(node).d) / 2;

    const accent = cssColorForRank(node.rank);
    const subtitle = node.common
      ? `${capitalize(node.rank || 'taxon')}${node.common ? ` · ${node.common}` : ''}`
      : capitalize(node.rank || 'taxon');
    const tex = makeRoomPlinthTexture({
      title: node.name,
      subtitle,
      accent,
      prefix: node.pathPrefix
    });
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 1.0),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true })
    );
    // Hang the sign overhead at the far end of the room. We billboard it
    // toward the camera every frame so it always reads cleanly regardless
    // of which approach angle the player is on.
    const farLocal = +halfD - 0.25;
    const pos = this._toWorld(node, 0, farLocal);
    plane.position.set(pos.x, 2.8, pos.z);
    plane.userData.kind = 'room-sign';
    this._addToRoom(node, plane);
    (this._billboards ||= []).push(plane);
  }

  _roomSize(node) {
    if (node.roomType === 'gallery')  return { w: GALLERY_WIDTH, d: GALLERY_DEPTH };
    if (node.roomType === 'pedestal') return { w: PEDESTAL_SIZE, d: PEDESTAL_SIZE };
    return { w: ROOM_WIDTH, d: ROOM_DEPTH };
  }

  _buildJunctionRoom(node) {
    const { w, d } = this._roomSize(node);
    const halfW = w / 2, halfD = d / 2;

    this._addRoomFloor(node, w + 0.6, d + 0.6);
    this._addPillars(node, halfW + 0.2, halfD + 0.2);
    this._addRoomLight(node, 1.0);
    this._addRoomSign(node);

    // Place each gate just outside the parent room's edge in the world-space
    // direction of its corresponding child. This guarantees gate-to-child
    // alignment regardless of the fan angle, and keeps gates visible from the
    // room's entrance.
    const subs = node.children.filter(c => c.roomType !== 'leaf');
    for (const child of subs) {
      const dirToChild = new THREE.Vector3(
        child.position.x - node.position.x, 0,
        child.position.z - node.position.z
      ).normalize();
      const gateWorld = node.position.clone().addScaledVector(dirToChild, halfD + 0.6);
      this._addGate(node, child, gateWorld, dirToChild);
    }

    // Waypoints for this room: center
    this.waypoints.push({
      position: new THREE.Vector3(node.position.x, CAMERA_HEIGHT, node.position.z),
      yaw: Math.atan2(node.forward.x, node.forward.z) + Math.PI, // looking toward forward
      kind: 'room',
      ref: node
    });
  }

  _buildGalleryRoom(node) {
    const { w, d } = this._roomSize(node);
    const halfW = w / 2, halfD = d / 2;

    this._addRoomFloor(node, w + 0.6, d + 0.6);
    this._addPillars(node, halfW + 0.2, halfD + 0.2);
    this._addRoomLight(node, 1.05);
    this._addRoomSign(node);

    const leaves = node._cards || [];
    // Lay out cards along left + right walls; if more than fits, also use the front wall.
    const perSide = 3;
    const leftCount = Math.min(perSide, leaves.length);
    const rightCount = Math.min(perSide, Math.max(0, leaves.length - perSide));
    const frontCount = Math.max(0, leaves.length - 2 * perSide);

    let idx = 0;
    const placeCard = (sp, sideSign, slotIdx, slotsTotal, axis) => {
      // axis: 'side' for left/right walls (varying along Z), 'front' for front wall (varying along X)
      let lx, lz, normalLocal;
      if (axis === 'side') {
        const t = slotsTotal === 1 ? 0.5 : (slotIdx + 0.5) / slotsTotal;
        lx = sideSign * (halfW - 0.05);
        lz = (-halfD + 0.5) + t * (d - 1.0);
        normalLocal = new THREE.Vector3(-sideSign, 0, 0); // local normal points into room
      } else {
        // Far wall (opposite the entrance): local +Z is node.forward
        // direction, so the wall sits at local z = +halfD. Card normal
        // points back toward room center (local -Z).
        const t = slotsTotal === 1 ? 0.5 : (slotIdx + 0.5) / slotsTotal;
        lx = (-halfW + 0.6) + t * (w - 1.2);
        lz = +halfD - 0.05;
        normalLocal = new THREE.Vector3(0, 0, -1);
      }
      this._spawnWallCard(node, sp, lx, lz, normalLocal);
    };

    for (let i = 0; i < leftCount; i++) placeCard(leaves[idx++], -1, i, leftCount, 'side');
    for (let i = 0; i < rightCount; i++) placeCard(leaves[idx++], +1, i, rightCount, 'side');
    for (let i = 0; i < frontCount; i++) placeCard(leaves[idx++], 0, i, frontCount, 'front');

    // Waypoint at room center
    this.waypoints.push({
      position: new THREE.Vector3(node.position.x, CAMERA_HEIGHT, node.position.z),
      yaw: Math.atan2(node.forward.x, node.forward.z) + Math.PI,
      kind: 'room',
      ref: node
    });
  }

  _buildPedestalRoom(node) {
    const { w, d } = this._roomSize(node);
    const halfW = w / 2, halfD = d / 2;

    this._addRoomFloor(node, w + 0.4, d + 0.4);
    this._addPillars(node, halfW + 0.1, halfD + 0.1);
    this._addRoomSign(node);

    // Plinth in the center (no SpotLight — instead the accent cap is heavily
    // emissive so the pedestal still reads as a spot of focused light).
    const plinthH = 1.0;
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, plinthH, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x2f3a52, roughness: 0.5, metalness: 0.1 })
    );
    plinth.position.set(node.position.x, plinthH / 2, node.position.z);
    this._addToRoom(node, plinth);

    const accentCap = new THREE.Mesh(
      new THREE.BoxGeometry(1.05, 0.06, 1.05),
      new THREE.MeshStandardMaterial({
        color: colorForRank(node.rank),
        emissive: colorForRank(node.rank),
        emissiveIntensity: 1.4,
        roughness: 0.4
      })
    );
    accentCap.position.set(node.position.x, plinthH + 0.03, node.position.z);
    this._addToRoom(node, accentCap);

    // The single species card sits on top, facing the entrance (-node.forward)
    const sp = (node._cards && node._cards[0]) || null;
    if (sp) {
      const card = this._makeCard(sp);
      card.group.position.set(node.position.x, plinthH + 0.55, node.position.z);
      // The card faces back toward the entrance (-node.forward)
      const ang = Math.atan2(-node.forward.x, -node.forward.z);
      card.group.rotation.y = ang;
      card.frontNormal = new THREE.Vector3(-node.forward.x, 0, -node.forward.z);
      card.room = node;
      this._addToRoom(node, card.group);
      this.cards.push(card);
    }

    // Waypoint: stand at the entrance side facing the pedestal
    const wpLocal = this._toWorld(node, 0, +halfD - 0.5);
    this.waypoints.push({
      position: new THREE.Vector3(wpLocal.x, CAMERA_HEIGHT, wpLocal.z),
      yaw: Math.atan2(node.forward.x, node.forward.z) + Math.PI,
      kind: 'room',
      ref: node
    });
  }

  _spawnWallCard(node, sp, localX, localZ, normalLocal) {
    const card = this._makeCard(sp);
    const world = this._toWorld(node, localX, localZ);
    card.group.position.set(world.x, CARD_Y, world.z);

    // Rotate world from local normal:
    // local +X (right) world dir = (-fz, 0, fx); local +Z (forward) = (fx, 0, fz)
    const fx = node.forward.x, fz = node.forward.z;
    const worldNormal = new THREE.Vector3(
      normalLocal.x * (-fz) + normalLocal.z * fx,
      0,
      normalLocal.x * fx + normalLocal.z * fz
    ).normalize();
    const ang = Math.atan2(worldNormal.x, worldNormal.z);
    card.group.rotation.y = ang;
    card.frontNormal = worldNormal;
    card.room = node;
    this._addToRoom(node, card.group);
    this.cards.push(card);
  }

  _addGate(parent, child, gateWorld, dirToChild) {
    // Build a freestanding doorway-arch: two vertical pillars + a top beam +
    // a label sign + a clickable, slightly translucent fill.
    const world = gateWorld;
    const accent = colorForRank(child.rank);
    const accentCss = cssColorForRank(child.rank);

    const gateGroup = new THREE.Group();
    gateGroup.position.set(world.x, 0, world.z);
    // Orient the gate's local +Z so it points TOWARD the child (so the player
    // walking through it heads in the right direction). The label/back side
    // (+Z after the internal π-rotation below) then faces back into the parent.
    const gateAngle = Math.atan2(dirToChild.x, dirToChild.z);
    gateGroup.rotation.y = gateAngle;

    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0xb8b4a0, roughness: 0.5, metalness: 0.1
    });
    const pillarGeom = new THREE.BoxGeometry(0.18, GATE_H, 0.18);
    const pL = new THREE.Mesh(pillarGeom, pillarMat);
    pL.position.set(-GATE_W / 2, GATE_H / 2, 0);
    gateGroup.add(pL);
    const pR = new THREE.Mesh(pillarGeom.clone(), pillarMat);
    pR.position.set(+GATE_W / 2, GATE_H / 2, 0);
    gateGroup.add(pR);

    // Top beam with rank accent
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(GATE_W + 0.4, 0.3, 0.25),
      new THREE.MeshStandardMaterial({
        color: accent, emissive: accent, emissiveIntensity: 0.55, roughness: 0.45
      })
    );
    beam.position.set(0, GATE_H + 0.15, 0);
    gateGroup.add(beam);

    // The clickable face: a translucent panel inside the arch
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(GATE_W - 0.05, GATE_H - 0.2),
      new THREE.MeshBasicMaterial({
        color: accent, transparent: true, opacity: 0.10, side: THREE.DoubleSide
      })
    );
    fill.position.set(0, (GATE_H - 0.2) / 2 + 0.1, 0);
    gateGroup.add(fill);

    this._addToRoom(parent, gateGroup);

    // Sign sits as a sibling of the gate (not parented to gateGroup) so we
    // can billboard it toward the camera each frame without fighting the
    // gate's rotation. Smaller than before — previous signs overlapped into
    // garbled text when several gates clustered at similar angles.
    const signTex = makeGateSignTexture({
      title: child.name,
      subtitle: child.rank ? capitalize(child.rank) : '',
      accent: accentCss,
      count: child.speciesUnder
    });
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.55),
      new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide, transparent: true })
    );
    sign.position.set(world.x, GATE_H + 0.55, world.z);
    sign.userData.kind = 'gate-sign';
    this._addToRoom(parent, sign);
    (this._billboards ||= []).push(sign);

    this.gates.push({
      mesh: fill,
      sign,
      parentNode: parent,
      childNode: child,
      position: new THREE.Vector3(world.x, 0, world.z),
      directionToChild: dirToChild
    });

    // Waypoint: just inside the parent looking at the gate (so user can fly to it)
    const standoff = new THREE.Vector3(world.x, CAMERA_HEIGHT, world.z)
      .addScaledVector(dirToChild, -1.6);
    this.waypoints.push({
      position: standoff,
      yaw: Math.atan2(dirToChild.x, dirToChild.z) + Math.PI,
      kind: 'gate',
      ref: { parentNode: parent, childNode: child }
    });
  }

  async _buildAllConnectors(onProgress) {
    // Flatten parent→child pairs first so we can iterate with yields.
    const pairs = [];
    function walk(n) {
      if (!n.children) return;
      for (const c of n.children) {
        if (c.roomType === 'leaf') continue;
        pairs.push([n, c]);
        walk(c);
      }
    }
    walk(this.tree);
    for (let i = 0; i < pairs.length; i++) {
      this._buildConnector(pairs[i][0], pairs[i][1]);
      if ((i + 1) % 24 === 0 || i === pairs.length - 1) {
        onProgress?.(i + 1, pairs.length);
        await yieldFrame();
      }
    }
  }

  _buildConnector(parent, child) {
    // A lit floor strip from parent's room to child's room. We extend the
    // strip the full center-to-center distance (plus a small overshoot)
    // and render it just above the world floor; the rooms' own floors are
    // higher (y = 0.01–0.02) and cover the strip wherever they overlap,
    // so the visible portion is exactly the corridor between rooms.
    const a = parent.position;
    const b = child.position;
    const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
    const fullLen = a.distanceTo(b);
    const segLen = fullLen + 0.6;
    const cx = (a.x + b.x) / 2;
    const cz = (a.z + b.z) / 2;
    const accent = colorForRank(child.rank);

    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, segLen),
      new THREE.MeshStandardMaterial({
        color: 0x2a3344, roughness: 0.85,
        emissive: accent, emissiveIntensity: 0.10
      })
    );
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(cx, 0.008, cz);
    // Orient the long axis of the strip with `dir`
    strip.rotation.z = -Math.atan2(dir.x, dir.z);
    this._addToRoom(parent, strip);

    // A few small accent rings along the strip so the corridor reads as
    // a directional path even before the user moves.
    const ringSteps = Math.max(2, Math.min(5, Math.round(fullLen / 3)));
    for (let i = 1; i <= ringSteps; i++) {
      const t = i / (ringSteps + 1);
      const rx = a.x + (b.x - a.x) * t;
      const rz = a.z + (b.z - a.z) * t;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.16, 0.26, 16),
        new THREE.MeshBasicMaterial({
          color: accent, side: THREE.DoubleSide, transparent: true, opacity: 0.8
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(rx, 0.025, rz);
      this._addToRoom(parent, ring);
    }
  }

  // -------------------------------------------------------------------------
  // Card creation (front photo + back canvas)
  // -------------------------------------------------------------------------
  _makeCard(species) {
    const group = new THREE.Group();
    const flipGroup = new THREE.Group();
    group.add(flipGroup);

    const accent = cssColorForRank(species.rank);
    // Front placeholder is intentionally quiet — a rank-color gradient with a
    // faint rank-initial watermark — because the species name now lives on a
    // dedicated nameplate under the card, so even when no photo loads the
    // viewer still knows what they're looking at.
    const placeholderTex = makeLabelTexture({ color: accent, rank: species.rank });
    // Back texture is created lazily on first flip — building hundreds of
    // canvas textures up front would lock the JS thread for several seconds
    // on a large taxon like Lepidoptera.
    const frontMat = new THREE.MeshStandardMaterial({
      map: placeholderTex, roughness: 0.6, metalness: 0.0
    });
    const backMat = new THREE.MeshStandardMaterial({
      color: colorForRank(species.rank), roughness: 0.6, metalness: 0.0
    });

    const geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
    const front = new THREE.Mesh(geo, frontMat);
    front.position.z = 0.002;
    const back = new THREE.Mesh(geo.clone(), backMat);
    back.rotation.y = Math.PI;
    back.position.z = -0.002;

    const frameDepth = 0.06;
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(CARD_W + 0.06, CARD_H + 0.06, frameDepth),
      new THREE.MeshStandardMaterial({
        color: colorForRank(species.rank),
        emissive: colorForRank(species.rank),
        emissiveIntensity: 0.18,
        roughness: 0.6
      })
    );
    frame.position.z = -frameDepth / 2 - 0.003;

    flipGroup.add(frame);
    flipGroup.add(front);
    flipGroup.add(back);

    // Museum-style nameplate hanging below the card. Lives inside the
    // flipGroup so it tracks the card's orientation but stays visible from
    // the corridor side. Slightly forward of the frame (z = +0.04) so it
    // doesn't z-fight with the wall behind the card.
    const plateW = CARD_W * 0.88;
    const plateH = 0.22;
    const plateTex = makeNameplateTexture(species);
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(plateW, plateH),
      new THREE.MeshBasicMaterial({
        map: plateTex, transparent: true, side: THREE.DoubleSide
      })
    );
    plate.position.set(0, -CARD_H / 2 - plateH / 2 - 0.04, 0.04);
    flipGroup.add(plate);

    // For raycasting, mark the front mesh's userData with a back-ref to the card
    front.userData.kind = 'card';

    return {
      group,
      flipGroup,
      frontMesh: front,
      backMesh: back,
      nameplateMesh: plate,
      species,
      flipping: false,
      flipped: false,
      flipT: 0,
      flipFrom: 0,
      flipTo: 0,
      _placeholderTex: placeholderTex,
      _backTexCreated: false,
      room: null,
      frontNormal: new THREE.Vector3(0, 0, 1)
    };
  }

  // Defer the per-card back-canvas texture creation until the user flips a
  // card (most cards are never flipped in a large hallway).
  _ensureBackTexture(card) {
    if (card._backTexCreated) return;
    const tex = makeBackTexture(card.species);
    card.backMesh.material.map = tex;
    card.backMesh.material.color.set(0xffffff);
    card.backMesh.material.needsUpdate = true;
    card._backTexCreated = true;
  }

  async _loadUserPhotos() {
    // Visit cards in order of distance from the camera so the user sees the
    // photos in front of them first. The camera starts inside the lobby for
    // branching mode and at the corridor entry for linear mode, so the
    // closest 10–20 cards get priority and stream in within ~1–2 seconds.
    const username = this.ctx.username;
    const getFirstObs = window.getFirstObs;
    const camPos = this.camera.position.clone();
    const cards = [...this.cards];
    cards.sort((a, b) => {
      const ap = new THREE.Vector3();
      const bp = new THREE.Vector3();
      a.group.getWorldPosition(ap);
      b.group.getWorldPosition(bp);
      return ap.distanceToSquared(camPos) - bp.distanceToSquared(camPos);
    });

    const queue = cards;
    this._photosTotal = queue.length;
    this._photosLoaded = 0;
    this._photosSuccess = 0;
    this._photosNoUrl = 0;
    this._photosError = 0;
    this._updatePhotoProgress();

    let idx = 0;
    const concurrency = 6;

    const work = async () => {
      while (idx < queue.length) {
        const myIdx = idx++;
        const card = queue[myIdx];

        // Try the user's first-observation photo, falling back to the
        // species' default photo from species_counts.
        let url = null;
        if (getFirstObs) {
          try {
            const info = await getFirstObs(username, card.species.id);
            url = info?.image_urls?.medium
               || info?.image_urls?.small
               || info?.image_urls?.thumb
               || null;
            card._firstObs = info;
          } catch (e) {
            // first-observation API itself errored — log first one only
            if (this._photosError === 0) {
              console.warn('[hallway] first-observation API error:', e.message || e);
            }
          }
        }
        if (!url) url = card.species.defaultPhoto;
        if (!url) {
          this._photosNoUrl++;
          this._photosLoaded++;
          this._updatePhotoProgress();
          continue;
        }

        const tex = await loadPhotoTexture(url);
        if (tex && card.frontMesh) {
          tex.center.set(0.5, 0.5);
          const aspect = (tex.image?.width || 1) / (tex.image?.height || 1);
          const target = CARD_W / CARD_H;
          if (aspect > target) {
            tex.repeat.set(target / aspect, 1);
            tex.offset.set((1 - target / aspect) / 2, 0);
          } else {
            tex.repeat.set(1, aspect / target);
            tex.offset.set(0, (1 - aspect / target) / 2);
          }
          card.frontMesh.material.map?.dispose?.();
          card.frontMesh.material.map = tex;
          card.frontMesh.material.needsUpdate = true;
          this._photosSuccess++;
        } else {
          this._photosError++;
        }

        this._photosLoaded++;
        this._updatePhotoProgress();
        // Tiny gap to keep the UI responsive
        await new Promise(r => setTimeout(r, 5));
      }
    };
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(work());
    Promise.all(workers).then(() => {
      console.info(
        `[hallway] photo load complete — ${this._photosSuccess} ok, ` +
        `${this._photosError} failed, ${this._photosNoUrl} no URL, ` +
        `total ${this._photosTotal}.` +
        (this._photosSuccess === 0 && this._photosError > 0
          ? ' Every photo URL was unreachable — see the [hallway photo] warnings above for the cause.'
          : '')
      );
    }).catch(() => {});
  }

  _updatePhotoProgress() {
    const el = document.getElementById('hallwayPhotoProgress');
    if (!el) return;
    const total = this._photosTotal || 0;
    const done = this._photosLoaded || 0;
    if (!total || done >= total) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'inline-flex';
    el.textContent = `📷 ${done}/${total}`;
  }

  // -------------------------------------------------------------------------
  // Animation loop
  // -------------------------------------------------------------------------
  start() {
    if (this._frameId) return;
    const loop = () => {
      this._frameId = requestAnimationFrame(loop);
      const dt = Math.min(0.05, this.clock.getDelta());
      this._tick(dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.clock.start();
    loop();
  }

  pause() {
    if (this._frameId) cancelAnimationFrame(this._frameId);
    this._frameId = null;
  }

  _tick(dt) {
    // Update camera from yaw/pitch
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;

    // WASD movement (unless a card is open or we're tweening)
    if (!this._activeCard && !this._cameraTween) {
      const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 8.0 : 4.0;
      const fwd = this._forwardVec();
      const right = this._rightVec();
      const move = new THREE.Vector3();
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp'))    move.add(fwd);
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown'))  move.sub(fwd);
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  move.sub(right);
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(speed * dt);
        this.camera.position.add(move);
        this.camera.position.y = CAMERA_HEIGHT;
        // Linear mode has a known corridor footprint, so we softly clamp
        // X to keep the player inside the walls. Branching mode is open.
        if (this.layoutMode === 'linear') {
          this.camera.position.x = Math.max(-2.05, Math.min(2.05, this.camera.position.x));
        }
      }
    }

    // Camera tween
    if (this._cameraTween) {
      const ct = this._cameraTween;
      ct.t += dt / ct.duration;
      const k = Math.min(1, ct.t);
      const e = easeInOut(k);
      this.camera.position.lerpVectors(ct.fromPos, ct.toPos, e);
      this.yaw   = lerpAngle(ct.fromYaw, ct.toYaw, e);
      this.pitch = lerpNum(ct.fromPitch, ct.toPitch, e);
      if (k >= 1) {
        this._cameraTween = null;
        if (ct.afterRoom) {
          this._setCurrentRoom(ct.afterRoom);
        }
      }
    }

    // Card flip
    for (const c of this.cards) {
      if (!c.flipping) continue;
      c.flipT += dt / 0.55;
      const k = Math.min(1, c.flipT);
      const e = easeInOut(k);
      const angle = c.flipFrom + (c.flipTo - c.flipFrom) * e;
      c.flipGroup.rotation.y = angle;
      if (k >= 1) {
        c.flipping = false;
        c.flipped = Math.abs(c.flipTo) > 1e-3;
      }
    }

    // Keep the player-follow light glued to the camera so the user always
    // walks inside a pool of warm light, even in branching mode where rooms
    // no longer carry their own PointLights.
    if (this._followLight) {
      this._followLight.position.set(
        this.camera.position.x,
        this.camera.position.y + 0.4,
        this.camera.position.z
      );
    }

    // Billboard signs (room signs + gate signs) toward the camera so their
    // text always reads cleanly. Skip while a card is open — the camera is
    // already locked on the card and we don't want signs spinning.
    if (this._billboards && !this._activeCard) {
      this._billboardAll();
    }

    // Throttle the expensive LOD walk: only every ~150ms, and only if the
    // camera has actually moved.
    this._visibilityAccum = (this._visibilityAccum || 0) + dt;
    if (this._visibilityAccum > 0.15) {
      this._visibilityAccum = 0;
      this._updateRoomVisibility();
    }

    // Update HUD periodically based on nearest room (branching) or bay (linear)
    if (!this._activeCard && !this._cameraTween) {
      if (this.layoutMode === 'linear') this._maybeUpdateLinearHud();
      else this._maybeUpdateCurrentRoomByProximity();
    }
  }

  _billboardAll() {
    const cx = this.camera.position.x;
    const cz = this.camera.position.z;
    for (const sign of this._billboards) {
      // Only billboard visible signs; skip ones in culled rooms.
      if (!sign.visible) continue;
      const worldPos = sign.position; // signs are direct children of room groups (no extra rotation between)
      // Get the sign's world position; since its parent room group has no rotation,
      // sign.position IS effectively world position.
      const dx = cx - worldPos.x;
      const dz = cz - worldPos.z;
      sign.rotation.y = Math.atan2(dx, dz);
    }
  }

  _updateRoomVisibility() {
    if (!this.rooms || !this.rooms.length) return;
    const cp = this.camera.position;
    for (const r of this.rooms) {
      const g = r._roomGroup;
      if (!g) continue;
      const dx = r.position.x - cp.x;
      const dz = r.position.z - cp.z;
      g.visible = (dx * dx + dz * dz) <= ROOM_VISIBLE_RADIUS_SQ;
    }
  }

  _maybeUpdateLinearHud() {
    const bays = this._linearBayInfo;
    if (!bays || !bays.length) return;
    const z = this.camera.position.z;
    let bestIdx = 0, bestD = Infinity;
    for (let i = 0; i < bays.length; i++) {
      const center = (bays[i].z + bays[i].endZ) / 2;
      const d = Math.abs(center - z);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (bestIdx !== this._linearCurrentBay) {
      this._linearCurrentBay = bestIdx;
      this._setLinearHud(bestIdx);
    }
  }

  _maybeUpdateCurrentRoomByProximity() {
    if (!this.rooms.length) return;
    const cp = this.camera.position;
    let best = null, bestD = Infinity;
    for (const r of this.rooms) {
      const dx = r.position.x - cp.x, dz = r.position.z - cp.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best && best !== this._currentRoom) this._setCurrentRoom(best);
  }

  _setCurrentRoom(node) {
    this._currentRoom = node;
    this._updateBreadcrumb(node);
    this._updateHud(node);
  }

  _updateHud(node) {
    const title = document.getElementById('hallwayHudTitle');
    const sub = document.getElementById('hallwayHudSub');
    if (!title || !sub) return;
    const color = cssColorForRank(node.rank);
    title.textContent = chunkLabel(node) || node.name;
    title.style.borderLeft = `4px solid ${color}`;
    title.style.paddingLeft = '10px';
    const typeLabel = ({
      junction: `${node.children.length} sub-taxa`,
      gallery:  `${(node._cards || []).length} species`,
      pedestal: `1 species`
    })[node.roomType] || '';
    sub.textContent = `${typeLabel} · ${this.ctx.username} @ ${this.ctx.taxonName}`;
  }

  _updateBreadcrumb(node) {
    const el = document.getElementById('hallwayBreadcrumb');
    if (!el) return;
    el.innerHTML = '';
    const segs = buildBreadcrumb(node);
    segs.forEach((seg, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'hallway-breadcrumb-sep';
        sep.textContent = '›';
        el.appendChild(sep);
      }
      const item = document.createElement(seg.nodeId != null ? 'button' : 'span');
      item.className = 'hallway-breadcrumb-item';
      if (i === segs.length - 1) item.classList.add('is-current');
      item.textContent = seg.label;
      if (seg.nodeId != null) {
        item.dataset.nodeId = String(seg.nodeId);
        item.title = 'Fly to this room';
        item.addEventListener('click', () => {
          const target = this._findRoomById(seg.nodeId);
          if (target) this._enterRoom(target);
        });
      }
      el.appendChild(item);
    });
  }

  _findRoomById(id) {
    for (const r of this.rooms) if (r.id === id) return r;
    return null;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------
  _enterRoom(node, instant = false) {
    // Land just inside the room facing toward node.forward (so the player sees
    // its features straight ahead).
    const f = node.forward;
    const standoff = node.position.clone().addScaledVector(f, -this._roomSize(node).d * 0.35);
    const yaw = Math.atan2(f.x, f.z) + Math.PI;
    if (instant) {
      this.camera.position.set(standoff.x, CAMERA_HEIGHT, standoff.z);
      this.yaw = yaw;
      this.pitch = 0;
      this._setCurrentRoom(node);
    } else {
      this._tweenCamera(
        new THREE.Vector3(standoff.x, CAMERA_HEIGHT, standoff.z),
        yaw,
        0,
        0.7,
        node
      );
    }
  }

  _tweenCamera(toPos, toYaw, toPitch, duration, afterRoom = null) {
    this._cameraTween = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromYaw: this.yaw,
      toYaw,
      fromPitch: this.pitch,
      toPitch,
      t: 0,
      duration,
      afterRoom
    };
  }

  _handleSingleTap(x, y) {
    if (this._activeCard) return;
    const hit = this._pickInteractive(x, y);
    if (!hit) return;
    if (hit.kind === 'gate') {
      const child = hit.gate.childNode;
      this._enterRoom(child);
    } else if (hit.kind === 'card') {
      this._openCard(hit.card);
    }
  }

  _handleDoubleTap(x, y) {
    if (this._activeCard) return;
    // Project tap into the world (floor plane) — direction from camera.
    const rect = this.canvas.getBoundingClientRect();
    this.mouseNdc.x = ((x - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((y - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);
    // Intersect with the floor plane (y=0)
    const ray = this.raycaster.ray;
    const t = -ray.origin.y / (ray.direction.y || -1e-6);
    if (!Number.isFinite(t) || t < 0) return;
    const target = new THREE.Vector3()
      .copy(ray.origin)
      .addScaledVector(ray.direction, t);

    // Direction in XZ from camera to target
    const cp = this.camera.position;
    const dir = new THREE.Vector3(target.x - cp.x, 0, target.z - cp.z);
    if (dir.lengthSq() < 1e-4) return;
    dir.normalize();

    // Find best waypoint forward of camera in this direction
    const best = this._findWaypointInDirection(cp, dir);
    if (best) {
      this._tweenCamera(best.position.clone(), best.yaw, 0, 0.65, best.kind === 'room' ? best.ref : null);
    } else {
      // No waypoint found nearby — just hop a few meters toward the tap.
      const hop = cp.clone().addScaledVector(dir, Math.min(6, cp.distanceTo(target)));
      hop.y = CAMERA_HEIGHT;
      const yaw = Math.atan2(dir.x, dir.z) + Math.PI;
      this._tweenCamera(hop, yaw, 0, 0.45, null);
    }
  }

  _findWaypointInDirection(fromPos, dir) {
    let best = null;
    let bestScore = -Infinity;
    const MAX_DIST = 40;
    const CONE = Math.cos(Math.PI / 4); // ~45° half-angle
    for (const wp of this.waypoints) {
      const toWp = new THREE.Vector3(
        wp.position.x - fromPos.x,
        0,
        wp.position.z - fromPos.z
      );
      const dist = toWp.length();
      if (dist < 0.5 || dist > MAX_DIST) continue;
      const dotted = (toWp.x * dir.x + toWp.z * dir.z) / dist;
      if (dotted < CONE) continue;
      // Score: prefer aligned + closer (but not too close to current position)
      const score = dotted * 1.4 - dist * 0.04;
      if (score > bestScore) { bestScore = score; best = wp; }
    }
    return best;
  }

  _pickInteractive(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseNdc.x = ((x - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((y - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);
    // Three.js Raycaster only checks each mesh's own .visible, not its
    // parent chain — so a card inside a culled (hidden) room group could
    // still register a hit. Filter candidates by walking up to ensure
    // every ancestor is visible.
    const candidates = [];
    const isReallyVisible = (m) => {
      for (let cur = m; cur; cur = cur.parent) if (cur.visible === false) return false;
      return true;
    };
    for (const c of this.cards) if (isReallyVisible(c.frontMesh)) candidates.push(c.frontMesh);
    for (const g of this.gates) if (isReallyVisible(g.mesh)) candidates.push(g.mesh);
    const hits = this.raycaster.intersectObjects(candidates, false);
    if (!hits.length) return null;
    const obj = hits[0].object;
    const card = this.cards.find(c => c.frontMesh === obj);
    if (card) return { kind: 'card', card };
    const gate = this.gates.find(g => g.mesh === obj);
    if (gate) return { kind: 'gate', gate };
    return null;
  }

  // -------------------------------------------------------------------------
  // Card flip + detail panel
  // -------------------------------------------------------------------------
  _openCard(card) {
    if (this._activeCard) return;
    this._activeCard = card;
    this._ensureBackTexture(card);

    const cardPos = new THREE.Vector3();
    card.group.getWorldPosition(cardPos);
    const targetPos = cardPos.clone().addScaledVector(card.frontNormal, 2.2);
    targetPos.y = CAMERA_HEIGHT;
    const lookDir = cardPos.clone().sub(targetPos).normalize();
    const targetYaw = Math.atan2(lookDir.x, lookDir.z) + Math.PI;

    this._tweenCamera(targetPos, targetYaw, 0, 0.6, null);

    card.flipping = true;
    card.flipT = 0;
    card.flipFrom = card.flipGroup.rotation.y;
    card.flipTo = Math.PI;

    this._showDetailPanel(card);
  }

  _closeActiveCard() {
    const card = this._activeCard;
    if (!card) return;
    card.flipping = true;
    card.flipT = 0;
    card.flipFrom = card.flipGroup.rotation.y;
    card.flipTo = 0;
    this._hideDetailPanel();
    this._activeCard = null;
  }

  _showDetailPanel(card) {
    const panel = document.getElementById('hallwayCardDetail');
    if (!panel) return;
    panel.style.display = 'flex';
    const sp = card.species;
    const photoEl = document.getElementById('hallwayCardPhoto');
    const nameEl = document.getElementById('hallwayCardName');
    const commonEl = document.getElementById('hallwayCardCommon');
    const metaEl = document.getElementById('hallwayCardMeta');
    const linkEl = document.getElementById('hallwayCardLink');
    const mapEl = document.getElementById('hallwayCardMap');

    nameEl.textContent = sp.name;
    commonEl.textContent = sp.common || '';
    commonEl.style.display = sp.common ? '' : 'none';

    const rankColor = cssColorForRank(sp.rank);
    panel.querySelector('.hallway-card-detail-inner').style.borderColor = rankColor;
    nameEl.style.color = rankColor;

    metaEl.innerHTML = '';
    const addMeta = (label, value) => {
      const a = document.createElement('div');
      a.className = 'label'; a.textContent = label;
      const b = document.createElement('div');
      b.className = 'value'; b.textContent = value;
      metaEl.appendChild(a); metaEl.appendChild(b);
    };
    addMeta('Rank', capitalize(sp.rank));
    addMeta('Observations', String(sp.count));
    addMeta('Taxon ID', String(sp.id));

    photoEl.classList.remove('is-missing');
    photoEl.style.backgroundImage = '';
    photoEl.textContent = 'Loading first observation…';

    linkEl.href = `https://www.inaturalist.org/observations?user_login=${encodeURIComponent(this.ctx.username)}&taxon_id=${sp.id}`;
    linkEl.textContent = `View ${sp.name} observations`;

    if (this._activeMap) { try { this._activeMap.remove(); } catch {} this._activeMap = null; }
    mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:.85rem;">Loading map…</div>';

    fetchObservationsForCard({ username: this.ctx.username, taxonId: sp.id, max: 100 })
      .then(({ points, first }) => {
        if (this._activeCard !== card) return;
        if (first) {
          addMeta('First seen', first.observed_on || first.time_observed_at || '—');
          linkEl.href = `https://www.inaturalist.org/observations/${first.id}`;
          linkEl.textContent = 'Open first observation';
          const photo = (first.photos?.[0]?.url || '').replace('square', 'medium');
          const cached = card._firstObs?.image_urls?.medium || card._firstObs?.image_urls?.small;
          const finalPhoto = cached || photo;
          if (finalPhoto) {
            photoEl.textContent = '';
            photoEl.style.backgroundImage = `url("${finalPhoto}")`;
          } else {
            photoEl.classList.add('is-missing');
            photoEl.textContent = 'No photo available';
          }
        } else {
          photoEl.classList.add('is-missing');
          photoEl.textContent = 'No observations with photos';
        }
        this._renderLeafletMap(mapEl, points, sp);
      })
      .catch(() => {
        photoEl.classList.add('is-missing');
        photoEl.textContent = 'Could not load observation';
        mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#f87171;font-size:.85rem;">Map unavailable</div>';
      });
  }

  _renderLeafletMap(container, points, species) {
    container.innerHTML = '';
    if (!window.L) {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:.85rem;">Map library not loaded</div>';
      return;
    }
    if (!points.length) {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:.85rem;">No georeferenced observations</div>';
      return;
    }
    const map = window.L.map(container, {
      zoomControl: false, attributionControl: false,
      dragging: true, scrollWheelZoom: false, doubleClickZoom: true
    });
    this._activeMap = map;
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, crossOrigin: true
    }).addTo(map);
    const color = cssColorForRank(species.rank);
    const markers = points.map(p =>
      window.L.circleMarker([p.lat, p.lon], {
        radius: 5, color, fillColor: color, fillOpacity: .85, weight: 1
      })
    );
    const group = window.L.featureGroup(markers).addTo(map);
    try { map.fitBounds(group.getBounds().pad(0.2), { animate: false, maxZoom: 9 }); }
    catch { map.setView([points[0].lat, points[0].lon], 5); }
    setTimeout(() => map.invalidateSize(), 80);
  }

  _hideDetailPanel() {
    const panel = document.getElementById('hallwayCardDetail');
    if (panel) panel.style.display = 'none';
    if (this._activeMap) { try { this._activeMap.remove(); } catch {} this._activeMap = null; }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  dispose() {
    this.pause();
    this._hideDetailPanel();
    for (const fn of this.disposeFns) { try { fn(); } catch {} }
    this.disposeFns.length = 0;
    this.scene?.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.map) {
            const src = m.map.source?.data?.src;
            if (!src || !textureCache.has(src)) m.map.dispose?.();
          }
          m.dispose?.();
        }
      }
    });
    this.renderer?.dispose();
    this.scene = null;
    this.cards = [];
    this.gates = [];
    this.rooms = [];
    this.waypoints = [];
  }

  resetCamera() {
    if (this._activeCard) this._closeActiveCard();
    if (this.layoutMode === 'linear') {
      this.camera.position.set(0, CAMERA_HEIGHT, 4);
      this.yaw = 0;
      this.pitch = 0;
      this._setLinearHud(0);
    } else if (this.tree) {
      this._enterRoom(this.tree);
    }
  }

  _refreshLayoutToggleBtn() {
    const btn = document.getElementById('hallwayLayoutToggle');
    if (!btn) return;
    btn.textContent = this.layoutMode === 'branching' ? 'Linear view' : 'Branching view';
    btn.title = this.layoutMode === 'branching'
      ? 'Switch to a single straight corridor of all species'
      : 'Switch to the branching room layout by rank';
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function lerpNum(a, b, t) { return a + (b - a) * t; }
// Yield to the browser so paint + progress text update during heavy build loops.
function yieldFrame() { return new Promise(r => setTimeout(r, 0)); }
function lerpAngle(a, b, t) {
  let d = ((b - a) + Math.PI) % (2 * Math.PI) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// Form wiring + lifecycle
// ---------------------------------------------------------------------------
let activeScene = null;

function showSpinner(text) {
  const s = document.getElementById('hallwaySpinner');
  const t = document.getElementById('hallwayLoadingText');
  if (s) s.style.display = 'flex';
  if (t && text) t.textContent = text;
}
function setSpinnerProgress(text) {
  const p = document.getElementById('hallwayLoadingProgress');
  if (p) p.textContent = text || '';
}
function hideSpinner() {
  const s = document.getElementById('hallwaySpinner');
  if (s) s.style.display = 'none';
  setSpinnerProgress('');
}
function showError(msg) {
  const card = document.querySelector('#hallwayPane .card-body');
  if (!card) return;
  const errorDiv = document.createElement('div');
  errorDiv.className = 'alert alert-danger mt-3';
  errorDiv.textContent = msg;
  card.appendChild(errorDiv);
  setTimeout(() => errorDiv.remove(), 8000);
}
function enterHallway(ctx) {
  const formCard = document.querySelector('#hallwayPane > .card');
  if (formCard) formCard.style.display = 'none';
  const sceneEl = document.getElementById('hallwayScene');
  if (sceneEl) sceneEl.style.display = 'block';
  const titleEl = document.getElementById('hallwayHudTitle');
  if (titleEl) titleEl.textContent = `${ctx.taxonName} — ${ctx.username}`;
  const subEl = document.getElementById('hallwayHudSub');
  if (subEl) subEl.textContent = 'Building the corridor…';
  document.body.style.overflow = 'hidden';
}
function exitHallway() {
  const formCard = document.querySelector('#hallwayPane > .card');
  if (formCard) formCard.style.display = '';
  const sceneEl = document.getElementById('hallwayScene');
  if (sceneEl) sceneEl.style.display = 'none';
  document.body.style.overflow = '';
  if (activeScene) {
    try { activeScene.dispose(); } catch {}
    activeScene = null;
  }
}
function readDates() {
  const d1 = (document.getElementById('hallwayObsStart')?.value || '').trim();
  const d2 = (document.getElementById('hallwayObsEnd')?.value   || '').trim();
  return { d1, d2 };
}

function wireAutocomplete() {
  const input = document.getElementById('hallwayTaxonName');
  const results = document.getElementById('hallwayAutocompleteResults');
  const hidden = document.getElementById('hallwaySelectedTaxonId');
  if (!input || !results || !hidden) return;
  let debounce = null;
  const render = (rows) => {
    results.innerHTML = '';
    if (!rows || !rows.length) { results.style.display = 'none'; return; }
    for (const r of rows) {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      const tid = r.taxon_id || r.id;
      const display = r.common_name || r.name;
      let html = `<strong>${escapeHtml(display)}</strong>`;
      if (r.common_name) html += ` <span class="scientific-name">${escapeHtml(r.name)}</span>`;
      html += ` <span class="taxon-id">${escapeHtml(r.rank || '')} (ID: ${tid})</span>`;
      item.innerHTML = html;
      item.addEventListener('click', () => {
        input.value = display; hidden.value = tid; results.style.display = 'none';
      });
      results.appendChild(item);
    }
    results.style.display = 'block';
  };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (debounce) clearTimeout(debounce);
    if (q.length < 2) { results.style.display = 'none'; return; }
    debounce = setTimeout(async () => {
      if (typeof window.searchTaxa === 'function') {
        try { render(await window.searchTaxa(q)); } catch { render([]); }
      }
    }, 150);
  });
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !results.contains(e.target)) {
      results.style.display = 'none';
    }
  });
}

function wireSearchTypeToggle() {
  const name = document.getElementById('hallwaySearchName');
  const id = document.getElementById('hallwaySearchId');
  const namePane = document.getElementById('hallwayNameSearch');
  const idPane = document.getElementById('hallwayIdSearch');
  if (!name || !id || !namePane || !idPane) return;
  name.addEventListener('change', () => {
    namePane.classList.add('active'); idPane.classList.remove('active');
  });
  id.addEventListener('change', () => {
    namePane.classList.remove('active'); idPane.classList.add('active');
  });
}

function wireFormSubmit() {
  const form = document.getElementById('hallwayForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('hallwayUsername').value.trim();
    let taxonId, taxonName;
    if (document.getElementById('hallwaySearchName').checked) {
      taxonId = document.getElementById('hallwaySelectedTaxonId').value;
      taxonName = document.getElementById('hallwayTaxonName').value.trim();
    } else {
      taxonId = document.getElementById('hallwayTaxonId').value;
      taxonName = `Taxon ${taxonId}`;
    }
    if (!username) { showError('Please enter a username.'); return; }
    if (!taxonId) { showError('Please select a taxon (or enter a taxon ID).'); return; }

    showSpinner('Gathering species from iNaturalist…');
    const { d1, d2 } = readDates();
    let species = [];
    try {
      species = await fetchUserSpecies({
        username, baseTaxonId: taxonId, d1, d2,
        onProgress: ({ page, total }) =>
          setSpinnerProgress(`Page ${page} · ${total} species found`)
      });
    } catch (err) {
      hideSpinner(); showError('Error fetching species: ' + err.message); return;
    }
    if (!species.length) {
      hideSpinner();
      showError('No observations found for this user under the selected taxon.');
      return;
    }
    hideSpinner();
    const layoutMode = (document.querySelector('input[name="hallwayLayoutMode"]:checked')?.value) || 'branching';
    const ctx = { username, baseTaxonId: Number(taxonId), taxonName, layoutMode };
    enterHallway(ctx);

    if (activeScene) { try { activeScene.dispose(); } catch {} activeScene = null; }
    const canvas = document.getElementById('hallwayCanvas');
    activeScene = new HallwayScene(canvas, ctx);
    const overlay = document.getElementById('hallwayLoadingOverlay');
    const overlayText = document.getElementById('hallwayOverlayText');
    if (overlay) overlay.style.display = 'flex';
    if (overlayText) overlayText.textContent = 'Starting hallway…';
    const onProgress = ({ pct, label }) => {
      if (!overlayText) return;
      const pctTxt = pct != null ? ` ${Math.round(pct * 100)}%` : '';
      overlayText.textContent = `${label}${pctTxt}`;
    };
    try {
      await activeScene.build(species, onProgress);
    } catch (err) {
      console.error('hallway build failed', err);
      showError('Building the hallway failed: ' + err.message);
    }
    if (overlay) overlay.style.display = 'none';
    activeScene.start();
  });
}

function wireSceneControls() {
  document.getElementById('hallwayExitBtn')?.addEventListener('click', exitHallway);
  document.getElementById('hallwayResetBtn')?.addEventListener('click', () => {
    activeScene?.resetCamera();
  });
  document.getElementById('hallwayCardClose')?.addEventListener('click', () => {
    activeScene?._closeActiveCard?.();
  });
  document.getElementById('hallwayLayoutToggle')?.addEventListener('click', async () => {
    if (!activeScene) return;
    const btn = document.getElementById('hallwayLayoutToggle');
    if (btn) btn.disabled = true;
    const overlay = document.getElementById('hallwayLoadingOverlay');
    const overlayText = document.getElementById('hallwayOverlayText');
    if (overlay) {
      if (overlayText) {
        overlayText.textContent = activeScene.layoutMode === 'branching'
          ? 'Flattening to a single corridor…'
          : 'Branching the corridors by rank…';
      }
      overlay.style.display = 'flex';
    }
    const onProgress = ({ pct, label }) => {
      if (!overlayText) return;
      const pctTxt = pct != null ? ` ${Math.round(pct * 100)}%` : '';
      overlayText.textContent = `${label}${pctTxt}`;
    };
    try {
      const next = activeScene.layoutMode === 'branching' ? 'linear' : 'branching';
      await activeScene.setLayoutMode(next, onProgress);
    } finally {
      if (overlay) overlay.style.display = 'none';
      if (btn) btn.disabled = false;
    }
  });
  window.addEventListener('hallway:tabchange', (e) => {
    const tabId = e.detail?.tabId;
    if (!activeScene) return;
    if (tabId === 'hallwayPane') activeScene.start();
    else activeScene.pause();
  });
  document.addEventListener('visibilitychange', () => {
    if (!activeScene) return;
    if (document.hidden) activeScene.pause();
    else if (document.body.classList.contains('in-hallway')) activeScene.start();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireAutocomplete();
  wireSearchTypeToggle();
  wireFormSubmit();
  wireSceneControls();
});
