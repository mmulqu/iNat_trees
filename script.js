import { startLogin, handleCallback, getAuthHeaders } from './auth.js';

// Handle auth callback (support either path; we use /callback.html)
if (window.location.pathname === '/callback.html' || window.location.pathname === '/auth/callback') {
  handleCallback();
}

// Add login button handler
document.getElementById('inatLogin')?.addEventListener('click', startLogin);

// Force Cloudflare Worker API base
const API_BASE = window.CF_API_BASE;
const PUBLIC_MODE = !!window.PUBLIC_MODE;
if (!API_BASE) {
  console.error('CF_API_BASE is not set. Set window.CF_API_BASE to your Worker URL.');
}
const searchTaxaUrl = `${API_BASE}/search-taxa`;
const edgeFunctionUrl = `${API_BASE}/build-taxonomy`;
window.API_BASE = API_BASE;

// Browser-only species set via /observations/species_counts (no photos here)
async function fetchUserSpeciesViaCounts({ username, taxonId, placeId, d1, d2, maxPages = 50, onProgress }) {
  const per = 200;
  let page = 1;
  const species = new Set();

  while (page <= maxPages) {
    const u = new URL('https://api.inaturalist.org/v1/observations/species_counts');
    u.searchParams.set('user_login', username);
    u.searchParams.set('taxon_id', String(taxonId));
    if (placeId) u.searchParams.set('place_id', String(placeId));
    if (d1) u.searchParams.set('d1', d1);
    if (d2) u.searchParams.set('d2', d2);
    u.searchParams.set('verifiable', 'any');
    u.searchParams.set('quality_grade', 'any');
    u.searchParams.set('include', 'taxon');
    u.searchParams.set('per_page', String(per));
    u.searchParams.set('page', String(page));

    // Report progress
    if (onProgress) onProgress({ page, species: species.size, phase: 'fetching' });

    const r = await fetch(u);
    if (!r.ok) break;
    const j = await r.json().catch(() => ({ results: [] }));
    const rows = j.results || [];
    for (const row of rows) {
      const tid = row?.taxon?.id;
      if (tid) species.add(tid);
    }
    if (rows.length < per) break;
    page += 1;
    await new Promise(res => setTimeout(res, 500));
  }

  // Report completion
  if (onProgress) onProgress({ page, species: species.size, phase: 'complete' });

  return Array.from(species);
}

const loadingMessages = [
  "Coaxing DNA to tell its evolutionary secrets...",
  "Unraveling the tree of life, one branch at a time...",
  "Consulting with Darwin about your taxonomy...",
  "Politely asking species to line up in order...",
  "Counting rings on the tree of life...",
  "Persuading taxonomists to agree on classifications...",
  "Gathering specimens from the digital wild...",
  "Dusting off Linnaeus' old notebooks...",
  "Herding taxonomic cats into hierarchical boxes...",
  "Calculating phylogenetic distances while sipping tea...",
  "Untangling evolutionary spaghetti...",
  "Converting genetic code to pretty pictures...",
  "Teaching old species new tricks...",
  "Searching for the missing links...",
  "Translating from Latin to Markdown...",
  "Convincing kingdoms, phyla, and classes to cooperate..."
];

const VALID_HIGHER_RANKS = new Set([
  'genus', 'family', 'subfamily', 'tribe', 'subtribe', 'order', 'suborder',
  'infraorder', 'parvorder', 'class', 'subclass', 'infraclass', 'superclass',
  'phylum', 'subphylum', 'kingdom', 'domain', 'superkingdom', 'stateofmatter'
]);

// Called when a tree is rendered
function toPlain(md) {
  try {
    return String(md)
      .replace(/<a[^>]*class=\"taxon-link\"[^>]*>(.*?)<\/a>/gi, '$1')
      .replace(/<span[^>]*>.*?<\/span>/gi, '')
      // strip custom color tokens used for markmap/text coloring
      .replace(/\{color:[^}]+\}/gi, '')
      .replace(/\{\/color\}/gi, '')
      // remove picture emojis inserted for photo chips
      .replace(/🖼️/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+$/gm, '');
  } catch (_) { return md; }
}

function renderMarkmap(markdown, username, taxonName, taxonId, plainMarkdown) {
  const displayMd = plainMarkdown || toPlain(markdown);
  document.getElementById("markdownResult").textContent = displayMd;

  // Calculate statistics before adding the tree (if taxonomyStats is available)
  let stats = null;
  try {
    if (window.taxonomyStats && typeof window.taxonomyStats.processMarkdown === 'function') {
      stats = window.taxonomyStats.processMarkdown(markdown);
      console.log(`Calculated statistics for ${username}:`, stats);
    } else {
      console.warn('TaxonomyStats module not available yet - statistics will not be calculated');
    }
  } catch (error) {
    console.error('Error calculating statistics:', error);
  }

  treeManager.addTree(username, taxonName || `Taxon ${taxonId}`, taxonId, markdown);
  showResults();
  // Enable Save Checkpoint now that a build exists
  try { const btn = document.getElementById('saveCheckpointBtn'); if (btn) btn.disabled = false; } catch(_) {}
}

function showLoadingSpinner() {
  const spinnerContainer = document.getElementById("loadingSpinner");
  const loadingText = document.getElementById("loadingText");
  const loadingProgress = document.getElementById("loadingProgress");
  const resultsCard = document.getElementById("resultsCard");
  resultsCard.style.display = "none";
  spinnerContainer.style.display = "flex";
  loadingText.textContent = loadingMessages[Math.floor(Math.random() * loadingMessages.length)];
  if (loadingProgress) loadingProgress.textContent = "";
  return setInterval(() => {
    loadingText.textContent = loadingMessages[Math.floor(Math.random() * loadingMessages.length)];
  }, 4000);
}

function hideLoadingSpinner() {
  document.getElementById("loadingSpinner").style.display = "none";
  const loadingProgress = document.getElementById("loadingProgress");
  if (loadingProgress) loadingProgress.textContent = "";
}

function updateLoadingProgress(text) {
  const loadingProgress = document.getElementById("loadingProgress");
  if (loadingProgress) loadingProgress.textContent = text;
}

function showResults() {
  const resultsCard = document.getElementById("resultsCard");
  resultsCard.style.display = "block";
  resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showError(message) {
  hideLoadingSpinner();
  hideCompareLoadingSpinner();
  const errorDiv = document.createElement("div");
  errorDiv.className = "alert alert-danger mt-3";
  errorDiv.textContent = message;
  
  // Try to find the most appropriate form to attach the error to
  const treeForm = document.getElementById("treeForm");
  const compareForm = document.getElementById("compareForm");
  const targetForm = compareForm && document.activeElement && compareForm.contains(document.activeElement) ? compareForm : treeForm;
  
  targetForm.parentNode.insertBefore(errorDiv, targetForm.nextSibling);
  setTimeout(() => { errorDiv.remove(); }, 10000);
}

// Make showError globally available
window.showError = showError;

function hideCompareLoadingSpinner() {
  const spinner = document.getElementById("compareLoadingSpinner");
  if (spinner) {
    spinner.style.display = "none";
  }
}

// Add search cache for faster results
const searchCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Function to search taxa - Make it globally available
async function searchTaxa(query) {
  if (!query || query.length < 2) return [];
  
  // Check cache first
  const cacheKey = query.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.results;
  }
  
  // Fetch from API base (Cloudflare Worker)
  try {
    const response = await fetch(`${searchTaxaUrl}?q=${encodeURIComponent(query)}&limit=10`, {
      headers: {
        ...getAuthHeaders()
      }
    });
    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }
    const data = await response.json();
    const results = data.results || [];
    
    // Cache results
    searchCache.set(cacheKey, {
      results: results,
      timestamp: Date.now()
    });
    
    return results;
  } catch (error) {
    console.error("Error with search API:", error);
    return [];
  }
}

// Make searchTaxa globally available
window.searchTaxa = searchTaxa;

// Make searchTaxaUrl globally available
window.searchTaxaUrl = searchTaxaUrl;

function showAutocompleteResults(results) {
  const autocompleteContainer = document.getElementById("autocompleteResults");
  autocompleteContainer.innerHTML = "";
  if (results.length === 0) {
    autocompleteContainer.style.display = "none";
    return;
  }
  for (const result of results) {
    const item = document.createElement("div");
    item.className = "autocomplete-item";
    item.dataset.taxonId = result.taxon_id || result.id;
    const taxonId = result.taxon_id || result.id;
    const displayName = result.common_name || result.name;
    let displayHtml = `<strong>${displayName}</strong>`;
    if (result.common_name) {
      displayHtml += ` <span class="scientific-name">${result.name}</span>`;
    }
    displayHtml += ` <span class="taxon-id">${result.rank} (ID: ${taxonId})</span>`;
    item.innerHTML = displayHtml;
    item.addEventListener("click", () => {
      document.getElementById("taxonName").value = displayName;
      document.getElementById("selectedTaxonId").value = taxonId;
      autocompleteContainer.style.display = "none";
    });
    autocompleteContainer.appendChild(item);
  }
  autocompleteContainer.style.display = "block";
}

// Helper function to read observed dates
function readObservedDates() {
  const d1 = (document.getElementById('obsStart')?.value || '').trim();
  const d2 = (document.getElementById('obsEnd')?.value   || '').trim();
  return { d1, d2 };
}

// Add this to script.js (ensure it's placed after the definitions of edgeFunctionUrl, etc.)
document.getElementById("treeForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  // Retrieve form values
  const username = document.getElementById("username").value.trim();
  let taxonId, taxonName = "";

  // Check which search option is active
  if (document.getElementById("searchName").checked) {
    taxonId = document.getElementById("selectedTaxonId").value;
    taxonName = document.getElementById("taxonName").value.trim();
  } else {
    taxonId = document.getElementById("taxonId").value;
    taxonName = `Taxon ${taxonId}`;
  }

  // Show loading spinner and get an interval handle for changing messages
  const messageInterval = showLoadingSpinner();

  try {
    // Get date filters
    const { d1, d2 } = readObservedDates();
    
    // Public mode: fetch in browser → send IDs to Worker; else use /build-taxonomy
    let result;
    if (PUBLIC_MODE) {
      const taxonIds = await fetchUserSpeciesViaCounts({
        username,
        taxonId,
        d1,
        d2,
        onProgress: ({ page, species, phase }) => {
          if (phase === 'fetching') {
            updateLoadingProgress(`Fetching page ${page}... (${species} species found)`);
          } else if (phase === 'complete') {
            updateLoadingProgress(`Building tree with ${species} species...`);
          }
        }
      });
      const rankCounts = {}; // (optional: compute client-side if desired)
      const highWatermarkUpdatedAt = null;
      const r2 = await fetch(`${API_BASE}/tree-from-species`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send username and date filters so Worker can render photo chips and filter
        body: JSON.stringify({ speciesTaxonIds: taxonIds, baseTaxonId: taxonId, username, d1, d2 })
      });
      const j2 = await r2.json();
      if (!r2.ok) throw new Error(j2?.error || 'tree-from-species failed');
      result = { markdown: j2.markdown, plainMarkdown: j2.plainMarkdown, speciesTaxonIds: taxonIds, rankCounts, highWatermarkUpdatedAt };
    } else {
      const params = new URLSearchParams({ username, taxonId: taxonId.toString() });
      if (d1) params.set('d1', d1);
      if (d2) params.set('d2', d2);
      
      const response = await fetch(`${edgeFunctionUrl}?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ includePhotos: true })
      });
      result = await response.json();
      if (!response.ok) throw new Error(result?.error || 'build-taxonomy failed');
    }

    clearInterval(messageInterval);
    hideLoadingSpinner();

    if (result.error) {
      showError("Error: " + result.error);
      return;
    }

    const markdown = result.markdown;
    console.debug('[EXPLORE] API payload summary:', { ok: !!markdown, len: (markdown||'').length, head: String(markdown||'').slice(0, 220) });
    const plainMarkdown = result.plainMarkdown;
    if (!markdown || markdown.trim() === "" || markdown.includes("No observations found")) {
      showError("No observations found for the user under the selected taxon.");
      return;
    }

    // Use the global treeManager instance to render the tree
    renderMarkmap(markdown, username, taxonName, taxonId, plainMarkdown);

    // Expose last build payload for Save Checkpoint
    window.__lastBuild = {
      username,
      taxonId: Number(taxonId),
      taxonName,
      speciesTaxonIds: result.speciesTaxonIds || [],
      rankCounts: result.rankCounts || {},
      highWatermarkUpdatedAt: result.highWatermarkUpdatedAt || null
    };

    // Prefill local cache for first-obs photos to speed up 🖼️ chips
    if (result.firstPhotos && typeof result.firstPhotos === 'object') {
      try {
        const raw = localStorage.getItem('firstObsCache');
        const obj = raw ? JSON.parse(raw) : {};
        for (const [sid, payload] of Object.entries(result.firstPhotos)) {
          obj[`${username}:${sid}`] = payload;
        }
        const keys = Object.keys(obj);
        if (keys.length > 500) {
          const drop = keys.length - 500;
          for (let i = 0; i < drop; i++) delete obj[keys[i]];
        }
        localStorage.setItem('firstObsCache', JSON.stringify(obj));
      } catch {}
    }
  } catch (err) {
    clearInterval(messageInterval);
    hideLoadingSpinner();
    showError("Error building tree: " + err.message);
  }
});


// Radio button toggle for search type
document.getElementById("searchName").addEventListener("change", function() {
  document.getElementById("nameSearch").classList.add("active");
  document.getElementById("idSearch").classList.remove("active");
});
document.getElementById("searchId").addEventListener("change", function() {
  document.getElementById("nameSearch").classList.remove("active");
  document.getElementById("idSearch").classList.add("active");
});

const taxonNameInput = document.getElementById("taxonName");
const autocompleteResults = document.getElementById("autocompleteResults");
let debounceTimeout = null;
taxonNameInput.addEventListener("input", (e) => {
  const query = e.target.value.trim();
  if (debounceTimeout) clearTimeout(debounceTimeout);
  if (query.length < 2) {
    autocompleteResults.style.display = "none";
    return;
  }
  debounceTimeout = setTimeout(() => {
    searchTaxa(query).then(showAutocompleteResults);
  }, 150);
});