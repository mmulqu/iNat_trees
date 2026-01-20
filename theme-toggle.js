(function() {
  const root = document.body;
  const btn = document.getElementById('themeToggle');
  const icon = document.getElementById('themeIcon');
  const key = 'inat_theme_v1';

  function apply(theme) {
    if (theme === 'dark') {
      root.classList.add('dark-theme');
      if (icon) icon.className = 'bi bi-sun';
    } else {
      root.classList.remove('dark-theme');
      if (icon) icon.className = 'bi bi-moon';
    }
    
    // Re-render visible comparison trees after theme change
    if (window.treeManager) {
      setTimeout(() => {
        window.treeManager.trees.forEach(tree => {
          if (tree.isComparison) {
            const svg = document.getElementById(`${tree.id}-svg`);
            const tabContent = document.getElementById(`${tree.id}-content`);
            // Check if this tree is currently visible
            if (svg && tabContent && tabContent.classList.contains('active')) {
              window.treeManager.renderComparisonTree(tree);
            }
          }
        });
      }, 100);
    }
  }

  // Load saved theme or prefer system
  let saved = null;
  try { saved = localStorage.getItem(key); } catch(_) {}
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  apply(saved || (prefersDark ? 'dark' : 'light'));

  if (btn) {
    btn.addEventListener('click', function() {
      const isDark = root.classList.contains('dark-theme');
      const next = isDark ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(key, next); } catch(_) {}
    });
  }
})();