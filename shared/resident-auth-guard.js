(function initResidentPortalGuard(globalScope) {
  const STORAGE_KEY = "residentAuth";
  const BLOCKED_LOGIN_MESSAGE_KEY = "residentPortalBlockedReason";

  function loginHref() {
    return globalScope.APP_ROUTES?.resident?.login || "../resident-login.html";
  }

  function maintenanceHref() {
    return (
      globalScope.SB_MAINTENANCE?.maintenancePageHref?.() ||
      globalScope.APP_ROUTES?.common?.maintenance ||
      "../maintenance.html"
    );
  }

  function readAccessToken() {
    try {
      const raw = globalScope.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const token = parsed?.session?.accessToken;
      return typeof token === "string" && token.length > 0 ? token : null;
    } catch (_err) {
      return null;
    }
  }

  async function guard() {
    if (!readAccessToken()) {
      globalScope.location.href = loginHref();
      return;
    }
    try {
      let env = "production";
      if (globalScope.SB_MAINTENANCE?.fetchPortalEnvironment) {
        env = await globalScope.SB_MAINTENANCE.fetchPortalEnvironment();
      } else {
        const response = await globalScope.fetch("https://sb-draft1.onrender.com/public/system-status");
        const json = await response.json().catch(() => ({}));
        if (json?.environment === "maintenance") env = "maintenance";
      }
      if (env === "maintenance") {
        globalScope.location.href = maintenanceHref();
      }
    } catch (_err) {
      /* fail open: allow portal if status check fails */
    }
  }

  globalScope.getResidentAccessToken = readAccessToken;
  globalScope.residentApiHeaders = function residentApiHeaders() {
    const token = readAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  globalScope.residentApiFetch = async function residentApiFetch(url, options) {
    const opts = options && typeof options === "object" ? { ...options } : {};
    opts.headers = { ...globalScope.residentApiHeaders(), ...(opts.headers || {}) };
    const response = await globalScope.fetch(url, opts);
    if (response.status === 403) {
      try {
        const payload = await response.clone().json();
        const msg = String(payload?.message || "");
        if (msg.includes("Your account is suspended") || msg.includes("Your account is deactivated")) {
          globalScope.sessionStorage.removeItem(STORAGE_KEY);
          globalScope.sessionStorage.removeItem("residentContext");
          globalScope.sessionStorage.setItem(BLOCKED_LOGIN_MESSAGE_KEY, msg);
          globalScope.location.href = loginHref();
          return response;
        }
      } catch (_e) {
        /* not JSON or unreadable */
      }
    }
    if (response.status === 401) {
      try {
        globalScope.sessionStorage.removeItem(STORAGE_KEY);
        globalScope.sessionStorage.removeItem("residentContext");
      } catch (_e) {
        /* ignore */
      }
      globalScope.location.href = loginHref();
    }
    return response;
  };

  globalScope.residentSseUrl = function residentSseUrl(urlPath) {
    const token = readAccessToken();
    if (!token) return urlPath;
    const joiner = urlPath.includes("?") ? "&" : "?";
    return `${urlPath}${joiner}access_token=${encodeURIComponent(token)}`;
  };

  function scheduleGuard() {
    void guard();
  }

  if (globalScope.document.readyState === "loading") {
    globalScope.document.addEventListener("DOMContentLoaded", scheduleGuard);
  } else {
    scheduleGuard();
  }
})(window);
