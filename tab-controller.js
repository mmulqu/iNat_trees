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
  document.body.classList.toggle('in-checklist',   tabId === 'checklistPane');

  // Get all result cards
  const exploreCard   = document.getElementById('resultsCard');
  const pvpCard       = document.getElementById('pvpResultsCard');
  const checklistCard = document.getElementById('clResultsCard');

  // Check if each tab has trees
  const hasExploreTrees   = !!(window.treeManager?.trees?.length);
  const hasPvpTrees       = !!(window.pvpManager?.trees?.length);
  const hasChecklistTrees = !!(document.querySelectorAll('#clTreeTabContent .tab-pane').length);

  // Hide all cards first
  if (exploreCard)   exploreCard.style.display   = 'none';
  if (pvpCard)       pvpCard.style.display       = 'none';
  if (checklistCard) checklistCard.style.display = 'none';

  // Show only the relevant card for the active tab
  if (tabId === 'home') {
    if (exploreCard) exploreCard.style.display = hasExploreTrees ? 'block' : 'none';
    if (window.treeManager?.reRenderActiveTab) setTimeout(() => window.treeManager.reRenderActiveTab(), 80);
  } else if (tabId === 'pvpPane') {
    if (pvpCard) pvpCard.style.display = hasPvpTrees ? 'block' : 'none';
    if (window.pvpManager?.reRenderActiveTab) setTimeout(() => window.pvpManager.reRenderActiveTab(), 80);
  } else if (tabId === 'checklistPane') {
    if (checklistCard) checklistCard.style.display = hasChecklistTrees ? 'block' : 'none';
  }
}

document.addEventListener('DOMContentLoaded', function() {
  showTab('home'); // sets .in-home on first load
});