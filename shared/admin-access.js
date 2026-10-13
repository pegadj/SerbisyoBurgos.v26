(function initAdminAccess(globalScope) {
  function resolveApiBaseUrl() {
    var raw =
      typeof globalScope.API_BASE_URL === "string" && globalScope.API_BASE_URL.trim()
        ? globalScope.API_BASE_URL.trim()
        : "https://sb-draft1.onrender.com";
    return raw.replace(/\/$/, "");
  }

  var routes = globalScope.APP_ROUTES || {};
  var fallbackLogin = "../admin-login.html";
  var loginRoute =
    (routes.staff && routes.staff.login) ||
    (routes.admin && routes.admin.login) ||
    (routes.systemAdmin && routes.systemAdmin.login) ||
    fallbackLogin;

  var roleHomes = {
    staff: (routes.staff && routes.staff.dashboard) || "../staff/staff-dashboard.html",
    admin: (routes.admin && routes.admin.dashboard) || "../admin/service-mngmt.html",
    "system-admin": (routes.systemAdmin && routes.systemAdmin.dashboard) || "../system-admin/sysad-dashboard.html"
  };

  var _refreshTimerId = null;

  function parseSession() {
    try {
      var raw = sessionStorage.getItem("adminAuth");
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.user || !parsed.session) return null;
      return parsed;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Validate the session purely client-side using the stored expiresAt timestamp.
   * Returns true if the token is still valid (not expired).
   * No network call needed — expiresAt came from the signed Supabase response at login.
   */
  function isTokenValid(auth) {
    var expiresAt = auth && auth.session && auth.session.expiresAt;
    if (!expiresAt) return true; // No expiry stored — assume valid, refresh will handle it
    var nowSec = Math.floor(Date.now() / 1000);
    return expiresAt > nowSec;
  }

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  async function fetchWithRetry(url, options, retries, baseDelayMs) {
    retries = retries !== undefined ? retries : 3;
    baseDelayMs = baseDelayMs !== undefined ? baseDelayMs : 2000;
    for (var attempt = 0; attempt <= retries; attempt++) {
      try {
        var res = await fetch(url, options);
        if (res.status === 401 || res.status === 403) return res;
        if (!res.ok && attempt < retries) {
          await sleep(baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        return res;
      } catch (_netErr) {
        if (attempt < retries) {
          await sleep(baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw _netErr;
      }
    }
  }

  async function doRefresh(auth) {
    var refreshToken = auth && auth.session && auth.session.refreshToken;
    if (!refreshToken) return null;
    try {
      var response = await fetchWithRetry(
        resolveApiBaseUrl() + "/auth/admin/refresh",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: refreshToken })
        }
      );
      if (!response.ok) return null;
      var result = await response.json();
      if (!result.ok || !result.session || !result.session.accessToken) return null;
      var updated = {
        user: result.user || auth.user,
        session: {
          accessToken: result.session.accessToken,
          refreshToken: result.session.refreshToken || refreshToken,
          expiresAt: result.session.expiresAt
        }
      };
      sessionStorage.setItem("adminAuth", JSON.stringify(updated));
      return updated;
    } catch (_e) {
      return null;
    }
  }

  async function refreshSessionIfNeeded(auth) {
    if (isTokenValid(auth)) return auth; // Token still good — nothing to do
    // Token expired or close to expiry — refresh it
    var refreshed = await doRefresh(auth);
    return refreshed; // null = refresh failed = force login
  }

  /**
   * Background timer: refreshes the token 2 minutes before it expires
   * so the user is never interrupted while sitting on a page.
   */
  function scheduleBackgroundRefresh(auth) {
    if (_refreshTimerId) {
      clearTimeout(_refreshTimerId);
      _refreshTimerId = null;
    }
    var expiresAt = auth && auth.session && auth.session.expiresAt;
    if (!expiresAt || !(auth.session && auth.session.refreshToken)) return;

    var nowSec = Math.floor(Date.now() / 1000);
    // Fire 2 minutes before expiry, minimum 30 seconds from now
    var msUntilRefresh = Math.max((expiresAt - nowSec - 120) * 1000, 30000);

    _refreshTimerId = setTimeout(async function() {
      var currentAuth = parseSession();
      if (!currentAuth) return;
      var refreshed = await doRefresh(currentAuth);
      if (!refreshed) {
        globalScope.location.href = loginRoute;
        return;
      }
      scheduleBackgroundRefresh(refreshed);
    }, msUntilRefresh);
  }

  function redirectToLogin() {
    globalScope.location.href = loginRoute;
  }

  function redirectToHome(role) {
    globalScope.location.href = roleHomes[role] || loginRoute;
  }

  /**
   * Validate the current session for a required role.
   * Does NOT call the backend on every page load — validates locally via expiresAt.
   * Backend is only called at login (already done) and for token refresh.
   */
  async function requireRole(requiredRole) {
    var auth = parseSession();
    if (!auth) { redirectToLogin(); return null; }

    var user = auth.user;
    if (!user || user.role !== requiredRole) {
      redirectToHome(user && user.role);
      return null;
    }

    // Refresh if token is expired
    auth = await refreshSessionIfNeeded(auth);
    if (!auth) { redirectToLogin(); return null; }

    var accessToken = auth.session && auth.session.accessToken;
    if (!accessToken) { redirectToLogin(); return null; }

    // Start background refresh timer to keep the token alive
    scheduleBackgroundRefresh(auth);

    // Maintenance check (admin only, not system-admin) — fire-and-forget style,
    // only redirect if confirmed maintenance, never redirect on network failure
    if (requiredRole !== "system-admin") {
      try {
        var env = "production";
        if (globalScope.SB_MAINTENANCE && globalScope.SB_MAINTENANCE.fetchPortalEnvironment) {
          env = await globalScope.SB_MAINTENANCE.fetchPortalEnvironment();
        }
        if (env === "maintenance") {
          var target =
            (globalScope.SB_MAINTENANCE && globalScope.SB_MAINTENANCE.maintenancePageHref && globalScope.SB_MAINTENANCE.maintenancePageHref()) ||
            (globalScope.APP_ROUTES && globalScope.APP_ROUTES.common && globalScope.APP_ROUTES.common.maintenance) ||
            "../maintenance.html";
          globalScope.location.href = target;
          return null;
        }
      } catch (_e) {
        // Network failure on maintenance check = assume production, never redirect to login
      }
    }

    return auth;
  }

  globalScope.SB_ADMIN_ACCESS = { loginRoute: loginRoute, roleHomes: roleHomes, requireRole: requireRole };
})(window);