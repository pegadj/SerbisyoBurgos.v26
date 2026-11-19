/**
 * <user-badge> - the logged-in user chip in the top-right of every portal page.
 * One component for all portals; the portal decides the role label.
 *
 * Usage (same on every page):
 *   1. Right after the sidebar include, load this file:
 *        <script src="../shared/sidebar.js" data-portal="staff"></script>
 *        <script src="../shared/user-badge.js"></script>
 *   2. Where the chip should appear (inside .top-bar):
 *        <user-badge></user-badge>
 *
 * The portal is taken from the page's sidebar <script data-portal="...">.
 * To override on one page:  <user-badge portal="system-admin"></user-badge>
 *
 * It renders immediately from the saved login session (no placeholder flash) and keeps the
 * element ids #topbarUserAvatar / #topbarUserName / #topbarUserRole so existing page scripts still work.
 * To add or rename a portal, edit PORTALS below - nothing else needs to change.
 */
(function () {
  "use strict";

  var PORTALS = {
    // title = top line, subtitle = bottom line, useUserName = show the logged-in user's name as the top line instead
    "staff": { title: "Barangay Secretary", subtitle: "Secretary Portal", useUserName: false, fallbackInitials: "BS" },
    "system-admin": { title: "System Admin", subtitle: "System Admin", useUserName: true, fallbackInitials: "SA" }
  };
  var DEFAULT_PORTAL = "staff";

  function portalFromPage() {
    var s = document.querySelector("script[data-portal]");
    var p = s && s.getAttribute("data-portal");
    return PORTALS[p] ? p : DEFAULT_PORTAL;
  }

  function initialsFromName(name, fallback) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return fallback;
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function readUser() {
    try {
      var raw = sessionStorage.getItem("adminAuth");
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.user ? parsed.user : null;
    } catch (_e) {
      return null;
    }
  }

  // Low-specificity defaults (:where) so a page's own .user-profile CSS, if any, still wins.
  if (!document.getElementById("user-badge-styles")) {
    var st = document.createElement("style");
    st.id = "user-badge-styles";
    st.textContent =
      "user-badge{display:contents}" +
      ":where(user-badge .user-profile){display:flex;align-items:center;gap:12px;background:var(--white,#fff);padding:6px 16px 6px 6px;border-radius:30px;border:1px solid #e2e8f0}" +
      ":where(user-badge .user-avatar){width:35px;height:35px;background:var(--brand-green,#0b6b3a);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700}" +
      "user-badge .ub-text{line-height:1.2}" +
      "user-badge .ub-name{font-weight:700;font-size:.85rem;margin:0}" +
      "user-badge .ub-role{font-size:.75rem;color:var(--text-muted,#64748b);margin:0}";
    (document.head || document.documentElement).appendChild(st);
  }

  class UserBadge extends HTMLElement {
    connectedCallback() {
      this.render();
    }
    render() {
      var key = this.getAttribute("portal");
      var cfg = PORTALS[key] || PORTALS[portalFromPage()];
      var user = readUser();
      var name = (cfg.useUserName && user && (user.fullName || user.email)) || cfg.title;

      this.textContent = "";
      var box = document.createElement("div");
      box.className = "user-profile";

      var avatar = document.createElement("div");
      avatar.className = "user-avatar";
      avatar.id = "topbarUserAvatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = cfg.useUserName ? initialsFromName(name, cfg.fallbackInitials) : cfg.fallbackInitials;

      var text = document.createElement("div");
      text.className = "ub-text";
      var nameEl = document.createElement("p");
      nameEl.className = "ub-name";
      nameEl.id = "topbarUserName";
      nameEl.textContent = name;
      var roleEl = document.createElement("p");
      roleEl.className = "ub-role";
      roleEl.id = "topbarUserRole";
      roleEl.textContent = cfg.subtitle;

      text.appendChild(nameEl);
      text.appendChild(roleEl);
      box.appendChild(avatar);
      box.appendChild(text);
      this.appendChild(box);
    }
  }

  if (!customElements.get("user-badge")) customElements.define("user-badge", UserBadge);
  window.SB_USER_BADGE = {
    refresh: function () {
      document.querySelectorAll("user-badge").forEach(function (el) { el.render(); });
    }
  };
})();