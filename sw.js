self.addEventListener("fetch", (event) => {
  const u = new URL(event.request.url);
  const isINatPhoto =
    (u.hostname.includes("inaturalist") || u.hostname.includes("amazonaws")) &&
    u.pathname.includes("/photos/");
  if (!isINatPhoto) return;

  event.respondWith((async () => {
    const cache = await caches.open("inat-photos-v1");
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const resp = await fetch(event.request, { mode: "no-cors" }); // opaque but cacheable
    try { await cache.put(event.request, resp.clone()); } catch {}
    return resp;
  })());
});
