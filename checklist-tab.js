// checklist-tab.js
const API = (window.CF_API_BASE || '').replace(/\/+$/, '');
const PUBLIC_MODE = !!window.PUBLIC_MODE;

function authHeaders(){
  const headers = { 'Accept': 'application/json' };
  try {
    const jwt = localStorage.getItem('inat_jwt');
    const token = localStorage.getItem('inat_token');
    if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
    else if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {}
  return headers;
}

// Minimal browser-side iNat fetch for checklist mode
async function fetchUserObsMinimal({ username, taxonId, placeId, maxPages=100 }) {
  const per=200; let page=1, all=[];
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  while (page<=maxPages) {
    const u = new URL('https://api.inaturalist.org/v1/observations');
    u.searchParams.set('user_login', username);
    u.searchParams.set('taxon_id', String(taxonId));
    if (placeId) u.searchParams.set('place_id', String(placeId));
    u.searchParams.set('include','taxon');
    u.searchParams.set('quality_grade','any');
    u.searchParams.set('verifiable','any');
    u.searchParams.set('per_page', String(per));
    u.searchParams.set('page', String(page));
    const r = await fetch(u);
    if (r.status===429 || (r.status>=500 && r.status<600)) { await sleep(1200+Math.random()*500); continue; }
    const j = await r.json().catch(()=>({results:[]}));
    const batch = j.results || [];
    all.push(...batch);
    if (batch.length < per) break;
    page++; await sleep(650 + Math.random()*200);
  }
  const ids = [...new Set(all.map(o=>o?.taxon?.id).filter(Boolean))];
  return { speciesIds: ids };
}

async function loadRegions(){
  const r = await fetch(`${API}/regions`, { headers: authHeaders() });
  const j = await r.json();
  return j.regions || [];
}

function setSpinner(on){ document.getElementById('clSpinner').style.display = on ? 'flex' : 'none'; }

async function hydrateRegion(regionCode){
  const r = await fetch(`${API}/checklist/hydrate`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', ...authHeaders() },
    body: JSON.stringify({ region_code: regionCode })
  });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(j?.error || r.statusText);
  return j;
}

async function initChecklistUI(){
  const form = document.getElementById('checklistForm');
  if (!form) return;

  const clRegion = document.getElementById('clRegion');
  const clTaxName = document.getElementById('clTaxonName');
  const clTaxId   = document.getElementById('clSelectedTaxonId');
  const clAuto    = document.getElementById('clAutocomplete');

  // regions
  try {
    const regions = await loadRegions();
    clRegion.innerHTML = '<option value="">Select a region…</option>';
    regions.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.code;
      opt.textContent = `${r.name} (${r.code})`;
      if (r.place_id != null) opt.dataset.placeId = String(r.place_id);
      clRegion.appendChild(opt);
    });
  } catch { clRegion.innerHTML = '<option value="">(failed to load regions)</option>'; }

  // autocomplete (reuse your /search-taxa)
  let tHandle = null;
  clTaxName.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clTaxId.value = '';
    if (tHandle) clearTimeout(tHandle);
    if (q.length < 2) { clAuto.style.display='none'; return; }
    tHandle = setTimeout(async () => {
      const u = new URL(`${API}/search-taxa`);
      u.searchParams.set('q', q); u.searchParams.set('limit','15');
      const r = await fetch(u, { headers: authHeaders() });
      const j = await r.json();
      clAuto.innerHTML = '';
      (j.results || []).forEach(t => {
        const div = document.createElement('div');
        div.className = 'autocomplete-item';
        div.innerHTML = `${t.common_name ? `<strong>${t.common_name}</strong> <span class="scientific-name">(${t.name})</span>` : `<span class="scientific-name">${t.name}</span>`} <span class="taxon-id">#${t.taxon_id||t.id}</span>`;
        div.addEventListener('click', () => {
          clTaxName.value = t.common_name ? `${t.common_name} (${t.name})` : t.name;
          clTaxId.value = t.taxon_id || t.id;
          clAuto.style.display = 'none';
        });
        clAuto.appendChild(div);
      });
      clAuto.style.display = clAuto.children.length ? 'block' : 'none';
    }, 200);
  });

  document.getElementById('clUseIdBtn').addEventListener('click', () => {
    const m = clTaxName.value.match(/\b(\d{1,9})\b/);
    if (m) { clTaxId.value = m[1]; alert(`Using taxon ID ${m[1]}`); }
    else { alert('Type/select a taxon or include a numeric ID in the box.'); }
  });

  // hydrate button
  document.getElementById('clHydrateBtn').addEventListener('click', async () => {
    const region = clRegion.value;
    const baseId = (document.getElementById('clSelectedTaxonId').value || '').trim();
    if (!region) return alert('Select a region first');

    setSpinner(true);
    try {
      const payload = baseId ? { region_code: region, baseTaxonId: parseInt(baseId,10) }
                             : { region_code: region };
      const r = await fetch(`${API}/checklist/hydrate`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', ...authHeaders() },
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || r.statusText);
      alert(`Hydrated ${j.hydrated_species_rows + j.hydrated_ancestor_rows} taxa for ${region}${baseId?` (base ${baseId})`:''}`);
    } catch (e) { 
      alert(`Hydrate failed: ${e.message}`); 
    } finally { 
      setSpinner(false); 
    }
  });

  // clear all
  document.getElementById('clClearBtn').addEventListener('click', () => {
    // This now correctly and exclusively uses the manager
    if (window.checklistManager) {
      window.checklistManager.clearAllTrees();
    }
  });

  // submit
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const username = document.getElementById('clUsername').value.trim();
    const region   = clRegion.value;
    const baseId   = (clTaxId.value || '').trim();
    const scope = (window.getLifelistScope ? window.getLifelistScope() : 'global');

    if (!username || !region || !baseId) {
      alert('Please provide username, region, and a base taxon ID.');
      return;
    }

    setSpinner(true);
    try {
      let payload = {
        username,
        region_code: region,
        baseTaxonId: parseInt(baseId, 10),
        scope
      };
      
      if (PUBLIC_MODE) {
        // If/when region-scoped fetch is needed, pass placeId here.
        const { speciesIds } = await fetchUserObsMinimal({ username, taxonId: parseInt(baseId,10), placeId: null });
        payload.seenSpeciesIds = speciesIds;
      }
      
      const r = await fetch(`${API}/checklist/tree`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(()=>({}));
      if (!r.ok) {
        if (r.status === 409 && /hydrate/i.test(j?.error||'')) {
          if (confirm('Region taxa not hydrated. Hydrate now?')) {
            await hydrateRegion(region);
            return form.dispatchEvent(new Event('submit')); // try again
          }
        }
        throw new Error(j?.error || r.statusText);
      }

      const taxonLabel = document.getElementById('clTaxonName').value || `Taxon ${baseId}`;
      const title = `Targets: ${region} — ${taxonLabel}`;
      
      // Use new addChecklistTreeTab function with map support
      addChecklistTreeTab(title, j.markdown);
    } catch (e) {
      console.error(e);
      alert(`Checklist build failed: ${e.message}`);
    } finally {
      setSpinner(false);
    }
  });
}

// Map helpers and badge wiring
const COLORS = ['#ef4444','#3b82f6','#22c55e','#a855f7','#eab308','#14b8a6','#f97316','#ec4899'];

function nextColor(state){
  const c = COLORS[state.colorIdx % COLORS.length];
  state.colorIdx++;
  return c;
}

function wireRangeButtons(pane){
  // delegate in the pane: any click on .range-trigger adds layers
  pane.addEventListener('click', (e) => {
    const a = e.target.closest('.range-trigger');
    if (!a) return;
    e.preventDefault();
    const taxonId = a.dataset.taxonId;
    const name = a.dataset.taxonName || a.textContent || `taxon ${taxonId}`;
    addSpeciesToMap(pane, taxonId, name);
  });
}

async function addSpeciesToMap(pane, taxonId, name){
  const state = pane._mapState;
  if (!state || state.addedIds.has(taxonId)) return;

  const color = nextColor(state);

  // Range GeoJSON
  let rangeLayer = null, hasRange = false;
  try {
    const rangeUrl = `https://inaturalist-open-data.s3.us-east-1.amazonaws.com/geomodel/geojsons/latest/${taxonId}.geojson`;
    const gj = await fetch(rangeUrl).then(r => { if(!r.ok) throw 0; return r.json(); });
    rangeLayer = L.geoJSON(gj, { style:{ color, weight:2, fillOpacity:.25 } });
    rangeLayer.bindPopup(`<b>${escapeHtml(name)}</b><br/>Range (Open Range Maps)`);
    hasRange = true;
  } catch {/* no range */}

  // Add range layer to group
  if (rangeLayer) {
    rangeLayer.addTo(state.rangeGroup);
  }

  // Observations (scoped to region if placeId)
  let obsLayer = null, hasObs = false;
  try {
    const u = new URL('https://api.inaturalist.org/v1/observations');
    u.searchParams.set('taxon_id', taxonId);
    if (pane.dataset.placeId) u.searchParams.set('place_id', pane.dataset.placeId); // ✅ constrained
    u.searchParams.set('per_page','200');
    u.searchParams.set('geo','true');
    u.searchParams.set('quality_grade','research');
    u.searchParams.set('order_by','observed_on');
    u.searchParams.set('order','desc');

    const j = await fetch(u, { headers: authHeaders() }).then(r => r.json());
    const pts = (j.results||[]).map(r => {
      if (r.location) {
        const [lat, lon] = String(r.location).split(',').map(Number);
        return (isFinite(lat)&&isFinite(lon)) ? {lat,lon,r} : null;
      } else if (r.geojson?.coordinates?.length===2){
        const [lon, lat] = r.geojson.coordinates.map(Number);
        return (isFinite(lat)&&isFinite(lon)) ? {lat,lon,r} : null;
      }
      return null;
    }).filter(Boolean);

    if (pts.length){
      obsLayer = L.layerGroup(
        pts.map(p => L.circleMarker([p.lat,p.lon], {
          radius:5, color, fillColor:color, fillOpacity:.8, weight:1
        }).bindPopup(renderObsPopup(p.r)))
      ).addTo(state.obsGroup);
      hasObs = true;
    }
  } catch {}

  // store per-species for later removal
  state.perSpecies[taxonId] = { rangeLayer, obsLayer, color, name };
  state.addedIds.add(taxonId);

  // legend row
  addLegendItem(pane, taxonId, name, color, hasRange, hasObs);

  // fit once
  const bounds = L.latLngBounds([]);
  if (rangeLayer?.getBounds) bounds.extend(rangeLayer.getBounds());
  if (obsLayer){
    obsLayer.getLayers().forEach(l => {
      if (l.getBounds) bounds.extend(l.getBounds());
      else if (l.getLatLng) bounds.extend([l.getLatLng()]);
    });
  }
  if (bounds.isValid()) state.map.fitBounds(bounds.pad(0.05));
}

function renderObsPopup(r){
  const id = r?.id;
  const url = id ? `https://www.inaturalist.org/observations/${id}` : null;
  const sci = r?.taxon?.name || '';
  const com = r?.taxon?.preferred_common_name || '';
  const when = r?.observed_on || r?.time_observed_at || '';
  const who = r?.user?.login || '';
  const photo = (r?.photos?.[0]?.url || '').replace('square','medium');
  const img = photo ? `<img src="${photo}" style="max-width:220px;width:100%;border-radius:6px;margin-top:6px">` : '';
  const link = url ? `<div style="margin-top:6px"><a href="${url}" target="_blank" rel="noopener">Open in iNaturalist ↗</a></div>` : '';
  return `<b>${escapeHtml(com || sci)}</b>${com && sci ? ` <i>(${escapeHtml(sci)})</i>` : ''}
          <br/>Observed: ${escapeHtml(when)}
          <br/>Observer: ${escapeHtml(who)}
          ${img}
          ${link}`;
}

function addNMore(pane, n){
  const anchors = [...pane.querySelectorAll('.range-trigger')];
  let added = 0;
  for (const a of anchors) {
    const id = a.dataset.taxonId;
    if (!pane._mapState.addedIds.has(id)) {
      addSpeciesToMap(pane, id, a.dataset.taxonName || '');
      if (++added >= n) break;
    }
  }
}

function removeSpeciesFromMap(pane, taxonId){
  const s = pane?._mapState; if (!s) return;
  const entry = s.perSpecies[taxonId]; if (!entry) return;
  if (entry.rangeLayer) s.rangeGroup.removeLayer(entry.rangeLayer);
  if (entry.obsLayer) s.obsGroup.removeLayer(entry.obsLayer);
  s.addedIds.delete(taxonId);
  delete s.perSpecies[taxonId];
}

function clearAllLayers(pane){
  const s = pane._mapState; if (!s) return;
  s.rangeGroup.clearLayers();
  s.obsGroup.clearLayers();
  s.perSpecies = Object.create(null);
  s.addedIds.clear();
  s.colorIdx = 0;
  clearLegend(pane);
}

function addChecklistTreeTab(title, markdown){
  showResultsCard();
  const id = uid();

  // Read region info at creation time
  const clRegion = document.getElementById('clRegion');
  const regionCode = clRegion.value;
  const regionName = clRegion.selectedOptions[0]?.textContent || regionCode;
  const placeId = clRegion.selectedOptions[0]?.dataset?.placeId || '';

  // Tab + pane
  const tabs = document.getElementById('clTreeTabs');
  const li = document.createElement('li'); li.className = 'nav-item';
  li.innerHTML = `<a class="nav-link" id="${id}-tab" data-bs-toggle="tab" href="#${id}-content" role="tab" aria-controls="${id}-content" aria-selected="false">${title}</a>`;
  tabs.appendChild(li);

  const content = document.getElementById('clTreeTabContent');
  const pane = document.createElement('div');
  pane.className = 'tab-pane';
  pane.id = `${id}-content`;
  pane.setAttribute('role','tabpanel');

  // stash for controls
  pane.dataset.regionCode = regionCode;
  pane.dataset.regionName = regionName;
  pane.dataset.placeId = placeId;
  pane.dataset.baseTitle = title;

  pane.innerHTML = `
    <div class="mb-2 d-flex gap-2 align-items-center">
      <button class="btn btn-sm btn-outline-primary" id="${id}-addMoreBtn">+4 More</button>
      <button class="btn btn-sm btn-outline-secondary" id="${id}-clearMapBtn">Clear Map</button>
      <span class="text-muted small">Tip: click 🗺️ next to a species in the tree to add its range & observations.</span>
    </div>
    <div id="${id}-map" style="height:420px;border-radius:10px;overflow:hidden;margin-bottom:12px;"></div>
    <div class="markmap-container"><svg id="${id}-svg" width="100%" height="700"></svg></div>
  `;
  content.appendChild(pane);

  document.getElementById('clMarkdownResult').textContent = markdown;
  activateTab(id);

  setTimeout(() => {
    // Leaflet map
    const map = L.map(`${id}-map`, { zoomControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    map.setView([20,0], 2);

    // map state
    pane._mapState = {
      map,
      rangeGroup: L.layerGroup().addTo(map),
      obsGroup: L.layerGroup().addTo(map),
      perSpecies: Object.create(null),
      addedIds: new Set(),
      colorIdx: 0
    };

    // 1) Title above everything
    addMapTitleControl(pane);

    // 2) Then the standard +/- (will appear *below* the title)
    L.control.zoom({ position: 'topleft' }).addTo(map);

    // 3) Then our fullscreen button (below zoom)
    addFullscreenControl(pane);

    // Add legend control
    addLegendControl(pane);

    // Markmap render
    const svg = document.getElementById(`${id}-svg`);
    svg.innerHTML = '';
    mmRender(svg, markdown);

    // Wire 🗺️ and initial +4
    wireRangeButtons(pane);
    addNMore(pane, 4);

    // Toolbar
    document.getElementById(`${id}-addMoreBtn`).onclick = () => addNMore(pane, 4);
    document.getElementById(`${id}-clearMapBtn`).onclick = () => clearAllLayers(pane);
  }, 50);
}

// Map control functions
function addMapTitleControl(pane){
  // title was your tab label like "Targets: US-NC — Robber Flies (Asilidae)"
  const base = (pane.dataset.baseTitle || '').replace(/^Targets:\s*/,'');
  const html = `
    <div class="mt-line1">Missing species for <strong>Targets:</strong></div>
    <div class="mt-line2">${escapeHtml(base)}</div>
  `;
  const TitleCtl = L.Control.extend({
    options:{ position:'topleft' },
    onAdd: function(){
      const div = L.DomUtil.create('div', 'leaflet-control map-title');
      div.innerHTML = html;
      L.DomEvent.disableClickPropagation(div);
      return div;
    }
  });
  new TitleCtl().addTo(pane._mapState.map);
}

function addFullscreenControl(pane){
  const map = pane._mapState.map;
  const targetEl = document.getElementById(`${pane.id||pane.getAttribute?.('id')||''}`); // fallback if needed
  const mapEl = document.getElementById(`${pane.id?.replace('-content','')}-map`) || pane.querySelector('[id$="-map"]');

  const FullscreenCtl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function(){
      // Use Leaflet's "bar" style for a native look
      const wrap = L.DomUtil.create('div', 'leaflet-bar');
      const a = L.DomUtil.create('a', '', wrap);
      a.href = '#';
      a.title = 'Full screen';
      a.setAttribute('aria-label','Full screen');
      a.style.lineHeight = '26px';
      a.style.width = '26px';
      a.style.textAlign = 'center';
      a.style.fontSize = '16px';
      a.textContent = '⛶';

      L.DomEvent.on(a, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        if (!mapEl) return;
        const on = !mapEl.classList.contains('is-fullscreen');
        mapEl.classList.toggle('is-fullscreen', on);
        // lock page scroll while fullscreen
        document.body.style.overflow = on ? 'hidden' : '';
        // Reflow the map after CSS change
        setTimeout(() => map.invalidateSize(true), 150);
      });

      return wrap;
    }
  });

  new FullscreenCtl().addTo(map);
}

function addLegendControl(pane){
  const LegendCtl = L.Control.extend({
    options:{ position:'bottomright' },
    onAdd: function(){
      const div = L.DomUtil.create('div', 'leaflet-control missing-legend');
      div.innerHTML = `
        <div class="legend-title">Missing species layers</div>
        <div class="legend-items"></div>`;
      L.DomEvent.disableClickPropagation(div);
      return div;
    }
  });
  const ctl = new LegendCtl();
  ctl.addTo(pane._mapState.map);
  pane._mapState.legendCtl = ctl;
  pane._mapState.legendEl = ctl.getContainer().querySelector('.legend-items');

  // toggle & remove handlers
  pane._mapState.legendEl.addEventListener('change', (e)=>{
    const item = e.target.closest('.legend-item'); if (!item) return;
    const taxonId = item.dataset.taxonId;
    const s = pane._mapState; const entry = s.perSpecies[taxonId]; if (!entry) return;
    if (e.target.classList.contains('tog-range') && entry.rangeLayer){
      if (e.target.checked) s.rangeGroup.addLayer(entry.rangeLayer);
      else s.rangeGroup.removeLayer(entry.rangeLayer);
    }
    if (e.target.classList.contains('tog-obs') && entry.obsLayer){
      if (e.target.checked) s.obsGroup.addLayer(entry.obsLayer);
      else s.obsGroup.removeLayer(entry.obsLayer);
    }
  });
  pane._mapState.legendEl.addEventListener('click', (e)=>{
    const btn = e.target.closest('.legend-remove'); if (!btn) return;
    const item = btn.closest('.legend-item');
    const taxonId = item?.dataset?.taxonId;
    if (taxonId) removeSpeciesFromMap(pane, taxonId);
    item?.remove();
  });
}

function addLegendItem(pane, taxonId, name, color, hasRange, hasObs){
  const el = pane._mapState.legendEl;
  const row = document.createElement('div');
  row.className = 'legend-item';
  row.dataset.taxonId = taxonId;
  row.innerHTML = `
    <span class="swatch" style="background:${color}"></span>
    <span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    <label class="tog"><input type="checkbox" class="tog-range" ${hasRange?'checked':''}> Range</label>
    <label class="tog"><input type="checkbox" class="tog-obs" ${hasObs?'checked':''}> Obs</label>
    <button class="legend-remove" title="Remove this species">&times;</button>`;
  el.appendChild(row);
}

function clearLegend(pane){
  if (pane?._mapState?.legendEl) pane._mapState.legendEl.innerHTML = '';
}

function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// Helper functions
function showResultsCard() {
  const card = document.getElementById('clResultsCard');
  if (card) card.style.display = 'block';
}

function uid() {
  return 'cl_' + Math.random().toString(36).substr(2, 9);
}

function activateTab(id) {
  // Remove active from all tabs
  document.querySelectorAll('#clTreeTabs .nav-link').forEach(tab => {
    tab.classList.remove('active');
    tab.setAttribute('aria-selected', 'false');
  });
  
  // Add active to new tab
  const newTab = document.getElementById(`${id}-tab`);
  if (newTab) {
    newTab.classList.add('active');
    newTab.setAttribute('aria-selected', 'true');
  }
  
  // Remove active from all panes
  document.querySelectorAll('#clTreeTabContent .tab-pane').forEach(pane => {
    pane.classList.remove('show', 'active');
  });
  
  // Add active to new pane
  const newPane = document.getElementById(`${id}-content`);
  if (newPane) {
    newPane.classList.add('show', 'active');
  }
}

function mmRender(svg, markdown) {
  if (window.checklistManager && window.checklistManager.renderTree) {
    // Create a temporary tree object for rendering
    const tempTree = {
      id: svg.id.replace('-svg', ''),
      markdown: markdown,
      isChecklist: true
    };
    window.checklistManager.renderTree(tempTree);
  }
}

document.addEventListener('DOMContentLoaded', initChecklistUI);