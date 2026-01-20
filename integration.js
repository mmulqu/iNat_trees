// integration.js
document.addEventListener('DOMContentLoaded', function() {
  initializeComparisonFeature();
});

function initializeComparisonFeature() {
  initCompareAutocomplete();
  const compareSearchName = document.getElementById("compareSearchName");
  const compareSearchId = document.getElementById("compareSearchId");
  if (compareSearchName) {
    compareSearchName.addEventListener("change", function() {
      document.getElementById("compareNameSearch").classList.add("active");
      document.getElementById("compareIdSearch").classList.remove("active");
    });
  }
  if (compareSearchId) {
    compareSearchId.addEventListener("change", function() {
      document.getElementById("compareNameSearch").classList.remove("active");
      document.getElementById("compareIdSearch").classList.add("active");
    });
  }
}

function initCompareAutocomplete() {
  const compareTaxonNameInput = document.getElementById("compareTaxonName");
  const compareAutocompleteResults = document.getElementById("compareAutocompleteResults");
  if (!compareTaxonNameInput || !compareAutocompleteResults) return;
  let compareDebounceTimeout = null;
  compareTaxonNameInput.addEventListener("input", function(e) {
    const query = e.target.value.trim();
    const selectedIdInput = document.getElementById("compareSelectedTaxonId");
    if (selectedIdInput) {
      selectedIdInput.value = "";
    }
    if (compareDebounceTimeout) clearTimeout(compareDebounceTimeout);
    if (query.length < 2) {
      compareAutocompleteResults.style.display = "none";
      return;
    }
    compareDebounceTimeout = setTimeout(function() {
      if (typeof searchTaxa === 'function') {
        searchTaxa(query).then(function(results) {
          showCompareAutocompleteResults(results);
        });
      }
    }, 150);
  });
  document.addEventListener("click", function(e) {
    if (!compareTaxonNameInput.contains(e.target) && !compareAutocompleteResults.contains(e.target)) {
      compareAutocompleteResults.style.display = "none";
    }
  });
}

function showCompareAutocompleteResults(results) {
  const autocompleteContainer = document.getElementById("compareAutocompleteResults");
  if (!autocompleteContainer) return;
  autocompleteContainer.innerHTML = "";
  if (!results || results.length === 0) {
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
    item.addEventListener("click", function() {
      document.getElementById("compareTaxonName").value = displayName;
      document.getElementById("compareSelectedTaxonId").value = taxonId;
      autocompleteContainer.style.display = "none";
      const taxonIdField = document.getElementById("compareTaxonId");
      if (taxonIdField && document.getElementById("compareSearchId").checked) {
        taxonIdField.value = taxonId;
      }
    });
    autocompleteContainer.appendChild(item);
  }
  autocompleteContainer.style.display = "block";
}

function handleComparisonSubmit(e) {
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
        searchTaxa(taxonName).then(function(results) {
          if (!results || results.length === 0) {
            clearInterval(messageInterval);
            hideCompareLoadingSpinner();
            showError(`No matching taxa found for "${taxonName}". Please try a different name or use the suggestions.`);
            return;
          }
          taxonId = results[0].taxon_id || results[0].id;
          console.log(`Using taxon ID ${taxonId} (${results[0].name}) for comparison`);
          performComparison(username1, username2, taxonId, taxonName, messageInterval);
        }).catch(function(err) {
          clearInterval(messageInterval);
          hideCompareLoadingSpinner();
          showError("Error searching for taxon: " + err.message);
        });
      } catch (err) {
        clearInterval(messageInterval);
        hideCompareLoadingSpinner();
        showError("Error: " + err.message);
      }
    } else {
      const messageInterval = showCompareLoadingSpinner();
      performComparison(username1, username2, taxonId, taxonName, messageInterval);
    }
  } else {
    taxonId = parseInt(document.getElementById("compareTaxonId").value);
    taxonName = `Taxon ${taxonId}`;
    if (!taxonId) {
      showError("Please enter a valid taxon ID.");
      return;
    }
    const messageInterval = showCompareLoadingSpinner();
    performComparison(username1, username2, taxonId, taxonName, messageInterval);
  }
}

function performComparison(username1, username2, taxonId, taxonName, messageInterval) {
  const API_BASE = window.CF_API_BASE;
  const compareUsersUrl = `${API_BASE}/compare-taxa`;
  fetch(compareUsersUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ 
      username1, 
      username2, 
      taxonId 
    })
  }).then(function(response) {
    return response.json();
  }).then(function(result) {
    clearInterval(messageInterval);
    hideCompareLoadingSpinner();
    if (result.error) {
      showError("Error: " + result.error);
      return;
    }
    const markdown = result.markdown;
    if (!markdown || markdown.trim() === "" || markdown.includes("No observations found")) {
      showError("No observations found for at least one of the users under the selected taxon.");
      return;
    }
    renderComparison(markdown, username1, username2, taxonName, taxonId);
  }).catch(function(err) {
    clearInterval(messageInterval);
    hideCompareLoadingSpinner();
    showError("Error comparing users: " + err.message);
  });
}
