// auth.js
// One-time PKCE login → store iNat API JWT; reuse for all app calls.

const INAT_CLIENT_ID = "kNg0gso6U_16O7tkEJotSnmtcNE88dd_Xs-zb5SS8Pw";
const ORIGIN = window.location.origin;
const REDIRECT_URI = `${ORIGIN}/auth/callback`;

const AUTHZ_URL = "https://www.inaturalist.org/oauth/authorize";
const TOKEN_URL = "https://www.inaturalist.org/oauth/token";
const API_TOKEN_URL = "https://www.inaturalist.org/users/api_token"; // returns JWT (CORS OK)
const API_ME_URL = "https://api.inaturalist.org/v1/users/me";        // CORS OK

// ===== Helpers
function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");
}
async function sha256(s) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}
function randHex(len=32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(b => b.toString(16).padStart(2,"0")).join("");
}

// ===== Public API used elsewhere
export function getAuthHeaders() {
  const t = localStorage.getItem("inat_token"); // we store the JWT here
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function fetchCurrentUser() {
  const t = localStorage.getItem("inat_token");
  if (!t) return null;
  try {
    const r = await fetch(API_ME_URL, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    const j = await r.json();
    const login = j?.results?.[0]?.login || null;
    if (login) localStorage.setItem("inat_username", login);
    return login ? { login } : null;
  } catch {
    return null;
  }
}

export function signOut() {
  localStorage.removeItem("inat_token");
  localStorage.removeItem("inat_username");
  localStorage.removeItem("pkce_state");
  localStorage.removeItem("pkce_verifier");
}

// ===== PKCE start
export async function startLogin() {
  // clear any stale values
  localStorage.removeItem("inat_token");
  localStorage.removeItem("inat_username");
  localStorage.removeItem("pkce_state");
  localStorage.removeItem("pkce_verifier");

  // create state & code_verifier
  const state = crypto.getRandomValues(new Uint32Array(4)).join("-");
  const verifier = randHex(32);
  const challenge = b64url(await sha256(verifier));

  localStorage.setItem("pkce_state", state);
  localStorage.setItem("pkce_verifier", verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: INAT_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  window.location = `${AUTHZ_URL}?${params.toString()}`;
}

// ===== PKCE callback → access_token → JWT → store → fetch user → redirect home
export async function handleCallback() {
  const qs = new URLSearchParams(location.search);
  const code = qs.get("code");
  const state = qs.get("state");
  if (!code) return; // not on the callback page

  const expected = localStorage.getItem("pkce_state");
  const verifier = localStorage.getItem("pkce_verifier");

  // clean up
  localStorage.removeItem("pkce_state");
  localStorage.removeItem("pkce_verifier");

  if (!expected || state !== expected) {
    console.error("PKCE state mismatch");
    // still push user back to home to retry
    location.replace(ORIGIN + "/");
    return;
  }

  // 1) Exchange code → access_token
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: INAT_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });

  const tokRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tok?.access_token) {
    console.error("Token endpoint did not return access_token", tok);
    location.replace(ORIGIN + "/");
    return;
  }

  // 2) Exchange access_token → API JWT (CORS OK)
  const jwtRes = await fetch(API_TOKEN_URL, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' }
  });
  let jwtText = await jwtRes.text();
  try { jwtText = JSON.parse(jwtText).api_token || jwtText; } catch {}
  const jwt = String(jwtText).replace(/["']/g,"").trim();

  if (!jwt || jwt.split(".").length !== 3) {
    console.error("Failed to obtain JWT from users/api_token");
    location.replace(ORIGIN + "/");
    return;
  }

  // 3) Save JWT (final key) and username, then go home
  localStorage.setItem("inat_token", jwt);
  try { await fetchCurrentUser(); } catch {}
  history.replaceState({}, "", REDIRECT_URI); // clean URL
  location.replace(ORIGIN + "/");
}