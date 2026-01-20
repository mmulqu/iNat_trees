// taxon-autocomplete.js
// (Note: The searchTaxaUrl is now defined in script.js.)

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

function initTaxonAutocomplete() {
  const taxonIdInput = document.getElementById('taxonId');
  const taxonNameInput = document.getElementById('taxonName');
  const autocompleteResultsDiv = document.getElementById('autocompleteResults');
  const selectedTaxonIdInput = document.getElementById('selectedTaxonId');

  const searchTaxaInternal = async (query) => {
    if (!query || query.length < 2) {
      autocompleteResultsDiv.innerHTML = '';
      autocompleteResultsDiv.style.display = 'none';
      return;
    }
    try {
      const results = await searchTaxa(query);
      autocompleteResultsDiv.innerHTML = '';
      if (results && results.length > 0) {
        autocompleteResultsDiv.style.display = 'block';
        results.forEach(taxon => {
          const item = document.createElement('div');
          item.className = 'autocomplete-item';
          let displayHtml = '';
          if (taxon.common_name) {
            displayHtml += `<strong>${taxon.common_name}</strong>`;
          }
          if (taxon.common_name) {
            displayHtml += ` <span class="scientific-name">${taxon.name}</span>`;
          } else {
            displayHtml += `<span class="scientific-name"><strong>${taxon.name}</strong></span>`;
          }
          if (taxon.rank) {
            displayHtml += ` <small>[${taxon.rank}]</small>`;
          }
          displayHtml += `<span class="taxon-id">ID: ${taxon.id || taxon.taxon_id}</span>`;
          item.innerHTML = displayHtml;
          item.addEventListener('click', () => {
            selectedTaxonIdInput.value = taxon.id || taxon.taxon_id;
            taxonNameInput.value = taxon.common_name ? `${taxon.common_name} (${taxon.name})` : taxon.name;
            if (document.getElementById('idSearch')) {
              taxonIdInput.value = taxon.id || taxon.taxon_id;
            }
            autocompleteResultsDiv.style.display = 'none';
            taxonNameInput.classList.add('is-valid');
            setTimeout(() => taxonNameInput.classList.remove('is-valid'), 2000);
          });
          autocompleteResultsDiv.appendChild(item);
        });
      } else {
        const noResults = document.createElement('div');
        noResults.className = 'autocomplete-item';
        noResults.textContent = 'No taxa found for your search';
        autocompleteResultsDiv.appendChild(noResults);
        autocompleteResultsDiv.style.display = 'block';
      }
    } catch (error) {
      console.error('Error searching taxa:', error);
      autocompleteResultsDiv.innerHTML = '';
      const errorItem = document.createElement('div');
      errorItem.className = 'autocomplete-item';
      errorItem.textContent = 'Error searching taxa. Please try again.';
      autocompleteResultsDiv.appendChild(errorItem);
      autocompleteResultsDiv.style.display = 'block';
    }
  };

  const debouncedSearch = debounce(searchTaxaInternal, 150);
  if (taxonNameInput) {
    taxonNameInput.addEventListener('input', (e) => {
      const query = e.target.value.trim();
      debouncedSearch(query);
    });
    document.addEventListener('click', (e) => {
      if (!taxonNameInput.contains(e.target) && !autocompleteResultsDiv.contains(e.target)) {
        autocompleteResultsDiv.style.display = 'none';
      }
    });
    taxonNameInput.addEventListener('focus', (e) => {
      const query = e.target.value.trim();
      if (query.length >= 2) {
        debouncedSearch(query);
      }
    });
  }
}
