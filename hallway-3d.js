// hallway-3d.js — 3D taxonomic hallway view.
//
// Builds an immersive corridor of a user's iNaturalist observations:
// each species hangs as a card on the wall. Click a card to flip it
// and see stats + a Leaflet map of where the user observed it.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants (mirrored from tree-manager.js so the look stays consistent)
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

// Layout
const CORRIDOR_HALF_WIDTH = 2.5;
const WALL_HEIGHT = 3.4;
const CARD_W = 1.25;
const CARD_H = 0.95;
const CARDS_PER_BAY_SIDE = 3;
const CARDS_PER_BAY = CARDS_PER_BAY_SIDE * 2;
const BAY_DEPTH = 5.0;
const BAY_GAP = 0.9;
const ENTRY_DEPTH = 4.0;
const CARD_Y = 1.65;
const CAMERA_HEIGHT = 1.65;
const MAX_CARDS = 360; // cap to avoid pathological cases (huge taxa)

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

async function fetchTaxaNames(ids) {
  const out = {};
  const chunk = 30;
  for (let i = 0; i < ids.length; i += chunk) {
    const c = ids.slice(i, i + chunk).filter(Boolean);
    if (!c.length) continue;
    try {
      const r = await fetch(`https://api.inaturalist.org/v1/taxa/${c.join(',')}`);
      const j = await r.json();
      for (const t of (j.results || [])) {
        out[t.id] = {
          name: t.name,
          common: t.preferred_common_name || '',
          rank: String(t.rank || '').toLowerCase()
        };
      }
    } catch {}
  }
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
// Grouping species into bays
// ---------------------------------------------------------------------------
function groupSpeciesIntoBays(species) {
  // Sort so taxonomically-related species sit next to each other.
  const sorted = [...species].sort((a, b) => {
    const aKey = a.ancestors.join(',') + '/' + (a.name || '');
    const bKey = b.ancestors.join(',') + '/' + (b.name || '');
    return aKey.localeCompare(bKey);
  });

  const bays = [];
  for (let i = 0; i < sorted.length; i += CARDS_PER_BAY) {
    const slice = sorted.slice(i, i + CARDS_PER_BAY);
    const sets = slice.map(s => new Set(s.ancestors));
    const first = slice[0].ancestors;
    let sharedDeepest = null;
    for (let j = first.length - 1; j >= 0; j--) {
      const aid = first[j];
      if (sets.every(set => set.has(aid))) { sharedDeepest = aid; break; }
    }
    bays.push({ species: slice, sharedAncestorId: sharedDeepest });
  }
  return bays;
}

// ---------------------------------------------------------------------------
// Texture helpers
// ---------------------------------------------------------------------------
const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin('anonymous');
const textureCache = new Map();

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

function makeLabelTexture({ title, subtitle, color = '#22c55e', big = false }) {
  const w = 512, h = 384;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  // gradient background
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#1f2937');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // accent border
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, w - 10, h - 10);

  // title (scientific name)
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const titleSize = big ? 44 : 36;
  ctx.font = `italic 700 ${titleSize}px Georgia, serif`;
  wrapText(ctx, title || '—', w / 2, h / 2 - 20, w - 60, titleSize + 8);

  if (subtitle) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 22px sans-serif';
    wrapText(ctx, subtitle, w / 2, h / 2 + 60, w - 60, 26);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
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
  // Limit to 3 lines so the canvas doesn't overflow
  const shown = lines.slice(0, 3);
  const startY = y - ((shown.length - 1) * lineHeight) / 2;
  shown.forEach((ln, i) => ctx.fillText(ln, x, startY + i * lineHeight));
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
  wrapText(ctx, species.name || '—', w / 2, 90, w - 60, 42);

  if (species.common) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 22px sans-serif';
    wrapText(ctx, species.common, w / 2, 160, w - 60, 26);
  }

  ctx.fillStyle = accent;
  ctx.font = '700 18px sans-serif';
  ctx.fillText(`${species.rank.toUpperCase()}`, w / 2, 220);

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '500 20px sans-serif';
  ctx.fillText(`${species.count} observation${species.count === 1 ? '' : 's'}`, w / 2, 260);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 16px sans-serif';
  ctx.fillText('Tap card front for full details →', w / 2, h - 38);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
class HallwayScene {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx; // { username, baseTaxonId, taxonName }
    this.species = [];
    this.bays = [];
    this.cards = [];
    this.bayInfo = []; // { z, label, color }
    this.disposeFns = [];
    this._activeCard = null;
    this._locked = false;
    this._cameraTween = null;
    this._frameId = null;
    this._lastCursorPick = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06070a);
    this.scene.fog = new THREE.Fog(0x06070a, 16, 70);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 200);
    this.camera.position.set(0, CAMERA_HEIGHT, ENTRY_DEPTH);
    this.camera.rotation.order = 'YXZ';

    this.cardsGroup = new THREE.Group();
    this.scene.add(this.cardsGroup);
    this.structureGroup = new THREE.Group();
    this.scene.add(this.structureGroup);

    this.raycaster = new THREE.Raycaster();
    this.mouseNdc = new THREE.Vector2();

    // Controls / input state
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.dragging = false;
    this.lastMouse = { x: 0, y: 0 };
    this._dragTotal = 0;

    this.clock = new THREE.Clock();

    this._setupLights();
    this._attachEvents();
    this._resize();
  }

  _setupLights() {
    const ambient = new THREE.AmbientLight(0xfff5e6, 0.35);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xfff0d6, 0.45);
    dir.position.set(2, 8, 6);
    this.scene.add(dir);

    // Hemisphere fill so the "ceiling" doesn't go pitch black
    const hemi = new THREE.HemisphereLight(0x8090a0, 0x101010, 0.35);
    this.scene.add(hemi);
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
      if (e.button !== 0) return;
      if (this._activeCard) return;
      this.dragging = true;
      this._dragTotal = 0;
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
      if (wasDragging && this._dragTotal < 6 && !this._activeCard && !this._locked) {
        this._handleClick(e);
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
      this._clampCamera();
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

  _clampCamera() {
    const p = this.camera.position;
    p.x = Math.max(-CORRIDOR_HALF_WIDTH + 0.5, Math.min(CORRIDOR_HALF_WIDTH - 0.5, p.x));
    p.y = CAMERA_HEIGHT;
    const back = ENTRY_DEPTH;
    const far  = this._farthestZ();
    p.z = Math.max(far + 1.0, Math.min(back, p.z));
  }

  _farthestZ() {
    if (!this.bayInfo.length) return -2;
    return this.bayInfo[this.bayInfo.length - 1].z - BAY_DEPTH;
  }

  // -------------------------------------------------------------------------
  // Build geometry
  // -------------------------------------------------------------------------
  async build(species) {
    this.species = species.slice(0, MAX_CARDS);
    this.bays = groupSpeciesIntoBays(this.species);

    const totalLength =
      ENTRY_DEPTH +
      this.bays.length * BAY_DEPTH +
      Math.max(0, this.bays.length - 1) * BAY_GAP +
      2.0;

    this._buildCorridor(totalLength);
    this._placeCards();

    // Try to label bays with their shared ancestor's name. Fire and forget;
    // labels are added to the HUD via a lookup map.
    const ancIds = this.bays.map(b => b.sharedAncestorId).filter(Boolean);
    const unique = [...new Set(ancIds)];
    this._ancestorNames = {};
    fetchTaxaNames(unique).then(map => {
      this._ancestorNames = map;
    }).catch(() => {});

    // Kick off async first-photo loads for the user's actual observations.
    // Replaces the default-photo textures as they arrive.
    this._loadUserPhotos();
  }

  _buildCorridor(totalLength) {
    const startZ = ENTRY_DEPTH;
    const endZ = startZ - totalLength;

    // Floor
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x2a2018,
      roughness: 0.85,
      metalness: 0.0
    });
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(CORRIDOR_HALF_WIDTH * 2 + 0.4, totalLength + 4),
      floorMat
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, (startZ + endZ) / 2);
    this.structureGroup.add(floor);

    // Ceiling
    const ceilMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a14,
      roughness: 1.0
    });
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(CORRIDOR_HALF_WIDTH * 2 + 0.4, totalLength + 4),
      ceilMat
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, WALL_HEIGHT, (startZ + endZ) / 2);
    this.structureGroup.add(ceiling);

    // Walls (left/right)
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x252836,
      roughness: 0.9
    });
    const wallGeo = new THREE.PlaneGeometry(totalLength + 4, WALL_HEIGHT);

    const wallLeft = new THREE.Mesh(wallGeo, wallMat);
    wallLeft.rotation.y = Math.PI / 2;
    wallLeft.position.set(-CORRIDOR_HALF_WIDTH, WALL_HEIGHT / 2, (startZ + endZ) / 2);
    this.structureGroup.add(wallLeft);

    const wallRight = new THREE.Mesh(wallGeo.clone(), wallMat);
    wallRight.rotation.y = -Math.PI / 2;
    wallRight.position.set(CORRIDOR_HALF_WIDTH, WALL_HEIGHT / 2, (startZ + endZ) / 2);
    this.structureGroup.add(wallRight);

    // Far back wall (cap)
    const cap = new THREE.Mesh(
      new THREE.PlaneGeometry(CORRIDOR_HALF_WIDTH * 2, WALL_HEIGHT),
      new THREE.MeshStandardMaterial({ color: 0x12141c, roughness: 1.0 })
    );
    cap.position.set(0, WALL_HEIGHT / 2, endZ - 0.5);
    this.structureGroup.add(cap);

    // Lights along corridor — gallery-style point lights
    const lightSpacing = BAY_DEPTH;
    for (let z = startZ - 1; z > endZ; z -= lightSpacing) {
      const light = new THREE.PointLight(0xffe6b8, 1.1, 9, 1.6);
      light.position.set(0, WALL_HEIGHT - 0.25, z);
      this.scene.add(light);
    }
  }

  _placeCards() {
    let z = ENTRY_DEPTH - 1.0; // first bay starts here
    this.bayInfo = [];

    this.bays.forEach((bay, bayIdx) => {
      const bayStartZ = z;
      const bayEndZ = bayStartZ - BAY_DEPTH;

      // Rank color of bay (based on shared ancestor's species, or last species' rank fallback)
      const repRank = bay.species[0]?.rank || 'species';
      const accentHex = colorForRank(repRank);

      // Top accent stripe (visible from inside corridor)
      const stripeMat = new THREE.MeshStandardMaterial({
        color: accentHex,
        emissive: accentHex,
        emissiveIntensity: 0.35,
        roughness: 0.4
      });
      const stripeGeo = new THREE.BoxGeometry(0.1, 0.12, BAY_DEPTH - 0.2);

      const stripeL = new THREE.Mesh(stripeGeo, stripeMat);
      stripeL.position.set(-CORRIDOR_HALF_WIDTH + 0.06, WALL_HEIGHT - 0.25, (bayStartZ + bayEndZ) / 2);
      this.structureGroup.add(stripeL);

      const stripeR = new THREE.Mesh(stripeGeo.clone(), stripeMat);
      stripeR.position.set(CORRIDOR_HALF_WIDTH - 0.06, WALL_HEIGHT - 0.25, (bayStartZ + bayEndZ) / 2);
      this.structureGroup.add(stripeR);

      // Place cards in this bay
      const slotZs = [];
      for (let i = 0; i < CARDS_PER_BAY_SIDE; i++) {
        const t = (i + 0.5) / CARDS_PER_BAY_SIDE;
        slotZs.push(bayStartZ - 0.3 - t * (BAY_DEPTH - 0.6));
      }
      let cardIdx = 0;
      for (let side = 0; side < 2; side++) {
        const sign = side === 0 ? -1 : 1; // -1 = left wall
        for (let i = 0; i < CARDS_PER_BAY_SIDE; i++) {
          const sp = bay.species[cardIdx++];
          if (!sp) continue;
          const cardZ = slotZs[i];
          const card = this._makeCard(sp);
          card.group.position.set(sign * (CORRIDOR_HALF_WIDTH - 0.04), CARD_Y, cardZ);
          card.group.rotation.y = sign === -1 ? Math.PI / 2 : -Math.PI / 2;
          // Front-face world normal (points into corridor when unflipped)
          card.frontNormal = new THREE.Vector3(-sign, 0, 0);
          this.cardsGroup.add(card.group);
          this.cards.push(card);
        }
      }

      this.bayInfo.push({
        z: bayStartZ,
        sharedAncestorId: bay.sharedAncestorId,
        color: cssColorForRank(repRank)
      });

      z = bayEndZ - BAY_GAP;
    });
  }

  _makeCard(species) {
    // Outer group: positions + orients on a wall (rotation.y = ±π/2).
    // Inner group: handles the flip animation around its own Y axis.
    // Because inner is parented to outer, its local Y axis stays aligned
    // with world +Y after outer's pure-Y rotation, so spinning inner around
    // its Y axis flips the card around a vertical axis — like turning over
    // a postcard hanging on the wall.
    const group = new THREE.Group();
    const flipGroup = new THREE.Group();
    group.add(flipGroup);

    const accent = cssColorForRank(species.rank);
    const placeholderTex = makeLabelTexture({
      title: species.name,
      subtitle: species.common,
      color: accent
    });
    const backTex = makeBackTexture(species);

    const frontMat = new THREE.MeshStandardMaterial({
      map: placeholderTex,
      roughness: 0.6,
      metalness: 0.0
    });
    const backMat = new THREE.MeshStandardMaterial({
      map: backTex,
      roughness: 0.6,
      metalness: 0.0
    });

    const geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
    const front = new THREE.Mesh(geo, frontMat);
    front.position.z = 0.002;
    const back = new THREE.Mesh(geo.clone(), backMat);
    back.rotation.y = Math.PI;
    back.position.z = -0.002;

    // Frame: a thin colored box behind the card
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

    return {
      group,
      flipGroup,
      frontMesh: front,
      backMesh: back,
      species,
      flipping: false,
      flipped: false,
      flipT: 0,
      flipFrom: 0,
      flipTo: 0,
      _placeholderTex: placeholderTex
    };
  }

  // -------------------------------------------------------------------------
  // Async photo loading for user's first observation
  // -------------------------------------------------------------------------
  async _loadUserPhotos() {
    const username = this.ctx.username;
    let concurrency = 6;
    let idx = 0;
    const cards = this.cards;
    const getFirstObs = window.getFirstObs;

    const worker = async () => {
      while (idx < cards.length) {
        const myIdx = idx++;
        const card = cards[myIdx];
        try {
          let url = null;
          if (getFirstObs) {
            try {
              const info = await getFirstObs(username, card.species.id);
              url = info?.image_urls?.medium || info?.image_urls?.small || info?.image_urls?.thumb || null;
              card._firstObs = info;
            } catch {}
          }
          if (!url) url = card.species.defaultPhoto;
          if (!url) continue;
          const tex = await loadTexture(url);
          if (tex && card.frontMesh) {
            // The plane is wider than tall; if the photo is portrait, fit it without distortion
            tex.center.set(0.5, 0.5);
            const aspect = (tex.image?.width || 1) / (tex.image?.height || 1);
            const target = CARD_W / CARD_H;
            if (aspect > target) {
              // wider than card → crop sides
              tex.repeat.set(target / aspect, 1);
              tex.offset.set((1 - target / aspect) / 2, 0);
            } else {
              // taller than card → crop top/bottom
              tex.repeat.set(1, aspect / target);
              tex.offset.set(0, (1 - aspect / target) / 2);
            }
            card.frontMesh.material.map?.dispose?.();
            card.frontMesh.material.map = tex;
            card.frontMesh.material.needsUpdate = true;
          }
        } catch {}
        // tiny gap to keep the UI responsive
        await new Promise(r => setTimeout(r, 10));
      }
    };
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    Promise.all(workers).catch(() => {});
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
    // Camera rotation from yaw/pitch
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;

    // Movement (WASD / arrow keys) — disabled while a card is open
    if (!this._activeCard) {
      const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 7.0 : 3.5;
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
        this._clampCamera();
      }
    }

    // Camera tween toward a focused card
    if (this._cameraTween) {
      const ct = this._cameraTween;
      ct.t += dt / ct.duration;
      const k = Math.min(1, ct.t);
      const e = easeInOut(k);
      this.camera.position.lerpVectors(ct.fromPos, ct.toPos, e);
      this.yaw   = lerpAngle(ct.fromYaw, ct.toYaw, e);
      this.pitch = lerpNum(ct.fromPitch, ct.toPitch, e);
      if (k >= 1) this._cameraTween = null;
    }

    // Card flip animations — rotate the inner flipGroup around its Y axis.
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

    this._updateHud();
  }

  _updateHud() {
    if (!this.bayInfo.length) return;
    const z = this.camera.position.z;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.bayInfo.length; i++) {
      const d = Math.abs(this.bayInfo[i].z - BAY_DEPTH / 2 - z);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const bay = this.bayInfo[bestIdx];
    const titleEl = document.getElementById('hallwayHudTitle');
    const subEl = document.getElementById('hallwayHudSub');
    if (!titleEl || !subEl) return;

    const anc = this._ancestorNames?.[bay.sharedAncestorId];
    const total = this.species.length;
    const cardsBefore = bestIdx * CARDS_PER_BAY;
    const cardsInBay = this.bays[bestIdx]?.species?.length || 0;

    const label = anc
      ? `${anc.rank ? capitalize(anc.rank) + ' ' : ''}${anc.name}${anc.common ? ` (${anc.common})` : ''}`
      : `Bay ${bestIdx + 1} of ${this.bays.length}`;
    titleEl.textContent = label;
    titleEl.style.borderLeft = `4px solid ${bay.color}`;
    titleEl.style.paddingLeft = '10px';
    subEl.textContent =
      `Species ${cardsBefore + 1}–${cardsBefore + cardsInBay} of ${total} · ${this.ctx.username} @ ${this.ctx.taxonName}`;
  }

  // -------------------------------------------------------------------------
  // Click → flip card → open detail panel
  // -------------------------------------------------------------------------
  _handleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNdc, this.camera);

    const meshes = this.cards.map(c => c.frontMesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;
    const mesh = hits[0].object;
    const card = this.cards.find(c => c.frontMesh === mesh);
    if (card) this._openCard(card);
  }

  _openCard(card) {
    if (this._activeCard) return;
    this._activeCard = card;

    // Fly the camera to a viewing pose ~2.2m in front of the card
    const cardPos = new THREE.Vector3();
    card.group.getWorldPosition(cardPos);
    const targetPos = cardPos.clone().addScaledVector(card.frontNormal, 2.2);
    targetPos.y = CAMERA_HEIGHT;

    const lookDir = cardPos.clone().sub(targetPos).normalize();
    const targetYaw = Math.atan2(lookDir.x, lookDir.z) + Math.PI; // camera looks down -Z by default
    const targetPitch = 0;

    this._cameraTween = {
      fromPos: this.camera.position.clone(),
      toPos: targetPos,
      fromYaw: this.yaw,
      toYaw: targetYaw,
      fromPitch: this.pitch,
      toPitch: targetPitch,
      t: 0,
      duration: 0.6
    };

    // Start the flip (rotate inner group around its local Y axis = vertical)
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
      a.className = 'label';
      a.textContent = label;
      const b = document.createElement('div');
      b.className = 'value';
      b.textContent = value;
      metaEl.appendChild(a);
      metaEl.appendChild(b);
    };
    addMeta('Rank', capitalize(sp.rank));
    addMeta('Observations', String(sp.count));
    addMeta('Taxon ID', String(sp.id));

    photoEl.classList.remove('is-missing');
    photoEl.style.backgroundImage = '';
    photoEl.textContent = 'Loading first observation…';

    linkEl.href = `https://www.inaturalist.org/observations?user_login=${encodeURIComponent(this.ctx.username)}&taxon_id=${sp.id}`;
    linkEl.textContent = `View ${sp.name} observations`;

    // Tear down any previous Leaflet map
    if (this._activeMap) {
      try { this._activeMap.remove(); } catch {}
      this._activeMap = null;
    }
    mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:.85rem;">Loading map…</div>';

    // Fetch this card's observation data lazily
    fetchObservationsForCard({ username: this.ctx.username, taxonId: sp.id, max: 100 })
      .then(({ points, first }) => {
        if (this._activeCard !== card) return; // user closed/swapped already
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
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: true
    });
    this._activeMap = map;
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      crossOrigin: true
    }).addTo(map);
    const color = cssColorForRank(species.rank);
    const markers = points.map(p =>
      window.L.circleMarker([p.lat, p.lon], {
        radius: 5, color, fillColor: color, fillOpacity: .85, weight: 1
      })
    );
    const group = window.L.featureGroup(markers).addTo(map);
    try {
      map.fitBounds(group.getBounds().pad(0.2), { animate: false, maxZoom: 9 });
    } catch {
      map.setView([points[0].lat, points[0].lon], 5);
    }
    // Force a redraw once it's laid out
    setTimeout(() => map.invalidateSize(), 80);
  }

  _hideDetailPanel() {
    const panel = document.getElementById('hallwayCardDetail');
    if (panel) panel.style.display = 'none';
    if (this._activeMap) {
      try { this._activeMap.remove(); } catch {}
      this._activeMap = null;
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  dispose() {
    this.pause();
    this._hideDetailPanel();
    for (const fn of this.disposeFns) { try { fn(); } catch {} }
    this.disposeFns.length = 0;
    // Dispose materials/geometries/textures
    this.scene.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.map && !textureCache.has(m.map?.source?.data?.src)) m.map.dispose?.();
          m.dispose?.();
        }
      }
    });
    this.renderer.dispose();
    this.scene = null;
    this.cards = [];
    this.bays = [];
  }

  resetCamera() {
    this.camera.position.set(0, CAMERA_HEIGHT, ENTRY_DEPTH);
    this.yaw = 0;
    this.pitch = 0;
    if (this._activeCard) this._closeActiveCard();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function lerpNum(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) {
  let d = ((b - a) + Math.PI) % (2 * Math.PI) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}
function capitalize(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }

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
  if (subEl) subEl.textContent = 'Building corridor…';
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

// Autocomplete wiring — re-uses window.searchTaxa from script.js
function wireAutocomplete() {
  const input = document.getElementById('hallwayTaxonName');
  const results = document.getElementById('hallwayAutocompleteResults');
  const hidden = document.getElementById('hallwaySelectedTaxonId');
  if (!input || !results || !hidden) return;

  let debounce = null;

  const render = (rows) => {
    results.innerHTML = '';
    if (!rows || !rows.length) {
      results.style.display = 'none';
      return;
    }
    for (const r of rows) {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      const tid = r.taxon_id || r.id;
      const display = r.common_name || r.name;
      let html = `<strong>${display}</strong>`;
      if (r.common_name) html += ` <span class="scientific-name">${r.name}</span>`;
      html += ` <span class="taxon-id">${r.rank || ''} (ID: ${tid})</span>`;
      item.innerHTML = html;
      item.addEventListener('click', () => {
        input.value = display;
        hidden.value = tid;
        results.style.display = 'none';
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

// Radio toggle for name vs ID
function wireSearchTypeToggle() {
  const name = document.getElementById('hallwaySearchName');
  const id = document.getElementById('hallwaySearchId');
  const namePane = document.getElementById('hallwayNameSearch');
  const idPane = document.getElementById('hallwayIdSearch');
  if (!name || !id || !namePane || !idPane) return;
  name.addEventListener('change', () => {
    namePane.classList.add('active');
    idPane.classList.remove('active');
  });
  id.addEventListener('change', () => {
    namePane.classList.remove('active');
    idPane.classList.add('active');
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
        username,
        baseTaxonId: taxonId,
        d1,
        d2,
        onProgress: ({ page, total }) =>
          setSpinnerProgress(`Page ${page} · ${total} species found`)
      });
    } catch (err) {
      hideSpinner();
      showError('Error fetching species: ' + err.message);
      return;
    }

    if (!species.length) {
      hideSpinner();
      showError('No observations found for this user under the selected taxon.');
      return;
    }

    hideSpinner();
    const ctx = { username, baseTaxonId: Number(taxonId), taxonName };
    enterHallway(ctx);

    // Build scene (dispose any previous scene first)
    if (activeScene) {
      try { activeScene.dispose(); } catch {}
      activeScene = null;
    }
    const canvas = document.getElementById('hallwayCanvas');
    activeScene = new HallwayScene(canvas, ctx);
    const overlay = document.getElementById('hallwayLoadingOverlay');
    if (overlay) overlay.style.display = 'flex';
    try {
      await activeScene.build(species);
    } catch (err) {
      console.error('hallway build failed', err);
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

  // Pause render loop when leaving the tab (perf + battery)
  window.addEventListener('hallway:tabchange', (e) => {
    const tabId = e.detail?.tabId;
    if (!activeScene) return;
    if (tabId === 'hallwayPane') activeScene.start();
    else activeScene.pause();
  });

  // Pause when document is hidden
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
