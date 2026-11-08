/**
 * PWA bootstrap: registers the service worker and (optionally) shows an "Install app" button.
 * Include with:  <script src="shared/pwa.js" defer></script>
 * Add the attribute  data-install-button  to show the install button on that page.
 */
(function () {
  var script = document.currentScript;
  var base = script && script.src ? script.src : location.href;

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register(new URL("../sw.js", base)).catch(function () { /* ignore */ });
    });
  }

  if (!script || !script.hasAttribute("data-install-button")) return;

  var deferred = null;
  var btn = null;

  function standalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    if (standalone()) return;
    deferred = e;
    if (btn) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Install app";
    btn.setAttribute("style",
      "position:fixed;right:16px;bottom:16px;z-index:9999;padding:12px 18px;border:0;border-radius:999px;" +
      "background:#16a34a;color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.2);cursor:pointer;");
    btn.addEventListener("click", function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () {
        deferred = null;
        if (btn) { btn.remove(); btn = null; }
      });
    });
    document.body.appendChild(btn);
  });

  window.addEventListener("appinstalled", function () {
    if (btn) { btn.remove(); btn = null; }
  });
})();