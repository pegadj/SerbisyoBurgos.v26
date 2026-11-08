/**
 * Reads public portal environment and resolves maintenance page URL.
 * Include after shared/routes.js when using SB_MAINTENANCE.
 */
(function initMaintenanceCheck(globalScope) {
  const API_BASE_URL = (typeof window.API_BASE_URL === "string" && window.API_BASE_URL.trim()) || "https://serbisyoburgos-ver-26.onrender.com";

  async function fetchPortalEnvironment() {
    try {
      const response = await globalScope.fetch(`${API_BASE_URL}/public/system-status`);
      const json = await response.json().catch(() => ({}));
      return json?.environment === "maintenance" ? "maintenance" : "production";
    } catch (_err) {
      return "production";
    }
  }

  function maintenancePageHref() {
    const fromRoutes = globalScope.APP_ROUTES?.common?.maintenance;
    if (fromRoutes) return fromRoutes;
    const pathname = String(globalScope.location?.pathname || "").replace(/\\/g, "/").toLowerCase();
    if (
      pathname.includes("/resident/") ||
      pathname.includes("/admin/") ||
      pathname.includes("/staff/") ||
      pathname.includes("/system-admin/")
    ) {
      return "../maintenance.html";
    }
    return "maintenance.html";
  }

  /** After staff session is verified (role staff), redirect if portal is in maintenance. */
  async function redirectStaffPortalFromMaintenanceIfNeeded() {
    const env = await fetchPortalEnvironment();
    if (env !== "maintenance") return false;
    globalScope.location.href = maintenancePageHref();
    return true;
  }

  globalScope.SB_MAINTENANCE = {
    fetchPortalEnvironment,
    maintenancePageHref,
    redirectStaffPortalFromMaintenanceIfNeeded
  };
})(window);