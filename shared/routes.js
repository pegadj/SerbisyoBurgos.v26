(function initRouteMap(globalScope) {
  function normalizePathname(pathname) {
    return String(pathname || "").replace(/\\/g, "/").toLowerCase();
  }

  function computeRootPrefix(pathname) {
    const normalized = normalizePathname(pathname);
    if (
      normalized.includes("/resident/") ||
      normalized.includes("/staff/") ||
      normalized.includes("/admin/") ||
      normalized.includes("/system-admin/")
    ) {
      return "../";
    }
    return "";
  }

  const normalizedPath = normalizePathname(globalScope.location?.pathname);
  const rootPrefix = computeRootPrefix(globalScope.location?.pathname);
  const inResidentFolder = normalizedPath.includes("/resident/");
  const residentFolderPrefix = inResidentFolder ? "" : "resident/";

  const ROUTES = {
    common: {
      landing: `${rootPrefix}index.html`,
      maintenance: `${rootPrefix}maintenance.html`
    },
    entry: {
      residentLogin: `${rootPrefix}resident-login.html`,
      staffLogin: `${rootPrefix}admin-login.html`
    },
    staff: {
      login: `${rootPrefix}admin-login.html`,
      dashboard: `${rootPrefix}staff/staff-dashboard.html`
    },
admin: {
      login: `${rootPrefix}admin-login.html`,
      dashboard: `${rootPrefix}admin/service-mngmt.html`
    },
    systemAdmin: {
      login: `${rootPrefix}admin-login.html`,
      dashboard: `${rootPrefix}system-admin/sysad-dashboard.html`
    },
    resident: {
      login: `${rootPrefix}resident-login.html`,
      dashboard: `${residentFolderPrefix}dashboard.html`,
      serviceRequests: `${residentFolderPrefix}service-requests.html`,
      appointments: `${residentFolderPrefix}appointments.html`,
      notifications: `${residentFolderPrefix}notifications.html`,
      requestHistory: `${residentFolderPrefix}request-history.html`
    }
  };

  function logout() {
    sessionStorage.removeItem("adminAuth");
    sessionStorage.removeItem("residentAuth");
    sessionStorage.removeItem("selectedRequest");
    localStorage.removeItem("adminAuth");
    localStorage.removeItem("residentAuth");
    globalScope.location.href = ROUTES.common.landing;
  }

  globalScope.APP_ROUTES = ROUTES;
  globalScope.APP_NAV = { logout };

  function inferApiBaseUrl() {
    try {
      const href = globalScope.location?.href;
      if (!href || href.startsWith("file:")) return "https://sb-draft1.onrender.com";
      const u = new URL(href);
      // localhost / 127.0.0.1 / private IPs = local dev, use :4000
      const isLocal =
        u.hostname === "localhost" ||
        u.hostname === "127.0.0.1" ||
        u.hostname.startsWith("192.168.") ||
        u.hostname.startsWith("10.");
      if (isLocal) {
        return `${u.protocol}//${u.hostname}:4000`;
      }
    } catch (_e) {
      /* ignore */
    }
    // Any other host (Vercel, Render, custom domain) → use the real backend
    return "https://sb-draft1.onrender.com";
  }

  const existingApi = typeof globalScope.API_BASE_URL === "string" ? globalScope.API_BASE_URL.trim() : "";
  if (!existingApi) {
    globalScope.API_BASE_URL = inferApiBaseUrl();
  }
})(window);