/*
 * SerbisyoBurgos service worker.
 *
 * Keep this file at the site root (next to index.html) so it covers every portal folder.
 *
 * What it does:
 *   - Saves the public pages, scripts and logo on first load so the app opens quickly and still opens offline.
 *   - Pages and scripts: network first (you always get the newest version when online), saved copy when offline.
 *   - Images, fonts and the manifest: saved copy first, refreshed quietly in the background.
 *   - Offline and not saved yet: shows offline.html.
 *
 * What it never touches: anything that is not a page or a static file. Requests made by the app's own
 * code (fetch / XHR / EventSource to the API) always go straight to the network, so data is never stale
 * and logins or personal records are never stored here.
 *
 * To release a new version of the app shell, change VERSION below.
 */
const VERSION = "v2";
const STATIC_CACHE = "sb-static-" + VERSION; // precached files, scripts, images
const PAGES_CACHE = "sb-pages-" + VERSION;   // pages the user has opened
const FONT_CACHE = "sb-fonts-" + VERSION;    // Google Fonts
const KNOWN_CACHES = [STATIC_CACHE, PAGES_CACHE, FONT_CACHE];

const NETWORK_TIMEOUT_MS = 4000; // slow connection: fall back to the saved copy instead of waiting forever

// Paths are relative to the folder this file is in, so it also works when the site lives in a sub-folder.
const PRECACHE = [
  "offline.html",
  "index.html",
  "login.html",
  "how-it-works.html",
  "contact-us.html",
  "maintenance.html",
  "manifest.webmanifest",
  "asset/logo.png",
  "asset/icons/icon-192.png",
  "asset/icons/icon-512.png",
  "asset/icons/apple-touch-icon.png",
  "shared/pwa.js",
  "shared/routes.js",
  "shared/sidebar.js",
  "shared/maintenance-check.js",
  "shared/admin-access.js",
  "shared/staff-page-guard.js",
  "shared/resident-auth-guard.js",
  "shared/resident-sidebar-profile.js",
  "shared/resident-profile-modal.js",
  "shared/resident-faq-chat.js",
  "shared/place-autocomplete.js"
];

const NETWORK_FIRST_DESTINATIONS = new Set(["script", "style"]);
const CACHE_FIRST_DESTINATIONS = new Set(["image", "font", "manifest"]);

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

// Page URLs are saved without the query string, so ?requestId=... does not create hundreds of copies.
function pageKey(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

function fetchWithTimeout(request, ms) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error("timeout")); }, ms);
    fetch(request).then(
      function (res) { clearTimeout(timer); resolve(res); },
      function (err) { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function (cache) {
      // One missing file must not stop the rest from being saved.
      return Promise.all(
        PRECACHE.map(function (path) {
          return cache.add(new Request(scopeUrl(path), { cache: "reload" })).catch(function () { return null; });
        })
      );
    })
  );
  // No skipWaiting() here: the page asks for it (SKIP_WAITING message) so an update never swaps files mid-session.
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) { return key.indexOf("sb-") === 0 && KNOWN_CACHES.indexOf(key) === -1; })
            .map(function (key) { return caches.delete(key); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

async function networkFirst(request, cacheName, key, fallbackToOfflinePage, event) {
  const cache = await caches.open(cacheName);
  // "/" is the same page as "/index.html".
  const alternateKey = key.endsWith("/") ? key + "index.html" : null;
  const cached = (await cache.match(key)) || (await caches.match(key)) || (alternateKey ? await caches.match(alternateKey) : undefined);
  try {
    // With a saved copy available, do not wait long for a slow network.
    const response = cached ? await fetchWithTimeout(request, NETWORK_TIMEOUT_MS) : await fetch(request);
    // Redirected responses cannot be replayed for page loads, and errors should not replace a good copy.
    if (response && response.ok && response.type === "basic" && !response.redirected) {
      const copy = response.clone();
      const save = cache.put(key, copy);
      if (event) event.waitUntil(save);
    }
    return response;
  } catch (_error) {
    if (cached) return cached;
    if (fallbackToOfflinePage) {
      const offline = await caches.match(scopeUrl("offline.html"));
      if (offline) return offline;
    }
    return new Response("You are offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function cacheFirst(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = (await cache.match(request)) || (await caches.match(request));
  const refresh = fetch(request)
    .then(function (response) {
      // Google Fonts answers are "opaque" (cross-site), which is fine to keep.
      if (response && (response.ok || response.type === "opaque")) cache.put(request, response.clone());
      return response;
    })
    .catch(function () { return null; });
  if (cached) {
    if (event) event.waitUntil(refresh); // update quietly for next time
    return cached;
  }
  const fresh = await refresh;
  return fresh || Response.error();
}

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_e) {
    return;
  }

  // Google Fonts (the only other site we save anything from).
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(request, FONT_CACHE, event));
    return;
  }

  // Everything else on another site (the API, maps, etc.): do not touch.
  if (url.origin !== self.location.origin) return;

  // Page loads.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, PAGES_CACHE, pageKey(request.url), true, event));
    return;
  }

  // Scripts and styles: newest when online.
  if (NETWORK_FIRST_DESTINATIONS.has(request.destination)) {
    event.respondWith(networkFirst(request, STATIC_CACHE, request.url, false, event));
    return;
  }

  // Images, fonts, manifest.
  if (CACHE_FIRST_DESTINATIONS.has(request.destination)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE, event));
    return;
  }

  // Anything else (requests made by the app's code, e.g. fetch/EventSource to the API): straight to the network.
});