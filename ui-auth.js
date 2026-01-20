
import { fetchCurrentUser, startLogin } from './auth.js';

function renderAuthUI() {
  const btn = document.getElementById('inatLogin');
  const logoutBtn = document.getElementById('inatLogout');
  if (!btn) return;
  const user = localStorage.getItem('inat_username');
  if (user) {
    btn.classList.remove('btn-success');
    btn.classList.add('btn-outline-secondary');
    btn.classList.add('inat-favicon');
    btn.innerHTML = `<i class="bi bi-check-circle me-1"></i> Connected as <strong id="inatUserLabel"></strong>`;
    const label = document.getElementById('inatUserLabel');
    if (label) label.textContent = user;
    btn.disabled = true;
    if (logoutBtn) {
      logoutBtn.classList.remove('d-none');
      logoutBtn.onclick = () => {
        localStorage.removeItem('inat_token');
        localStorage.removeItem('inat_username');
        localStorage.removeItem('pkce_state');
        localStorage.removeItem('pkce_verifier');
        location.reload();
      };
    }
  } else {
    btn.classList.add('btn-success');
    btn.classList.remove('btn-outline-secondary');
    btn.classList.add('inat-favicon');
    btn.innerHTML = `Connect my iNaturalist account`;
    btn.disabled = false;
    btn.onclick = startLogin;
    if (logoutBtn) logoutBtn.classList.add('d-none');
  }
}

async function initAuthUI() {
  if (!localStorage.getItem('inat_username') && localStorage.getItem('inat_token')) {
    await fetchCurrentUser();
  }
  renderAuthUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAuthUI);
} else {
  initAuthUI();
}

window.addEventListener('storage', (e) => {
  if (e.key === 'inat_token' || e.key === 'inat_username') renderAuthUI();
});
