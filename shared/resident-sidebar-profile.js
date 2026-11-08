(function applyResidentSidebarProfile(global) {
  function initialsFromFullName(fullName) {
    const s = String(fullName || "").trim();
    if (!s) return "";
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const a = parts[0][0] || "";
      const b = parts[parts.length - 1][0] || "";
      return (a + b).toUpperCase();
    }
    const one = parts[0] || "";
    const letter = one[0] || "";
    return (letter + letter).toUpperCase();
  }

  function initialsFromEmail(email) {
    const local = String(email || "").split("@")[0] || "";
    if (local.length >= 2) return local.slice(0, 2).toUpperCase();
    if (local.length === 1) return (local + local).toUpperCase();
    return "?";
  }

  function initialsForUser(user) {
    const full = String(user?.fullName || "").trim();
    if (full) return initialsFromFullName(full);
    return initialsFromEmail(user?.email || "");
  }

  function displayNameForUser(user) {
    if (!user) return "Resident";
    const n = String(user.fullName || "").trim();
    if (n) return n;
    const e = String(user.email || "").trim();
    return e || "Resident";
  }

  function bustUrl(u) {
    const s = String(u || "").trim();
    if (!s) return "";
    const q = s.includes("?") ? "&" : "?";
    return `${s}${q}cb=${Date.now()}`;
  }

  function resolveFileUrl(url) {
    const u = String(url || "").trim();
    if (!u) return u;
    const base = String(global.API_BASE_URL || "https://serbisyoburgos-ver-26.onrender.com").replace(/\/$/, "");
    const absolute = /^https?:\/\//i.test(u) ? u : `${base}${u.startsWith("/") ? "" : "/"}${u}`;
    try {
      const token = global.getResidentAccessToken?.();
      if (!token) return absolute;
      const sep = absolute.includes("?") ? "&" : "?";
      return `${absolute}${sep}access_token=${encodeURIComponent(token)}`;
    } catch (_e) {
      return absolute;
    }
  }

  function applySidebarAvatar(avatarEl, avatarUrl, user) {
    if (!avatarEl) return;
    const u = resolveFileUrl(avatarUrl);
    if (u) {
      const urlWithBust = bustUrl(u);
      avatarEl.style.backgroundImage = "url(" + JSON.stringify(urlWithBust) + ")";
      avatarEl.style.backgroundSize = "cover";
      avatarEl.style.backgroundPosition = "center";
      avatarEl.textContent = "";
      avatarEl.style.color = "transparent";
      avatarEl.style.border = "2px solid rgba(255, 255, 255, 0.45)";
      avatarEl.setAttribute("aria-label", "Profile photo");
    } else {
      avatarEl.style.backgroundImage = "";
      avatarEl.style.backgroundSize = "";
      avatarEl.style.backgroundPosition = "";
      avatarEl.style.border = "";
      avatarEl.removeAttribute("aria-label");
      let initials = initialsForUser(user);
      if (!initials || initials === "?") initials = "R";
      avatarEl.textContent = initials.slice(0, 2);
      avatarEl.style.color = "";
    }
  }

  async function hydrateUserFromContext() {
    const baseRaw = String(global.API_BASE_URL || "https://serbisyoburgos-ver-26.onrender.com").replace(/\/$/, "");
    try {
      const raw = global.sessionStorage.getItem("residentAuth");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const token = parsed?.session?.accessToken;
      if (typeof token !== "string" || !token.length) return;

      const res = await global.fetch(`${baseRaw}/resident/context`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) return;

      const prev = parsed.user || {};
      parsed.user = {
        ...prev,
        email: data.email != null ? data.email : prev.email,
        fullName: data.fullName != null ? data.fullName : prev.fullName,
        avatarUrl: data.avatarUrl !== undefined ? data.avatarUrl : prev.avatarUrl
      };
      global.sessionStorage.setItem("residentAuth", JSON.stringify(parsed));
    } catch (_e) {
      /* offline or blocked */
    }
  }

  function applyVisual() {
    const avatarEl =
      global.document.getElementById("residentSidebarAvatar") ||
      global.document.getElementById("sidebarUserAvatar");
    const nameEl =
      global.document.getElementById("residentSidebarName") ||
      global.document.getElementById("sidebarUserName");
    if (!avatarEl && !nameEl) return;

    let user = null;
    try {
      const raw = global.sessionStorage.getItem("residentAuth");
      if (raw) {
        const parsed = JSON.parse(raw);
        user = parsed?.user || null;
      }
    } catch (_e) {
      user = null;
    }

    const display = displayNameForUser(user);
    if (nameEl) nameEl.textContent = display;
    applySidebarAvatar(avatarEl, user?.avatarUrl, user);

    const welcomeEl = global.document.getElementById("residentWelcomeHeading");
    if (welcomeEl && user) {
      welcomeEl.textContent = `Welcome, ${display}!`;
    }
  }

  /** @param {{ skipHydrate?: boolean }} [options] */
  async function apply(options) {
    if (!options?.skipHydrate) {
      await hydrateUserFromContext();
    }
    applyVisual();
  }

  global.applyResidentSidebarProfile = apply;

  const scheduleApply = () => {
    void apply();
  };

  if (global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", scheduleApply);
  } else {
    scheduleApply();
  }
})(window);