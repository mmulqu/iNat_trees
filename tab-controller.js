// tab-controller.js

function showTab(tabId) {
  // Hide all main panes
  document.querySelectorAll('.main-pane').forEach(tab => {
    tab.style.display = 'none';
    tab.classList.remove('show', 'active');
  });
  // Deactivate nav links
  document.querySelectorAll('.navbar .nav-link').forEach(link => link.classList.remove('active'));

  // Show selected pane
  const selectedTab = document.getElementById(tabId);
  if (selectedTab) {
    selectedTab.style.display = 'block';
    selectedTab.classList.add('show', 'active');
  }
  // Activate matching nav link
  const selectedNavLink = document.getElementById(tabId + '-tab');
  if (selectedNavLink) selectedNavLink.classList.add('active');

  // Flag current mode for CSS gates
  document.body.classList.toggle('in-home',        tabId === 'home');
  document.body.classList.toggle('in-pvp',         tabId === 'pvpPane');
  document.body.classList.toggle('in-checkpoints', tabId === 'checkpointsPane');

  // Explicitly toggle cards so inline styles are correct, not just CSS gates
  const hasExploreTrees = !!(window.treeManager?.trees?.length);
  const hasPvpTrees     = !!(window.pvpManager?.trees?.length);

  const exploreCard = document.getElementById('resultsCard');
  const pvpCard     = document.getElementById('pvpResultsCard');

  if (tabId === 'pvpPane') {
    if (pvpCard)     pvpCard.style.display     = hasPvpTrees ? 'block' : 'none';
    if (exploreCard) exploreCard.style.display = 'none';
    // Render PvP
    if (window.pvpManager?.reRenderActiveTab) setTimeout(() => window.pvpManager.reRenderActiveTab(), 80);
  } else {
    if (exploreCard) exploreCard.style.display = hasExploreTrees ? 'block' : 'none';
    if (pvpCard)     pvpCard.style.display     = 'none';
    // Render Explore
    if (window.treeManager?.reRenderActiveTab) setTimeout(() => window.treeManager.reRenderActiveTab(), 80);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  showTab('home'); // sets .in-home on first load
});