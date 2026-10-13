/**
 * Blur main content when the logged-in staff user lacks permission for this page.
 * Include after <main> exists, e.g. <script src="../shared/staff-page-guard.js" data-staff-permission="dashboard"></script>
 */
(function staffPageGuard() {
  var sc = document.currentScript;
  var permissionKey = sc && sc.getAttribute("data-staff-permission");
  if (!permissionKey) return;

  function defaultAllTrue() {
    return {
      dashboard: true,
      appointmentScheduling: true,
      requestProcessing: true,
      documentGenerator: true
    };
  }

  function normalizePermissions(raw) {
    var base = defaultAllTrue();
    if (!raw || typeof raw !== "object") return base;
    Object.keys(base).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(raw, k)) base[k] = Boolean(raw[k]);
    });
    return base;
  }

  function applyNoAccessOverlay(mainEl) {
    if (!mainEl || mainEl.querySelector(".staff-no-permission-overlay")) return;
    mainEl.style.position = "relative";
    var wrap = document.createElement("div");
    wrap.className = "staff-no-permission-overlay";
    wrap.setAttribute(
      "style",
      "position:absolute;inset:0;z-index:80;background:rgba(248,250,252,0.88);backdrop-filter:blur(6px);" +
        "display:flex;align-items:center;justify-content:center;padding:2rem;box-sizing:border-box;"
    );
    var msg = document.createElement("p");
    msg.textContent = "No permission granted on this page.";
    msg.setAttribute(
      "style",
      "margin:0;font-size:1.1rem;font-weight:700;color:#334155;text-align:center;max-width:22rem;line-height:1.45;"
    );
    wrap.appendChild(msg);
    mainEl.appendChild(wrap);
  }

  function run() {
    try {
      var raw = sessionStorage.getItem("adminAuth");
      if (!raw) return;
      var parsed = JSON.parse(raw);
      var user = parsed.user;
      if (!user || user.role !== "staff") return;
      var perms = normalizePermissions(user.staffPermissions);
      if (perms[permissionKey] === true) return;
      var main = document.querySelector("main");
      applyNoAccessOverlay(main);
    } catch (_e) {
      /* ignore */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
