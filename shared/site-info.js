/**
 * Barangay site info (contact number, office hours, address, document signatory).
 * Source of truth: the backend (/public/site-info), edited by the system admin in Configuration.
 *
 * Usage:
 *   - Load after shared/routes.js:   <script src="shared/site-info.js"></script>
 *   - Mark any element:              <p data-site="contactNumber">09xx (fallback text)</p>
 *     Keys: barangayName, municipality, province, contactNumber, officeHours, address, signatoryName, signatoryTitle
 *     Combined (built here): placeShort, barangayFull, barangayAddress, brgyAddress
 *   - Scripts can use:               SB_SITE.get()   -> last known info or null (instant, from cache)
 *                                    SB_SITE.ready   -> Promise resolving with fresh info (or cached/null if offline)
 *                                    document event "sb:site-info" fires whenever info is applied.
 * The text already in the HTML stays as the fallback if the server can't be reached.
 */
(function (g) {
  "use strict";
  var KEY = "sb_site_info_v1";
  var doc = g.document;
  var current = null;

  function readCache() {
    try {
      var raw = g.localStorage.getItem(KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_e) {
      return null;
    }
  }
  function writeCache(info) {
    try { g.localStorage.setItem(KEY, JSON.stringify(info)); } catch (_e) { /* storage blocked */ }
  }

  // Adds ready-made combined strings so pages never have to join the parts themselves.
  function withDerived(info) {
    if (!info) return info;
    var b = String(info.barangayName || "").trim();
    var m = String(info.municipality || "").trim();
    var p = String(info.province || "").trim();
    var place = [m, p].filter(Boolean).join(", ");
    info.placeShort = place;                                              // "San Marcelino, Zambales"
    info.barangayFull = b ? "Barangay " + b : "";                         // "Barangay Burgos"
    info.barangayAddress = [info.barangayFull, place].filter(Boolean).join(", ");   // "Barangay Burgos, San Marcelino, Zambales"
    info.brgyAddress = [b ? "Brgy. " + b : "", place].filter(Boolean).join(", ");   // "Brgy. Burgos, San Marcelino, Zambales"
    return info;
  }

  function apply(info) {
    if (!info) return;
    info = withDerived(info);
    current = info;
    var nodes = doc.querySelectorAll("[data-site]");
    for (var i = 0; i < nodes.length; i++) {
      var value = info[nodes[i].getAttribute("data-site")];
      if (typeof value === "string" && value) nodes[i].textContent = value;
    }
    try { doc.dispatchEvent(new CustomEvent("sb:site-info", { detail: info })); } catch (_e) { /* old browser */ }
  }

  function fetchFresh() {
    var base = String(g.API_BASE_URL || "").replace(/\/$/, "");
    return g.fetch(base + "/public/site-info")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j && j.ok && j.siteInfo ? j.siteInfo : null; })
      .catch(function () { return null; });
  }

  var cached = withDerived(readCache());
  if (cached) current = cached;

  function start() {
    if (cached) apply(cached);          // instant: no flash of old text
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
  else start();

  var ready = fetchFresh().then(function (fresh) {
    if (fresh) {
      writeCache(fresh);
      if (doc.readyState === "loading") {
        doc.addEventListener("DOMContentLoaded", function () { apply(fresh); });
      } else {
        apply(fresh);
      }
      return fresh;
    }
    return current;
  });

  g.SB_SITE = {
    ready: ready,
    get: function () { return current; },
    refresh: function () { return fetchFresh().then(function (f) { if (f) { writeCache(f); apply(f); } return f; }); }
  };
})(window);