/**
 * Background refresh for list/dashboard pages.
 *
 *   SB_LIVE.watch(() => loadItems({ silent: true }), { every: 30000, skipIf: () => false });
 *
 * - Runs the given function every `every` ms (default 30 s) while the tab is visible and online.
 * - Pauses when the tab is hidden; refreshes right away when the person comes back (if it has been a while).
 * - Never runs while the person is busy: a modal/dialog is open, they are typing in a field, or text is selected.
 *   (Add your own rule with `skipIf`, e.g. a card that is expanded.)
 * - If a refresh fails it backs off (up to 5 min) and recovers on its own. Errors are never shown to the person.
 * The page's loader must support { silent: true }: keep what is on screen, no "Loading…", no error message.
 */
(function (g) {
  "use strict";
  var doc = g.document;
  var BUSY_SELECTOR = [
    ".modal-overlay.show", ".modal-overlay.active", ".modal-overlay.open",
    ".modal.show", ".modal.open", ".modal.active",
    "dialog[open]", "[role='dialog'][aria-hidden='false']", "[aria-modal='true']:not([hidden])"
  ].join(",");

  function userIsBusy() {
    try {
      var a = doc.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "button" && a.type !== "checkbox" && a.type !== "radio") return true;
      if (a && a.isContentEditable) return true;
      var sel = g.getSelection && g.getSelection();
      if (sel && String(sel).length > 0) return true;
      var modals = doc.querySelectorAll(BUSY_SELECTOR);
      for (var i = 0; i < modals.length; i++) {
        var el = modals[i];
        if (el.offsetParent !== null || (g.getComputedStyle(el).display !== "none" && g.getComputedStyle(el).visibility !== "hidden")) return true;
      }
    } catch (_e) { /* never block refresh on a check error */ }
    return false;
  }

  function watch(fn, options) {
    options = options || {};
    var base = Math.max(10000, Number(options.every) || 30000);
    var skipIf = typeof options.skipIf === "function" ? options.skipIf : null;
    var delay = base, timer = null, running = false, lastRun = Date.now();

    function schedule(ms) {
      clearTimeout(timer);
      timer = setTimeout(tick, ms == null ? delay : ms);
    }

    function tick() {
      if (doc.hidden || g.navigator.onLine === false) { schedule(); return; }
      if (running || userIsBusy() || (skipIf && skipIf())) { schedule(5000); return; }
      running = true;
      var p;
      try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
      p.then(function () { delay = base; }, function () { delay = Math.min(delay * 2, 300000); })
        .then(function () { running = false; lastRun = Date.now(); schedule(); });
    }

    doc.addEventListener("visibilitychange", function () {
      if (!doc.hidden && Date.now() - lastRun > base) schedule(500);
    });
    g.addEventListener("online", function () { schedule(1000); });
    schedule();
    return { stop: function () { clearTimeout(timer); } };
  }

  g.SB_LIVE = { watch: watch };
})(window);