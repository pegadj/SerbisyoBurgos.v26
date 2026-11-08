/* SerbisyoBurgos service worker.
   - Only same-origin GET requests are handled; API calls (your Render backend) are never touched or cached.
   - Pages and scripts: network first, cached copy when offline. Images: cache first.
   - Bump VERSION whenever you want to force every device to drop old cached files. */
const VERSION = "sb-pwa-v1";
const CORE = [
  "offline.html",
  "manifest.json",
  "index.html",
  "asset/SB.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      Promise.all(CORE.map((url) => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheable(res) {
  return res && res.ok && res.type === "basic" && !res.redirected;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Images and icons: cache first.
  if (req.destination === "image") {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (cacheable(res)) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // Pages, scripts, styles: network first, fall back to cache, then the offline page.
  event.respondWith(
    fetch(req).then((res) => {
      if (cacheable(res)) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() =>
      caches.match(req).then((hit) => {
        if (hit) return hit;
        if (req.mode === "navigate") return caches.match("offline.html");
        return Response.error();
      })
    )
  );
});