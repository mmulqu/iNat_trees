// compare-users.js
// (Note: TreeManager is defined only in tree-manager.js.)

// Helper function to read observed dates for compare
function readObservedDatesCompare() {
  const d1 = (document.getElementById('obsStartCompare')?.value || '').trim();
  const d2 = (document.getElementById('obsEndCompare')?.value   || '').trim();
  return { d1, d2 };
}

// --- Public-mode browser fetch helper ---
async function fetchUserObsMinimal({ username, taxonId, placeId, d1, d2, maxPages=100, onProgress }) {
  const per=200; let page=1, all=[];
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  while (page<=maxPages) {
    const u = new URL('https://api.inaturalist.org/v1/observations');
    u.searchParams.set('user_login', username);
    u.searchParams.set('taxon_id', String(taxonId));
    if (placeId) u.searchParams.set('place_id', String(placeId));
    if (d1) u.searchParams.set('d1', d1);
    if (d2) u.searchParams.set('d2', d2);
    u.searchParams.set('include','taxon');
    u.searchParams.set('quality_grade','any');
    u.searchParams.set('verifiable','any');
    u.searchParams.set('per_page', String(per));
    u.searchParams.set('page', String(page));

    // Report progress
    if (onProgress) onProgress({ page, count: all.length });

    const r = await fetch(u);
    if (r.status===429 || (r.status>=500 && r.status<600)) { await sleep(1200 + Math.random()*600); continue; }
    const j = await r.json().catch(()=>({results:[]}));
    const batch = j.results || [];
    all.push(...batch);
    if (batch.length < per) break;
    page++; await sleep(650 + Math.random()*200);
  }
  const ids = [...new Set(all.map(o=>o?.taxon?.id).filter(Boolean))];
  return { taxonIds: ids };
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

function showCompareLoadingSpinner() {
  const spinnerContainer = document.getElementById("compareLoadingSpinner");
  const loadingText = document.getElementById("compareLoadingText");
  const loadingProgress = document.getElementById("compareLoadingProgress");
  const resultsCard = document.getElementById("resultsCard");
  resultsCard.style.display = "none";
  spinnerContainer.style.display = "flex";
  if (loadingProgress) loadingProgress.textContent = "";
  const battleMessages = [
    "Initializing the taxonomic battlefield...",
    "Pitting naturalists against each other...",
    "Measuring biodiversity prowess...",
    "Calculating phylogenetic victories...",
    "Comparing observation territories...",
    "Tallying species counts...",
    "Mapping taxonomic conquests...",
    "Determining the phylogenetic champion...",
    "Evaluating naturalist rivalry...",
    "Loading the observation arena...",
    "Processing competitive biodiversity...",
    "Nature nerds battling it out...",
    "Letting the species decide the winner...",
    "Observations at dawn: 10 paces...",
    "Analyzing who's the better taxonomist..."
  ];
  document.getElementById("compareLoadingText").textContent =
    battleMessages[Math.floor(Math.random() * battleMessages.length)];
  return setInterval(() => {
    document.getElementById("compareLoadingText").textContent =
      battleMessages[Math.floor(Math.random() * battleMessages.length)];
  }, 4000);
}

function hideCompareLoadingSpinner() {
  document.getElementById("compareLoadingSpinner").style.display = "none";
  const loadingProgress = document.getElementById("compareLoadingProgress");
  if (loadingProgress) loadingProgress.textContent = "";
}

function updateCompareLoadingProgress(text) {
  const loadingProgress = document.getElementById("compareLoadingProgress");
  if (loadingProgress) loadingProgress.textContent = text;
}

import { getAuthHeaders } from './auth.js';

const API_BASE = window.CF_API_BASE;
const PUBLIC_MODE = !!window.PUBLIC_MODE;
if (!API_BASE) {
  console.error('CF_API_BASE is not set. Set window.CF_API_BASE to your Worker URL.');
}
const compareUsersUrl = `${API_BASE}/compare-taxa`;

document.addEventListener('DOMContentLoaded', function() {
  // Clean up any leftover swap users button
  document.getElementById('swapUsersBtn')?.remove();
  
  document.getElementById("compareSearchName").addEventListener("change", function() {
    document.getElementById("compareNameSearch").classList.add("active");
    document.getElementById("compareIdSearch").classList.remove("active");
  });

  document.getElementById("compareSearchId").addEventListener("change", function() {
    document.getElementById("compareNameSearch").classList.remove("active");
    document.getElementById("compareIdSearch").classList.add("active");
  });

  const compareTaxonNameInput = document.getElementById("compareTaxonName");
  const compareAutocompleteResults = document.getElementById("compareAutocompleteResults");
  let compareDebounceTimeout = null;
  compareTaxonNameInput.addEventListener("input", (e) => {
    const query = e.target.value.trim();
    document.getElementById("compareSelectedTaxonId").value = "";
    if (compareDebounceTimeout) clearTimeout(compareDebounceTimeout);
    if (query.length < 2) {
      compareAutocompleteResults.style.display = "none";
      return;
    }
    compareDebounceTimeout = setTimeout(async () => {
      if (typeof window.searchTaxa === 'function') {
        const results = await window.searchTaxa(query);
        showCompareAutocompleteResults(results);
      } else if (typeof searchTaxa === 'function') {
        const results = await searchTaxa(query);
        showCompareAutocompleteResults(results);
      } else {
        console.error('searchTaxa function not available yet - retrying in 100ms');
        setTimeout(async () => {
          if (typeof window.searchTaxa === 'function') {
            const results = await window.searchTaxa(query);
            showCompareAutocompleteResults(results);
          }
        }, 100);
        compareAutocompleteResults.style.display = "none";
      }
    }, 150);
  });

  function showCompareAutocompleteResults(results) {
    const autocompleteContainer = document.getElementById("compareAutocompleteResults");
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
        document.getElementById("compareTaxonName").value = displayName;
        document.getElementById("compareSelectedTaxonId").value = taxonId;
        autocompleteContainer.style.display = "none";
      });
      autocompleteContainer.appendChild(item);
    }
    autocompleteContainer.style.display = "block";
  }

  document.addEventListener("click", (e) => {
    if (!compareTaxonNameInput.contains(e.target) && !compareAutocompleteResults.contains(e.target)) {
      compareAutocompleteResults.style.display = "none";
    }
  });

  const compareForm = document.getElementById("compareForm");
  if (compareForm) {
    compareForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const existingErrors = document.querySelectorAll(".alert-danger");
      existingErrors.forEach(error => error.remove());
      const username1 = document.getElementById("username1").value.trim();
      const username2 = document.getElementById("username2").value.trim();
      let taxonId;
      let taxonName = "";
      if (!username1 || !username2) {
        showError("Both usernames are required.");
        return;
      }
      const isNameSearch = document.getElementById("compareSearchName").checked;
      if (isNameSearch) {
        taxonId = document.getElementById("compareSelectedTaxonId").value;
        taxonName = document.getElementById("compareTaxonName").value.trim();
        if (!taxonId) {
          if (!taxonName) {
            showError("Please enter a taxon name or select one from the suggestions.");
            return;
          }
          const messageInterval = showCompareLoadingSpinner();
          try {
            const results = await (window.searchTaxa || searchTaxa)(taxonName);
            if (results.length === 0) {
              clearInterval(messageInterval);
              hideCompareLoadingSpinner();
              showError(`No matching taxa found for "${taxonName}". Please try a different name or use the suggestions.`);
              return;
            }
            taxonId = results[0].taxon_id || results[0].id;
            console.log(`Using taxon ID ${taxonId} (${results[0].name}) for comparison`);
          } catch (err) {
            clearInterval(messageInterval);
            hideCompareLoadingSpinner();
            showError("Error searching for taxon: " + err.message);
            return;
          }
        }
      } else {
        taxonId = parseInt(document.getElementById("compareTaxonId").value);
        taxonName = `Taxon ${taxonId}`;
        if (!taxonId) {
          showError("Please enter a valid taxon ID.");
          return;
        }
      }
      const messageInterval = showCompareLoadingSpinner();
      try {
        // Get date filters
        const { d1, d2 } = readObservedDatesCompare();
        
        let result;
        if (PUBLIC_MODE) {
          // Track progress for both users
          let u1Progress = { page: 0, count: 0 };
          let u2Progress = { page: 0, count: 0 };
          const updateProgress = () => {
            updateCompareLoadingProgress(
              `${username1}: page ${u1Progress.page} (${u1Progress.count} obs) | ${username2}: page ${u2Progress.page} (${u2Progress.count} obs)`
            );
          };

          const [{ taxonIds: u1 }, { taxonIds: u2 }] = await Promise.all([
            fetchUserObsMinimal({
              username: username1, taxonId, d1, d2,
              onProgress: (p) => { u1Progress = p; updateProgress(); }
            }),
            fetchUserObsMinimal({
              username: username2, taxonId, d1, d2,
              onProgress: (p) => { u2Progress = p; updateProgress(); }
            })
          ]);

          updateCompareLoadingProgress(`Building comparison tree...`);
          const r2 = await fetch(`${API_BASE}/compare-from-species`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username1, username2, baseTaxonId: taxonId,
              user1SpeciesIds: u1, user2SpeciesIds: u2, d1, d2
            })
          });
          result = await r2.json();
          if (!r2.ok) throw new Error(result?.error || 'compare-from-species failed');
        } else {
          const params = new URLSearchParams({ username1, username2, taxonId: taxonId.toString() });
          if (d1) params.set('d1', d1);
          if (d2) params.set('d2', d2);
          
          const response = await fetch(`${compareUsersUrl}?${params.toString()}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getAuthHeaders()
            },
            body: JSON.stringify({})
          });
          result = await response.json();
          if (!response.ok) {
            const authInfo = result && result.auth ? ` (auth received: ${result.auth.received}, usableJWT: ${result.auth.usableJWT})` : '';
            throw new Error(`${result.error || 'Request failed'}${authInfo}`);
          }
        }
        clearInterval(messageInterval);
        hideCompareLoadingSpinner();
        if (result.error) {
          showError("Error: " + result.error);
          return;
        }
        const markdown = result.markdown;
        const plainMarkdown = result.plainMarkdown;
        // If taxonName is still "Taxon 12345" (ID mode), resolve it
        if (!taxonName || /^Taxon \d+$/.test(taxonName)) {
          try { taxonName = await resolveTaxonTitle(taxonId); } catch {}
        }
        if (!markdown || markdown.trim() === "" || markdown.includes("No observations found")) {
          showError("No observations found for at least one of the users under the selected taxon.");
          return;
        }
        window.lastComparePlainMarkdown = result.plainMarkdown;
        renderComparison(markdown, username1, username2, taxonName, taxonId);
      } catch (err) {
        clearInterval(messageInterval);
        hideCompareLoadingSpinner();
        showError("Error comparing users: " + err.message);
      }
    });
  }
});

// Update the rendering function for comparison in compare-users.js
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
  } catch(_) { return md; }
}

function renderComparison(markdown, username1, username2, taxonName, taxonId, plainMarkdown) {
  document.getElementById("pvpMarkdownResult").textContent = (window.lastComparePlainMarkdown || markdown);

  // Calculate statistics before adding the tree
  let stats = null;
  try {
    if (window.taxonomyStats && typeof window.taxonomyStats.processComparisonMarkdown === 'function') {
      stats = window.taxonomyStats.processComparisonMarkdown(markdown);
    }
  } catch (error) {
    console.error('Error calculating comparison statistics:', error);
  }

  // Add the tree
  const treeId = window.pvpManager.addComparisonTree(username1, username2, taxonName, taxonId, markdown, stats);
  showResults();

  // Force render the tree immediately since we're on the Compare tab
  setTimeout(() => {
    const tree = window.pvpManager.trees.find(t => t.id === treeId);
    if (tree && tree.isComparison) {
      console.log("Force rendering comparison tree immediately", treeId);

      // Make sure the tab is active first
      const tabTrigger = document.getElementById(`${treeId}-tab`);
      const tabContent = document.getElementById(`${treeId}-content`);

      // Resolve taxon name if missing or generic
      const titleSpan = tabTrigger?.querySelector('.tab-title');
      if (titleSpan && /^Taxon \d+$/.test(titleSpan.textContent)) {
        resolveTaxonTitle(taxonId).then(title => {
          titleSpan.textContent = title;
          // also stash on your comparison tree object if you keep one
          tree.taxonName = title;
        });
      }

      if (tabTrigger && tabContent) {
        // Activate the tab
        tabTrigger.classList.add('active');
        tabTrigger.setAttribute('aria-selected', 'true');
        tabContent.classList.add('show', 'active');

        // Deactivate other tabs
        document.querySelectorAll('#pvpTreeTabs .nav-link.active').forEach(tab => {
          if (tab.id !== `${treeId}-tab`) {
            tab.classList.remove('active');
            tab.setAttribute('aria-selected', 'false');
          }
        });
        document.querySelectorAll('#pvpTreeTabContent .tab-pane.active').forEach(pane => {
          if (pane.id !== `${treeId}-content`) {
            pane.classList.remove('show', 'active');
          }
        });

        // Now render the tree
        window.pvpManager.renderComparisonTree(tree);
      }
    }
  }, 300);

  // Start the battle animation
  console.log("Starting battle animation for", username1, "vs", username2, "with treeId", treeId);
  if (window.battleAnimator && typeof window.battleAnimator.startBattleCountdown === 'function') {
    window.battleAnimator.startBattleCountdown(username1, username2, function() {
      console.log("Animation complete, now animating tree", treeId);
      window.battleAnimator.animateTree(treeId);
    });
  } else {
    console.error("Battle animator not available:", window.battleAnimator);
  }
}

function showError(message) {
  hideCompareLoadingSpinner();
  const errorDiv = document.createElement("div");
  errorDiv.className = "alert alert-danger mt-3";
  errorDiv.textContent = message;
  const form = document.getElementById("compareForm");
  form.parentNode.insertBefore(errorDiv, form.nextSibling);
  setTimeout(() => { errorDiv.remove(); }, 10000);
}

function showResults() {
  const pvpCard = document.getElementById("pvpResultsCard");
  if (pvpCard) pvpCard.style.display = "block";
  pvpCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}