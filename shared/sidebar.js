/**
 * Shared sidebar component (SerbisyoBurgos).
 *
 * Every portal page used to carry its own copy of the sidebar markup. Now a page just calls it:
 *
 *   a script tag with src="../shared/sidebar.js" and data-portal="staff"
 *
 * Put the tag exactly where the sidebar used to be (before the main content). The script writes a
 * real aside element in its place, so the page's existing CSS and scripts keep working unchanged.
 *
 *   data-portal   required: "resident" | "staff" | "admin" | "system-admin"
 *   data-active   optional: href of the item to highlight (default: detected from the page's file name)
 *
 * To add, rename or reorder a menu item, edit PORTALS below. It changes on every page of that portal.
 *
 * Open / close: every sidebar has a close button, and a menu button appears when it is closed.
 * The choice is remembered (localStorage "sb-collapsed"). On phones and small windows (900px or
 * less) the sidebar starts closed and opens on top of the page.
 */
(function (global) {
  "use strict";

  var LOGOUT_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;">' +
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>' +
    '<polyline points="16 17 21 12 16 7"></polyline>' +
    '<line x1="21" y1="12" x2="9" y2="12"></line></svg>';

  var PORTALS = {
    resident: {
      linkClass: "nav-link",
      wrapLabel: false,
      logoStyle: ' style="width: 32px;"',
      items: [
      { href: "dashboard.html", label: "Dashboard",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\"></rect><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\"></rect></svg>" },
      { href: "service-requests.html", label: "Service Requests",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"></path><polyline points=\"14 2 14 8 20 8\"></polyline><line x1=\"16\" y1=\"13\" x2=\"8\" y2=\"13\"></line><line x1=\"16\" y1=\"17\" x2=\"8\" y2=\"17\"></line><polyline points=\"10 9 9 9 8 9\"></polyline></svg>" },
      { href: "appointments.html", label: "Appointments",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\"></rect><line x1=\"16\" y1=\"2\" x2=\"16\" y2=\"6\"></line><line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"6\"></line><line x1=\"3\" y1=\"10\" x2=\"21\" y2=\"10\"></line></svg>" },
      { href: "notifications.html", label: "Bulletin Board",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9\"></path><path d=\"M13.73 21a2 2 0 0 1-3.46 0\"></path></svg>" },
      { href: "request-history.html", label: "Request History",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><polyline points=\"12 6 12 12 16 14\"></polyline></svg>" }
    ],
      footer: function () {
        return (
          '<div class="user-profile" id="residentProfileBtn" style="cursor: pointer;">' +
            '<div class="user-avatar" id="residentSidebarAvatar" aria-hidden="true">?</div>' +
            '<div class="user-info">' +
              '<span class="user-name" id="residentSidebarName">Resident</span>' +
              '<span class="user-role">View Profile</span>' +
            "</div>" +
          "</div>" +
          '<a href="landing.html" class="logout-btn" onclick="handleLogout(event)">' + LOGOUT_ICON + "<span>Logout</span></a>"
        );
      }
    },
    staff: {
      linkClass: "nav-link",
      wrapLabel: false,
      logoStyle: ' width="32"',
      // Staff pages attach their own logout handler to #adminLogoutBtn and re-point #dashboardHomeLink.
      itemIds: { "staff-dashboard.html": "dashboardHomeLink" },
      items: [
      { href: "staff-dashboard.html", label: "Dashboard",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\"></rect><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\"></rect></svg>" },
      { href: "appointment-scheduling.html", label: "Appointment Scheduling",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"> <rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\"></rect> <line x1=\"16\" y1=\"2\" x2=\"16\" y2=\"6\"></line> <line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"6\"></line> <line x1=\"3\" y1=\"10\" x2=\"21\" y2=\"10\"></line> </svg>" },
      { href: "request-processing.html", label: "Request Processing",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"> <path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"></path> <rect x=\"8\" y=\"2\" width=\"8\" height=\"4\" rx=\"1\" ry=\"1\"></rect> <path d=\"M9 14l2 2 4-4\"></path> </svg>" },
      { href: "document-generator.html", label: "Document Generator",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"> <path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"></path> <polyline points=\"14 2 14 8 20 8\"></polyline> <line x1=\"12\" y1=\"18\" x2=\"12\" y2=\"12\"></line> <line x1=\"9\" y1=\"15\" x2=\"15\" y2=\"15\"></line> </svg>" },
      { href: "resident-profiling.html", label: "Resident Profiling",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2\"></path><circle cx=\"9\" cy=\"7\" r=\"4\"></circle><path d=\"M23 21v-2a4 4 0 0 0-3-3.87\"></path><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"></path></svg>" },
      { href: "animal-vaccine-tracker.html", label: "Animal Vaccine Tracker",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\"></path><path d=\"M9 12l2 2 4-4\"></path></svg>" }
    ],
      footer: function () {
        return '<a href="index.html" class="logout-btn" id="adminLogoutBtn">' + LOGOUT_ICON + "<span>Logout</span></a>";
      }
    },
    admin: {
      linkClass: "nav-item",
      wrapLabel: false,
      logoStyle: "",
      items: [
      { href: "service-mngmt.html", label: "Dashboard",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\"></rect><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\"></rect></svg>" },
      { href: "user-role.html", label: "User & Roles",
        icon: "<svg fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" viewBox=\"0 0 24 24\"><path d=\"M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z\"></path></svg>" },
      { href: "reports-analytics.html", label: "Analytics",
        icon: "<svg fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" viewBox=\"0 0 24 24\"><path d=\"M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z\"></path></svg>" },
      { href: "announcements.html", label: "Announcements",
        icon: "<svg fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" viewBox=\"0 0 24 24\"><path d=\"M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9\"></path></svg>" }
    ],
      footer: function () {
        return '<a href="../index.html" class="logout-btn" onclick="handleLogout(event)">' + LOGOUT_ICON + "<span>Logout</span></a>";
      }
    },
    "system-admin": {
      linkClass: "nav-item",
      wrapLabel: true,
      logoStyle: "",
      items: [
      { href: "sysad-dashboard.html", label: "Dashboard",
        icon: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\"></rect><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\"></rect></svg>" },
      { href: "audit-logs.html", label: "Audit Trail & Activity Logs",
        icon: "<svg fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"> <path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01\"></path> </svg>" },
      { href: "sys-config.html", label: "Configuration & Maintenance",
        icon: "<svg fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"> <path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\"></path> <path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\"></path> </svg>" },
      { href: "backup-recovery.html", label: "Data Backup & Recovery",
        icon: "<svg fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"> <path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15\"></path> </svg>" }
    ],
      footer: function () {
        return '<a href="../index.html" class="logout-btn" onclick="handleLogout(event)">' + LOGOUT_ICON + "<span>Logout</span></a>";
      }
    }
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fileName(path) {
    var clean = String(path || "").split("#")[0].split("?")[0];
    return clean.substring(clean.lastIndexOf("/") + 1).toLowerCase();
  }

  /** Builds the sidebar HTML for a portal. Exposed for tests and for pages that render it themselves. */
  function buildSidebar(portalKey, activeHref) {
    var portal = PORTALS[portalKey];
    if (!portal) throw new Error('sidebar.js: unknown data-portal "' + portalKey + '".');
    var active = fileName(activeHref || global.location.pathname);

    var links = portal.items
      .map(function (item) {
        var isActive = fileName(item.href) === active;
        var id = portal.itemIds && portal.itemIds[item.href];
        var label = portal.wrapLabel ? "<span>" + escapeHtml(item.label) + "</span>" : escapeHtml(item.label);
        return (
          '<a href="' + item.href + '" class="' + portal.linkClass + (isActive ? " active" : "") + '"' +
          (id ? ' id="' + id + '"' : "") +
          (isActive ? ' aria-current="page"' : "") + ">" +
          item.icon + label + "</a>"
        );
      })
      .join("");

    return (
      "<aside>" +
        '<div class="sidebar-header">' +
          '<img src="../asset/SB.png" alt="Logo"' + portal.logoStyle + ">" +
          "<span>SerbisyoBurgos</span>" +
        "</div>" +
        "<nav>" + links + "</nav>" +
        '<div class="sidebar-footer">' + portal.footer() + "</div>" +
      "</aside>"
    );
  }


  var CLOSE_ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="11 17 6 12 11 7"></polyline>' +
    '<polyline points="18 17 13 12 18 7"></polyline></svg>';
  var MENU_ICON =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"></line>' +
    '<line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>';

  var STORAGE_KEY = "sb-collapsed";
  var MOBILE_QUERY = "(max-width: 900px)";
  var SIDEBAR_WIDTH = "260px";

  // Pages size the layout with --sidebar-width (the sidebar's width and the main content's left margin),
  // so setting it to 0 when closed lets the content fill the screen with no change to any page.
  var CSS =
    "aside{transition:transform .25s ease,visibility 0s;z-index:100}" +
    "main{transition:margin-left .25s ease,width .25s ease}" +
    "html.sb-collapsed{--sidebar-width:0px !important}" +
    "html.sb-collapsed aside{width:" + SIDEBAR_WIDTH + ";transform:translateX(-100%);visibility:hidden;" +
      "transition:transform .25s ease,visibility 0s linear .25s}" +
    "html.sb-collapsed main{padding-top:4.5rem !important}" +
    ".sb-toggle,.sb-open{display:flex;align-items:center;justify-content:center;border:0;cursor:pointer;font-family:inherit}" +
    ".sb-toggle{position:absolute;top:12px;right:12px;width:34px;height:34px;border-radius:10px;" +
      "background:rgba(255,255,255,.18);color:#fff;transition:background .15s}" +
    ".sb-toggle:hover{background:rgba(255,255,255,.32)}" +
    ".sb-open{display:none;position:fixed;top:14px;left:14px;z-index:101;width:42px;height:42px;border-radius:12px;" +
      "background:#5f9632;color:#fff;box-shadow:0 4px 12px rgba(4,61,46,.28)}" +
    ".sb-open:hover{background:#4f8029}" +
    "html.sb-collapsed .sb-open{display:flex}" +
    ".sb-toggle:focus-visible,.sb-open:focus-visible{outline:3px solid #bbf7d0;outline-offset:2px}" +
    ".sb-backdrop{display:none}" +
    "@media (max-width:900px){" +
      "html{--sidebar-width:0px !important}" +
      "aside{width:" + SIDEBAR_WIDTH + " !important}" +
      "html:not(.sb-collapsed) aside{box-shadow:0 0 40px rgba(0,0,0,.3)}" +
      "html:not(.sb-collapsed) .sb-backdrop{display:block;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:99}" +
    "}" +
    "@media (prefers-reduced-motion:reduce){aside,main{transition:none !important}}" +
    "@media print{.sb-toggle,.sb-open,.sb-backdrop{display:none !important}}";

  function isMobile() {
    return !!(global.matchMedia && global.matchMedia(MOBILE_QUERY).matches);
  }

  function readSaved() {
    try {
      return global.localStorage.getItem(STORAGE_KEY) === "1";
    } catch (_e) {
      return false;
    }
  }

  /** Adds the open / close behaviour. Safe to call once per page. */
  function setupToggle(asideEl) {
    var doc = global.document;
    var root = doc.documentElement;
    if (!asideEl || root.getAttribute("data-sb-ready") === "1") return;
    root.setAttribute("data-sb-ready", "1");

    var style = doc.createElement("style");
    style.id = "app-sidebar-style";
    style.textContent = CSS;
    doc.head.appendChild(style);

    var closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sb-toggle";
    closeBtn.setAttribute("aria-label", "Close sidebar");
    closeBtn.setAttribute("title", "Close sidebar");
    closeBtn.innerHTML = CLOSE_ICON;
    asideEl.appendChild(closeBtn);

    var openBtn = doc.createElement("button");
    openBtn.type = "button";
    openBtn.className = "sb-open";
    openBtn.setAttribute("aria-label", "Open sidebar");
    openBtn.setAttribute("title", "Open sidebar");
    openBtn.innerHTML = MENU_ICON;
    asideEl.insertAdjacentElement("afterend", openBtn);

    var backdrop = doc.createElement("div");
    backdrop.className = "sb-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    openBtn.insertAdjacentElement("afterend", backdrop);

    var collapsed = false;
    function apply(next, save) {
      collapsed = !!next;
      root.classList.toggle("sb-collapsed", collapsed);
      asideEl.setAttribute("aria-hidden", collapsed ? "true" : "false");
      closeBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      openBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      if (save && !isMobile()) {
        try {
          global.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
        } catch (_e) { /* private mode: just don't remember it */ }
      }
      // Charts and tables size themselves to the page width, so tell them once the slide finishes.
      global.setTimeout(function () { global.dispatchEvent(new global.Event("resize")); }, 290);
    }

    closeBtn.addEventListener("click", function () { apply(true, true); });
    openBtn.addEventListener("click", function () { apply(false, true); if (isMobile()) closeBtn.focus(); else closeBtn.focus(); });
    backdrop.addEventListener("click", function () { apply(true, false); });
    doc.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isMobile() && !collapsed) { apply(true, false); openBtn.focus(); }
    });

    // Phones always start closed (it opens on top of the page); desktops remember the last choice.
    apply(isMobile() ? true : readSaved(), false);

    var mq = global.matchMedia ? global.matchMedia(MOBILE_QUERY) : null;
    if (mq) {
      var onChange = function () { apply(isMobile() ? true : readSaved(), false); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  global.AppSidebar = { build: buildSidebar, portals: PORTALS, setupToggle: setupToggle };

  // Auto-render in place when loaded with <script data-portal="...">.
  var script = global.document && (global.document.currentScript || global.document.querySelector("script[data-portal][src$='sidebar.js']"));
  if (script && script.getAttribute("data-portal")) {
    script.insertAdjacentHTML("beforebegin", buildSidebar(script.getAttribute("data-portal"), script.getAttribute("data-active")));
    setupToggle(script.previousElementSibling);
  }
})(typeof window !== "undefined" ? window : this);