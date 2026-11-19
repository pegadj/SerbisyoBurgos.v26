/**
 * SerbisyoBurgos PWA helper. Every page loads it from <head> with `defer`:
 *   a script tag with src="shared/pwa.js" (or "../shared/pwa.js" inside a portal folder) and defer
 *
 * It does four things:
 *   1. Registers the service worker (sw.js at the site root). Needs https, or localhost for testing.
 *   2. Offers "Install app" where the browser supports it (Chrome / Edge / Android), and shows
 *      "Add to Home Screen" steps on iPhone / iPad.
 *   3. Tells the user when a new version is ready and refreshes on request.
 *   4. Shows a bar when the device is offline.
 *
 * Any element with a data-pwa-install attribute is shown only while the app can be installed,
 * and installs the app when clicked, e.g. <button data-pwa-install hidden>Install app</button>.
 * window.AppPWA exposes { canInstall(), install(), isInstalled() }.
 */
(function (global) {
  "use strict";

  var doc = global.document;
  var nav = global.navigator;
  var script = doc.currentScript;
  // The site root is the folder above shared/, so this works from any page depth.
  var ROOT = script && script.src ? new URL("../", script.src) : new URL("./", global.location.href);

  var DISMISS_KEY = "sb-pwa-install-dismissed";
  var DISMISS_DAYS = 14;
  var deferredPrompt = null;
  var installBanner = null;

  // ---------- helpers ----------
  function isStandalone() {
    return !!(
      (global.matchMedia && global.matchMedia("(display-mode: standalone)").matches) ||
      nav.standalone === true
    );
  }

  function isIos() {
    var ua = nav.userAgent || "";
    var iPadOs13 = nav.platform === "MacIntel" && nav.maxTouchPoints > 1;
    return /iphone|ipad|ipod/i.test(ua) || iPadOs13;
  }

  function recentlyDismissed() {
    try {
      var at = Number(global.localStorage.getItem(DISMISS_KEY) || 0);
      return at > 0 && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
    } catch (_e) {
      return false;
    }
  }

  function rememberDismissed() {
    try {
      global.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch (_e) { /* private mode: ask again next time */ }
  }

  function el(tag, props, html) {
    var node = doc.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { node.setAttribute(k, props[k]); });
    if (html != null) node.innerHTML = html;
    return node;
  }

  var STYLE =
    ".sbp-bar{position:fixed;left:0;right:0;top:0;z-index:100000;padding:.5rem 1rem;text-align:center;font:600 .85rem/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff;transform:translateY(-100%);transition:transform .25s ease}" +
    ".sbp-bar.show{transform:none}" +
    ".sbp-offline{background:#334155}" +
    ".sbp-online{background:#16a34a}" +
    ".sbp-card{position:fixed;z-index:100000;left:1rem;right:1rem;bottom:1rem;max-width:420px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 12px 32px rgba(15,23,42,.22);padding:1rem 1.1rem;font:.9rem/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1e293b;display:flex;gap:.85rem;align-items:flex-start}" +
    ".sbp-card img{width:44px;height:44px;border-radius:11px;flex:none}" +
    ".sbp-card b{display:block;color:#043d2e;font-size:.95rem;margin-bottom:.15rem}" +
    ".sbp-card p{color:#64748b;font-size:.85rem}" +
    ".sbp-actions{display:flex;gap:.5rem;margin-top:.7rem;flex-wrap:wrap}" +
    ".sbp-btn{font:inherit;font-weight:600;font-size:.82rem;padding:.45rem .95rem;border-radius:9px;cursor:pointer;border:1px solid #e2e8f0;background:#fff;color:#334155}" +
    ".sbp-btn.primary{background:#16a34a;border-color:#16a34a;color:#fff}" +
    ".sbp-btn:focus-visible{outline:3px solid #bbf7d0;outline-offset:2px}" +
    "@media print{.sbp-bar,.sbp-card{display:none !important}}";

  function injectStyle() {
    if (doc.getElementById("sbp-style")) return;
    var s = el("style", { id: "sbp-style" });
    s.textContent = STYLE;
    doc.head.appendChild(s);
  }

  // ---------- 1. service worker + 3. updates ----------
  function showUpdateBanner(registration) {
    if (doc.getElementById("sbp-update")) return;
    injectStyle();
    var card = el("div", { id: "sbp-update", class: "sbp-card", role: "status" });
    card.innerHTML =
      '<img src="' + new URL("asset/icons/icon-192.png", ROOT).href + '" alt="">' +
      "<div><b>A new version is ready</b><p>Refresh to get the latest SerbisyoBurgos.</p>" +
      '<div class="sbp-actions"><button type="button" class="sbp-btn primary" data-act="refresh">Refresh</button>' +
      '<button type="button" class="sbp-btn" data-act="later">Later</button></div></div>';
    card.addEventListener("click", function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
      if (act === "refresh") {
        if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
        else global.location.reload();
      } else if (act === "later") {
        card.remove();
      }
    });
    doc.body.appendChild(card);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in nav)) return;
    var secure = global.location.protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(global.location.hostname);
    if (!secure) return;

    var reloading = false;
    nav.serviceWorker.addEventListener("controllerchange", function () {
      // A new version took over after the user chose Refresh: load it once.
      if (reloading || !hadController) return;
      reloading = true;
      global.location.reload();
    });
    var hadController = !!nav.serviceWorker.controller;

    nav.serviceWorker
      .register(new URL("sw.js", ROOT).href, { scope: ROOT.pathname, updateViaCache: "none" })
      .then(function (registration) {
        if (registration.waiting && nav.serviceWorker.controller) showUpdateBanner(registration);
        registration.addEventListener("updatefound", function () {
          var worker = registration.installing;
          if (!worker) return;
          worker.addEventListener("statechange", function () {
            if (worker.state === "installed" && nav.serviceWorker.controller) showUpdateBanner(registration);
          });
        });
        // Look for a new version when the user comes back to the app and about once an hour.
        doc.addEventListener("visibilitychange", function () {
          if (doc.visibilityState === "visible") registration.update().catch(function () {});
        });
        global.setInterval(function () { registration.update().catch(function () {}); }, 60 * 60 * 1000);
      })
      .catch(function () { /* the app works fine without it */ });
  }

  // ---------- 2. install ----------
  function syncInstallHooks() {
    var show = !!deferredPrompt && !isStandalone();
    Array.prototype.forEach.call(doc.querySelectorAll("[data-pwa-install]"), function (node) {
      node.hidden = !show;
    });
  }

  function hideInstallBanner() {
    if (installBanner) {
      installBanner.remove();
      installBanner = null;
    }
  }

  function showInstallBanner(iosSteps) {
    if (installBanner || isStandalone() || recentlyDismissed()) return;
    injectStyle();
    installBanner = el("div", { id: "sbp-install", class: "sbp-card", role: "dialog", "aria-label": "Install SerbisyoBurgos" });
    var body = iosSteps
      ? "<p>On iPhone or iPad: tap the <b style='display:inline;font-size:inherit'>Share</b> button, then choose <b style='display:inline;font-size:inherit'>Add to Home Screen</b>.</p>"
      : "<p>Add it to your home screen for quick access, even on a slow connection.</p>";
    installBanner.innerHTML =
      '<img src="' + new URL("asset/icons/icon-192.png", ROOT).href + '" alt="">' +
      "<div><b>Install SerbisyoBurgos</b>" + body +
      '<div class="sbp-actions">' +
      (iosSteps ? "" : '<button type="button" class="sbp-btn primary" data-act="install">Install</button>') +
      '<button type="button" class="sbp-btn" data-act="dismiss">' + (iosSteps ? "Got it" : "Not now") + "</button></div></div>";
    installBanner.addEventListener("click", function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
      if (act === "install") install();
      else if (act === "dismiss") {
        rememberDismissed();
        hideInstallBanner();
      }
    });
    doc.body.appendChild(installBanner);
  }

  function install() {
    if (!deferredPrompt) return Promise.resolve(false);
    var promptEvent = deferredPrompt;
    deferredPrompt = null; // a browser prompt can only be used once
    hideInstallBanner();
    syncInstallHooks();
    promptEvent.prompt();
    return promptEvent.userChoice.then(function (choice) {
      var accepted = !!choice && choice.outcome === "accepted";
      if (!accepted) rememberDismissed();
      return accepted;
    });
  }

  global.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); // we show our own, quieter prompt
    deferredPrompt = e;
    syncInstallHooks();
    // Give the page a moment to load before asking.
    global.setTimeout(function () { if (deferredPrompt) showInstallBanner(false); }, 4000);
  });

  global.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    rememberDismissed();
    hideInstallBanner();
    syncInstallHooks();
  });

  doc.addEventListener("click", function (e) {
    var hook = e.target && e.target.closest && e.target.closest("[data-pwa-install]");
    if (hook) {
      e.preventDefault();
      install();
    }
  });

  // ---------- 4. offline indicator ----------
  var offlineBar = null;
  var onlineTimer = null;

  function ensureBar() {
    if (offlineBar) return offlineBar;
    injectStyle();
    offlineBar = el("div", { class: "sbp-bar", role: "status", "aria-live": "polite" });
    doc.body.appendChild(offlineBar);
    return offlineBar;
  }

  function showOffline() {
    global.clearTimeout(onlineTimer);
    var bar = ensureBar();
    bar.className = "sbp-bar sbp-offline";
    bar.textContent = "You're offline. Saved pages still open, but requests and appointments can't load or send until you reconnect.";
    global.requestAnimationFrame(function () { bar.classList.add("show"); });
  }

  function showBackOnline() {
    if (!offlineBar) return;
    var bar = offlineBar;
    bar.className = "sbp-bar sbp-online show";
    bar.textContent = "Back online.";
    global.clearTimeout(onlineTimer);
    onlineTimer = global.setTimeout(function () { bar.classList.remove("show"); }, 2500);
  }

  function init() {
    registerServiceWorker();
    if (nav.onLine === false) showOffline();
    global.addEventListener("offline", showOffline);
    global.addEventListener("online", showBackOnline);
    if (isStandalone()) doc.documentElement.classList.add("is-pwa");
    // Browsers without an install event (iPhone / iPad Safari) get the manual steps once.
    if (isIos() && !isStandalone()) global.setTimeout(function () { showInstallBanner(true); }, 5000);
    syncInstallHooks();
  }

  global.AppPWA = {
    canInstall: function () { return !!deferredPrompt && !isStandalone(); },
    install: install,
    isInstalled: isStandalone
  };

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})(window);