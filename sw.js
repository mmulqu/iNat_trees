// Photo cache service worker. Caches iNat photo responses so the popup
// previews and other consumers (e.g. <img> tags in the markmap preview)
// load instantly on repeat visits.
//
// IMPORTANT: this SW must only intercept "no-cors" requests. For requests
// with mode "cors" — used by fetch() + WebGL texture uploads in the 3D
// Hallway view — we have to step out of the way. Otherwise:
//   1. The SW can only refetch with mode "no-cors" (cross-origin
//      restriction inside a service worker context).
//   2. That returns an opaque response, which the SW must hand back.
//   3. The browser then rejects an opaque response delivered to a
//      cors-mode request ("an opaque response was used for a request
//      whose type is not no-cors") and the photo load fails entirely.
// Bypassing cors-mode here lets the browser fetch directly from the iNat
// CDN, validate Access-Control-Allow-Origin, and hand the texture data
// to WebGL — so the hallway cards actually show their photos.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const u = new URL(req.url);
  const isINatPhoto =
    (u.hostname.includes("inaturalist") || u.hostname.includes("amazonaws")) &&
    u.pathname.includes("/photos/");
  if (!isINatPhoto) return;
  // Let cors-mode requests pass straight through to the network.
  if (req.mode === "cors") return;

  event.respondWith((async () => {
    const cache = await caches.open("inat-photos-v1");
    const hit = await cache.match(req);
    if (hit) return hit;
    const resp = await fetch(req, { mode: "no-cors" }); // opaque but cacheable
    try { await cache.put(req, resp.clone()); } catch {}
    return resp;
  })());
});
