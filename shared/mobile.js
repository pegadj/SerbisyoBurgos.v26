/**
 * Mobile layout for the portal pages that use an <aside> sidebar + <main>.
 * Loaded automatically by shared/routes.js. On screens <= 900px the sidebar becomes a slide-in menu
 * (hamburger button), main content uses the full width, tables scroll sideways and wide grids stack.
 */
(function () {
  if (window.__sbMobileLoaded) return;
  window.__sbMobileLoaded = true;

  var CSS = [
    ".sb-menu-btn,.sb-backdrop{display:none;}",
    "@media (max-width:900px){",
    "  aside{position:fixed!important;top:0;left:0;height:100%!important;width:min(280px,84vw)!important;transform:translateX(-102%);transition:transform .25s ease;z-index:1200!important;overflow-y:auto;}",
    "  body.sb-nav-open aside{transform:none;box-shadow:0 0 40px rgba(0,0,0,.35);}",
    "  main{margin-left:0!important;width:100%!important;max-width:100vw;min-width:0;padding:4.25rem 1rem 1.5rem!important;box-sizing:border-box;}",
    "  .top-bar{flex-wrap:wrap;gap:.75rem;}",
    "  main table{display:block;overflow-x:auto;max-width:100%;}",
    "  .modal-window{flex-direction:column!important;width:94vw!important;max-width:94vw!important;max-height:92vh;overflow-y:auto;}",
    "  img,video{max-width:100%;height:auto;}",
    "  .sb-menu-btn{display:flex;position:fixed;top:12px;left:12px;z-index:1100;width:42px;height:42px;align-items:center;justify-content:center;border:0;border-radius:10px;background:#16a34a;color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2);cursor:pointer;}",
    "  .sb-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:1150;}",
    "  body.sb-nav-open .sb-backdrop{display:block;}",
    "  body.sb-nav-open{overflow:hidden;}",
    "}",
    "[data-sb-cols=\"2\"]{grid-template-columns:repeat(2,minmax(0,1fr))!important;}",
    "[data-sb-cols=\"1\"]{grid-template-columns:minmax(0,1fr)!important;}"
  ].join("\n");

  function init() {
    var aside = document.querySelector("aside");
    var main = document.querySelector("main");
    if (!aside || !main) return;

    var style = document.createElement("style");
    style.id = "sb-mobile-css";
    style.textContent = CSS;
    document.head.appendChild(style);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sb-menu-btn";
    btn.setAttribute("aria-label", "Open menu");
    btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>';
    var backdrop = document.createElement("div");
    backdrop.className = "sb-backdrop";
    document.body.appendChild(btn);
    document.body.appendChild(backdrop);

    function setOpen(open) { document.body.classList.toggle("sb-nav-open", open); }
    btn.addEventListener("click", function () { setOpen(!document.body.classList.contains("sb-nav-open")); });
    backdrop.addEventListener("click", function () { setOpen(false); });
    aside.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("a")) setOpen(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });

    // Stack wide grids on small screens (also catches rows rendered later by scripts).
    var narrow = window.matchMedia("(max-width:700px)");
    var timer = null;
    function tagGrids() {
      if (!narrow.matches) {
        Array.prototype.forEach.call(document.querySelectorAll("[data-sb-cols]"), function (el) { el.removeAttribute("data-sb-cols"); });
        return;
      }
      Array.prototype.forEach.call(main.querySelectorAll("*"), function (el) {
        if (el.hasAttribute("data-sb-cols")) return;
        var cs = getComputedStyle(el);
        if (cs.display !== "grid") return;
        var cols = cs.gridTemplateColumns.split(" ").length;
        if (cols >= 3) el.setAttribute("data-sb-cols", "2");
        else if (cols === 2) el.setAttribute("data-sb-cols", "1");
      });
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(tagGrids, 150); }
    window.addEventListener("resize", schedule);
    if (window.MutationObserver) new MutationObserver(schedule).observe(main, { childList: true, subtree: true });
    schedule();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();