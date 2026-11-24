require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const crypto = require("crypto");
const { connectPg, pool } = require("./config/pgClient");
const { isValidId } = require("./db/engine");
const {
  verifyAccessToken,
  verifyRefreshToken,
  signAccessToken,
  signRefreshToken,
  hashPassword,
  verifyPassword
} = require("./config/auth");
const { User } = require("./models/User");
const { isSmsConfigured, normalizePhNumber, sendSmsBatch } = require("./config/sms");
const { CATEGORY, storeFile, deleteFile, streamFile } = require("./config/upload");
const { ServiceCatalog } = require("./models/ServiceCatalog");
const CommunityAnnouncement = require("./models/CommunityAnnouncement");
const AnnouncementDraft = require("./models/AnnouncementDraft");
const { FaqEntry } = require("./models/FaqEntry");
const {
  askChatbot,
  isAiConfigured,
  OFF_TOPIC_REPLY,
  NOT_COVERED_REPLY
} = require("./services/chatbot");
const AppointmentPurposeCatalog = require("./models/AppointmentPurposeCatalog");
const PortalAuditEvent = require("./models/PortalAuditEvent");
const SmsLog = require("./models/SmsLog");
const { AuthAuditEvent } = require("./models/AuthAuditEvent");
const { PasswordResetCode } = require("./models/PasswordResetCode");
const AppointmentSlot = require("./models/AppointmentSlot");
const AppointmentSlotOverride = require("./models/AppointmentSlotOverride");
const { Appointment, APPOINTMENT_STATUSES } = require("./models/Appointment");
const { ServiceRequest, SERVICE_REQUEST_STATUSES } = require("./models/ServiceRequest");
const { SystemSettings, SINGLETON_ID } = require("./models/SystemSettings");
const { AnimalRecord, ANIMAL_SPECIES } = require("./models/AnimalRecord");

let intentionalShutdown = false;

process.on("uncaughtException", (err) => {
  console.error("[backend] uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[backend] unhandledRejection:", reason);
  process.exit(1);
});

process.on("beforeExit", () => {
  if (intentionalShutdown) return;
  console.warn(
    "[backend] beforeExit — event loop is draining. If the server should still be running, something may have called process.exit() or left no active handles."
  );
});

process.on("exit", (code) => {
  if (!intentionalShutdown) {
    console.warn("[backend] process exit with code", code);
  }
});

const app = express();
const port = Number(process.env.PORT) || 4000;

// The API runs behind a hosting proxy (Render). Trust exactly one proxy hop so req.ip is the real visitor's
// address. Without this every visitor shares the proxy's address, so the rate limits below would count
// everyone together (one person could lock everybody out). Set TRUST_PROXY=0 when running with no proxy.
app.set("trust proxy", process.env.TRUST_PROXY === "0" ? false : Number(process.env.TRUST_PROXY) || 1);

// Content-Security-Policy for the API. The API only returns JSON, CSV and file downloads (never web pages),
// so it can be locked down completely: if one of these responses were ever opened as a page, nothing in it
// could run, load anything, or be framed by another site. /files/:id is skipped because it streams the
// images and PDFs the portal displays from another origin.
// The portal's own HTML pages are static files on a different host; their policy is the <meta> tag in each page.
const apiContentSecurityPolicy = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"]
  }
});
app.use((req, res, next) => (req.path.startsWith("/files/") ? next() : apiContentSecurityPolicy(req, res, next)));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: (() => {
      const rawOrigins = process.env.CLIENT_ORIGIN;
      if (!rawOrigins) return true;
      const allowedOrigins = rawOrigins.split(",").map((origin) => origin.trim()).filter(Boolean);
      return allowedOrigins.length ? allowedOrigins : true;
    })()
  })
);
app.use(express.json({ limit: "48kb" }));

// Never send technical error text (database messages, file paths) to the browser. Many routes attach the
// raw error as `detail`; log it on the server instead and strip it from the response.
// Set EXPOSE_ERROR_DETAILS=true on a local dev machine to see it in responses while debugging.
app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === "object" && !Array.isArray(body) && "detail" in body) {
      const { detail, ...safeBody } = body;
      if (detail) console.error(`[api-error] ${req.method} ${req.path} -> ${res.statusCode}: ${detail}`);
      return sendJson(process.env.EXPOSE_ERROR_DETAILS === "true" && process.env.NODE_ENV !== "production" ? body : safeBody);
    }
    return sendJson(body);
  };
  next();
});

// ---------------------------------------------------------------------------
// Maintenance mode enforcement.
// While the portal environment is "maintenance", only system administrators may
// use the API. Everyone else gets 503 { maintenance: true }. A few routes stay
// open so system admins can still sign in and so pages can ask "is it down?":
// health, /public/*, admin login/refresh, and the session-authorize checks.
// Fails OPEN: if the setting can't be read, the portal stays available.
// ---------------------------------------------------------------------------
const MAINTENANCE_MESSAGE =
  "The portal is under maintenance. Please try again later.";
const MAINTENANCE_CACHE_MS = 5000;
let maintenanceEnvCache = { value: "production", at: 0 };

async function getPortalEnvironmentCached() {
  if (Date.now() - maintenanceEnvCache.at < MAINTENANCE_CACHE_MS) return maintenanceEnvCache.value;
  const value = await getPortalEnvironmentFromDb();
  maintenanceEnvCache = { value, at: Date.now() };
  return value;
}

function isMaintenanceExemptPath(path) {
  return (
    path === "/health" ||
    path.startsWith("/public/") ||
    path === "/auth/login" ||
    path === "/auth/admin/login" ||
    path === "/auth/admin/refresh" ||
    path.startsWith("/auth/admin/authorize/") ||
    path === "/auth/resident/authorize"
  );
}

async function enforceMaintenanceMode(req, res, next) {
  try {
    if (req.method === "OPTIONS") return next();
    const env = await getPortalEnvironmentCached();
    if (env !== "maintenance" || isMaintenanceExemptPath(req.path)) return next();

    const token = getBearerToken(req) || String(req.query?.access_token || "").trim();
    if (token) {
      try {
        const payload = verifyAccessToken(token);
        if (payload?.role === "system-admin") return next();
      } catch (_err) {
        // invalid/expired token: treat like any other non-system-admin caller
      }
    }
    return res.status(503).json({ ok: false, maintenance: true, message: MAINTENANCE_MESSAGE });
  } catch (error) {
    console.error("[maintenance] check failed, allowing request:", error.message);
    return next();
  }
}
app.use(enforceMaintenanceMode);

const authResidentRegisterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many registration attempts. Please try again later." }
});

const authResidentLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many login attempts. Please try again later." }
});

/**
 * Counts only FAILED sign-ins per visitor address, so people who log in correctly never use it up.
 * Works together with the per-account lockout below (that one stops a password being guessed from many addresses).
 */
const loginFailureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many failed sign-in attempts. Please try again in 15 minutes." }
});

/** Wrong passwords allowed before an account is locked, and for how long. */
const MAX_FAILED_LOGINS = 5;
const LOGIN_LOCK_MINUTES = 15;
/** Failed attempts older than this no longer count towards the lock. */
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

function isLoginLocked(userDoc) {
  return Boolean(userDoc?.lockedUntil) && new Date(userDoc.lockedUntil).getTime() > Date.now();
}

function loginLockedResponse(userDoc) {
  const minutes = Math.max(1, Math.ceil((new Date(userDoc.lockedUntil).getTime() - Date.now()) / 60000));
  return {
    ok: false,
    locked: true,
    message: `Too many failed sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
  };
}

/** Records a wrong password. Returns true when this attempt locked the account. */
async function registerFailedLogin(userDoc, req) {
  try {
    const now = Date.now();
    const last = userDoc.lastFailedLoginAt ? new Date(userDoc.lastFailedLoginAt).getTime() : 0;
    const previous = now - last > FAILED_LOGIN_WINDOW_MS ? 0 : Number(userDoc.failedLoginCount || 0);
    const count = previous + 1;
    if (count >= MAX_FAILED_LOGINS) {
      const lockedUntil = new Date(now + LOGIN_LOCK_MINUTES * 60 * 1000);
      await User.updateOne({ _id: userDoc._id }, { $set: { failedLoginCount: 0, lastFailedLoginAt: new Date(now), lockedUntil } });
      userDoc.lockedUntil = lockedUntil;
      void insertAuthAuditEvent({ action: "account_locked", email: userDoc.email, role: userDoc.role, req });
      return true;
    }
    await User.updateOne({ _id: userDoc._id }, { $set: { failedLoginCount: count, lastFailedLoginAt: new Date(now) } });
  } catch (error) {
    console.warn("[login-lock] could not record failed sign-in:", error?.message || error);
  }
  return false;
}

/** A correct password (or a staff password reset) clears the counter and any lock. */
async function clearFailedLogins(userDoc) {
  if (!userDoc || !(Number(userDoc.failedLoginCount) > 0 || userDoc.lockedUntil)) return;
  try {
    await User.updateOne({ _id: userDoc._id }, { $set: { failedLoginCount: 0, lockedUntil: null } });
  } catch (error) {
    console.warn("[login-lock] could not clear failed sign-ins:", error?.message || error);
  }
}

const residentChangePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many password change attempts. Please try again later." }
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many requests. Please try again in a few minutes or visit the barangay hall." }
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many attempts. Please try again in a few minutes or visit the barangay hall." }
});

const residentAvatarUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many profile photo uploads. Please try again later." }
});

const RESIDENT_AVATAR_BUCKET = "resident-avatars";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const RESIDENT_ID_BUCKET = "resident-identity-documents";
const MAX_ID_DOC_BYTES = 10 * 1024 * 1024;

const residentRegisterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ID_DOC_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "application/pdf"].includes(String(file.mimetype || ""));
    cb(ok ? null : new Error("INVALID_ID_MIME"), ok);
  }
});

const residentAvatarRawBodyParser = express.raw({
  limit: "5mb",
  type: ["image/jpeg", "image/png", "image/webp", "image/gif", "application/octet-stream"]
});

const residentImportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many import requests. Please wait a few minutes and try again." }
});

const adminStaffCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many Barangay Secretary account creation attempts. Please try again later." }
});

const faqSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many FAQ searches. Please try again later." }
});

const faqChatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many chat messages. Please try again later." }
});

const adminAnalyticsDecisionInsightLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 24,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many decision-insight requests. Please try again later." }
});

// NOTE: this file previously set up two Supabase clients here
// (supabaseAdmin, supabaseAuth) plus hasSupabaseServiceRoleKey() and
// createResidentProfilesDbClient() helpers built around them. As of this
// point in the migration, nothing in the app calls any of the four —
// every route now runs on PostgreSQL/JWT (see src/config/pgClient.js,
// src/config/auth.js, src/models/). Removed rather than left as unused
// dead code.

const requestEventClients = new Set();
const appointmentEventClients = new Set();
const announcementEventClients = new Set();

const MAX_EMAIL_LEN = 254;
const MAX_FULL_NAME_LEN = 120;
const MAX_NAME_PART_LEN = 60; // first / middle / last name (matches the resident profile fields)
const MAX_PASSWORD_LEN = 128;

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, MAX_EMAIL_LEN);
}

/** Return image/* mime from magic bytes, or null if unsupported. */
function sniffImageMimeFromBuffer(buf) {
  if (!buf || buf.length < 12) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const b2 = buf[2];
  const b3 = buf[3];
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return "image/jpeg";
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return "image/png";
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) return "image/gif";
  const riff = buf.toString("ascii", 0, 4);
  const webp = buf.toString("ascii", 8, 12);
  if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  return null;
}

/** JPEG, PNG, or PDF (magic bytes); used for identity verification uploads. */
function sniffIdentityDocumentMime(buf) {
  if (!buf || buf.length < 5) return null;
  const ascii5 = buf.toString("ascii", 0, 5);
  if (ascii5.startsWith("%PDF")) return "application/pdf";
  const img = sniffImageMimeFromBuffer(buf);
  if (img === "image/jpeg" || img === "image/png") return img;
  return null;
}

function isValidEmailFormat(email) {
  if (!email || email.length > MAX_EMAIL_LEN) return false;
  const basic =
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
  return basic.test(String(email).trim());
}

function sanitizeFullNameForStorage(raw) {
  let s = String(raw || "")
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, "");
  if (s.length > MAX_FULL_NAME_LEN) s = s.slice(0, MAX_FULL_NAME_LEN);
  s = s.replace(/[<>]/g, "");
  return s.trim();
}

/**
 * DB value: pending | active | suspended | deactivated | rejected.
 * - active: resident may log in and use the resident portal normally.
 * - pending | rejected | suspended | deactivated: login and resident portal APIs are blocked
 *   (see residentPortalAccountBlockMessage). New self-registered residents start as "pending"
 *   until an administrator approves them (sets "active").
 */
function normalizeAccountStatusFromInput(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "pending approval") return "pending";
  if (s === "active" || s === "suspended" || s === "deactivated" || s === "pending" || s === "rejected") return s;
  return null;
}

function mapAccountStatusToUiLabel(dbValue) {
  const s = String(dbValue ?? "active")
    .trim()
    .toLowerCase();
  if (s === "pending") return "Pending Approval";
  if (s === "rejected") return "Rejected";
  if (s === "suspended") return "Suspended";
  if (s === "deactivated") return "Deactivated";
  return "Active";
}

/** If resident is not active, return login/API error message; active residents get null (full portal access). */
function residentPortalAccountBlockMessage(accountStatusRaw) {
  const s = String(accountStatusRaw ?? "active")
    .trim()
    .toLowerCase();
  if (s === "pending") {
    return "Your account is still pending approval by the barangay office. You will be able to log in once it has been approved.";
  }
  if (s === "rejected") {
    return "Your registration was not approved. Please visit the barangay hall for assistance.";
  }
  if (s === "suspended") return "Your account is suspended.";
  if (s === "deactivated") {
    return "Your account is deactivated. Please visit the barangay hall if you wish to activate your account.";
  }
  return null;
}

const STAFF_PERMISSION_KEYS = ["dashboard", "appointmentScheduling", "requestProcessing", "documentGenerator", "residentProfiling"];

function defaultStaffPermissionsAllTrue() {
  return {
    dashboard: true,
    appointmentScheduling: true,
    requestProcessing: true,
    documentGenerator: true,
    residentProfiling: true
  };
}

function normalizeStaffPermissionsFromDb(raw) {
  const base = defaultStaffPermissionsAllTrue();
  if (!raw || typeof raw !== "object") return base;
  for (const k of STAFF_PERMISSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) {
      base[k] = Boolean(raw[k]);
    }
  }
  return base;
}

function normalizeStaffPermissionsFromBody(body) {
  const src = body && typeof body === "object" ? body : {};
  const out = {
    dashboard: false,
    appointmentScheduling: false,
    requestProcessing: false,
    documentGenerator: false,
    residentProfiling: false
  };
  for (const k of STAFF_PERMISSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      out[k] = Boolean(src[k]);
    }
  }
  return out;
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

async function resolveProfileFromToken(req) {
  const token = getBearerToken(req);
  if (!token) {
    return { error: { status: 401, message: "Missing bearer token." } };
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return { error: { status: 401, message: "Invalid or expired session token." } };
  }

  // Re-fetch from the DB rather than trusting the token payload alone —
  // role/account_status can change between token issuance and this
  // request (e.g. an admin suspends the account mid-session), same
  // reasoning as the old getUser()-per-request pattern.
  const userDoc = await User.findOne({ email: payload.email }).lean();

  if (!userDoc) {
    return { error: { status: 403, message: "Profile record not found." } };
  }

  if (userDoc.role === "resident" || userDoc.role === "staff") {
    const blockMsg = residentPortalAccountBlockMessage(userDoc.accountStatus);
    if (blockMsg) {
      return { error: { status: 403, message: blockMsg } };
    }
  }

  // Shape kept identical to the old Supabase-backed profile object
  // (snake_case keys) so every downstream route reading profile.full_name,
  // profile.account_status, etc. keeps working unchanged during the
  // incremental Phase 3 rewrite — this can be flattened to camelCase once
  // every route referencing `profile` has been migrated.
  const profile = {
    email: userDoc.email,
    full_name: userDoc.fullName,
    role: userDoc.role,
    contact_number: userDoc.contactNumber,
    avatar_url: userDoc.avatarFileId ? `/files/${userDoc.avatarFileId}` : null,
    account_status: userDoc.accountStatus,
    sms_opt_out: Boolean(userDoc.smsOptOut),
    resident_id: userDoc.residentId || null,
    must_change_password: Boolean(userDoc.mustChangePassword),
  };

  return { profile, authUserId: String(userDoc._id) };
}

// ---- Barangay-issued resident accounts (Resident ID + password) ----
const PLACEHOLDER_EMAIL_DOMAIN = "@residents.serbisyoburgos.local";

function normalizeResidentId(raw) {
  const v = String(raw || "").trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{3,19}$/.test(v) ? v : "";
}

function placeholderResidentEmail(residentId) {
  return `${String(residentId).toLowerCase()}${PLACEHOLDER_EMAIL_DOMAIN}`;
}

function isPlaceholderResidentEmail(email) {
  return String(email || "").toLowerCase().endsWith(PLACEHOLDER_EMAIL_DOMAIN);
}

async function generateResidentId() {
  // Atomic: concurrent requests can never receive the same number (db/migrations/001_schema.sql).
  const { rows } = await pool.query("SELECT nextval('resident_id_seq') AS n");
  return "SB-" + String(rows[0].n).padStart(5, "0");
}

function generateTemporaryPassword() {
  // 12 URL-safe characters, e.g. "q3Zx9_kLm2Vb"
  return crypto.randomBytes(9).toString("base64url");
}

/**
 * Default password staff-issued resident accounts get when no password is typed in:
 * the resident's last name in lowercase + "SB" + the current year, e.g. "delacruzSB2026".
 * Spaces, punctuation and accents are dropped ("Dela Cruz" -> "delacruz", "Niño" -> "nino").
 * The resident is still forced to choose their own password at first login (mustChangePassword).
 * Falls back to a random password if there is no usable last name.
 */
function residentDefaultPassword(lastName, fullNameFallback = "") {
  let source = String(lastName || "").trim();
  if (!source) {
    // no last name on file: use the last word of the full name ("Juan Dela Cruz" -> "Cruz")
    const words = String(fullNameFallback || "").trim().split(/\s+/).filter(Boolean);
    source = words.length > 1 ? words[words.length - 1] : "";
  }
  const base = source.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!base) return generateTemporaryPassword();
  let password = `${base}SB${new Date().getFullYear()}`;
  while (password.length < 8) password += "0";   // passwords must be at least 8 characters
  return password.slice(0, MAX_PASSWORD_LEN);
}

const STAFF_PORTAL_ROLES = new Set(["staff", "system-admin"]);

// A resident whose password was issued or reset by barangay personnel (staff-created account,
// password reset, admin-set password) must choose their own before using the portal. Enforced
// here, on the server, so it cannot be skipped by going around the change-password page.
// Only POST /resident/change-password (and the authorize check) are reachable until it is done.
const PASSWORD_CHANGE_REQUIRED_BODY = {
  ok: false,
  code: "PASSWORD_CHANGE_REQUIRED",
  mustChangePassword: true,
  message: "For your security, please set a new password before continuing."
};

async function requireResidentPortalUser(req, res, { allowPasswordChangePending = false } = {}) {
  const { profile, authUserId, error } = await resolveProfileFromToken(req);
  if (error) {
    res.status(error.status).json({ ok: false, message: error.message });
    return null;
  }
  if (profile.role !== "resident") {
    res.status(403).json({ ok: false, message: "Resident portal access required." });
    return null;
  }
  if (profile.must_change_password && !allowPasswordChangePending) {
    res.status(403).json(PASSWORD_CHANGE_REQUIRED_BODY);
    return null;
  }
  const residentUserId = await ensureResidentUserRow(profile.email);
  if (!residentUserId) {
    res.status(500).json({ ok: false, message: "Unable to resolve resident account." });
    return null;
  }
  return { profile, residentUserId, authUserId };
}

async function requireStaffOrAuthenticatedResident(req, res) {
  const { profile, error } = await resolveProfileFromToken(req);
  if (error) {
    res.status(error.status).json({ ok: false, message: error.message });
    return null;
  }
  if (STAFF_PORTAL_ROLES.has(profile.role)) {
    return { portal: "staff", profile };
  }
  if (profile.role === "resident") {
    if (profile.must_change_password) {
      res.status(403).json(PASSWORD_CHANGE_REQUIRED_BODY);
      return null;
    }
    const residentUserId = await ensureResidentUserRow(profile.email);
    if (!residentUserId) {
      res.status(500).json({ ok: false, message: "Unable to resolve resident account." });
      return null;
    }
    return { portal: "resident", profile, residentUserId };
  }
  res.status(403).json({ ok: false, message: "Access denied." });
  return null;
}

async function validateSseAccess(req) {
  const token = getBearerToken(req) || String(req.query?.access_token || "").trim();
  if (!token) return { ok: false, status: 401, message: "Authentication required." };

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return { ok: false, status: 401, message: "Invalid or expired session token." };
  }

  const userDoc = await User.findOne({ email: payload.email }).lean();
  if (!userDoc) {
    return { ok: false, status: 403, message: "Profile record not found." };
  }
  if (userDoc.role !== "resident" && !STAFF_PORTAL_ROLES.has(userDoc.role)) {
    return { ok: false, status: 403, message: "Access denied." };
  }
  if (userDoc.role === "resident" || userDoc.role === "staff") {
    const blockMsg = residentPortalAccountBlockMessage(userDoc.accountStatus);
    if (blockMsg) {
      return { ok: false, status: 403, message: blockMsg };
    }
  }
  if (userDoc.role === "resident" && userDoc.mustChangePassword) {
    return { ok: false, status: 403, message: PASSWORD_CHANGE_REQUIRED_BODY.message };
  }
  const profile = {
    email: userDoc.email,
    full_name: userDoc.fullName,
    role: userDoc.role,
    account_status: userDoc.accountStatus
  };
  return { ok: true, profile };
}

const MAX_REQUEST_TITLE_LEN = 200;
const MAX_SERVICE_TYPE_LEN = 120;
const MAX_REQUEST_PURPOSE_LEN = 160;
const MAX_TIME_SLOT_LEN = 80;
const MAX_APPOINTMENT_PURPOSE_LEN = 200;
const MAX_STATUS_NOTE_LEN = 2000;
const MAX_ANNOUNCEMENT_TITLE_LEN = 200;
const MAX_ANNOUNCEMENT_BODY_LEN = 8000;
const MAX_ANNOUNCEMENT_CATEGORY_LEN = 80;
const MAX_FAQ_SEARCH_QUERY_LEN = 800;
const FAQ_SEARCH_MIN_SCORE = 4;
const FAQ_SEARCH_TOP_LIMIT_DEFAULT = 3;
const FAQ_SEARCH_TOP_LIMIT_MAX = 8;
const FAQ_CHAT_CONTEXT_MAX = 5;
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.3-70b-versatile was shut down by Groq on 2026-08-16. Override with GROQ_MODEL in .env if Groq changes again.
const GROQ_CHAT_DEFAULT_MODEL = "openai/gpt-oss-120b";
// gpt-oss models "reason" before answering; keep that short so replies are fast and fit inside max_tokens.
function groqReasoningParams(model) {
  return /gpt-oss/i.test(String(model || "")) ? { reasoning_effort: "low" } : {};
}
const MAX_GROQ_REPLY_CHARS = 4000;
const FAQ_SEARCH_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "see",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "use",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whose",
  "why",
  "will",
  "with",
  "you",
  "your",
  // Common Filipino fillers (queries may mix languages)
  "po",
  "opo",
  "ba",
  "lang",
  "lng",
  "ko",
  "mo",
  "na"
]);

// Stored FAQ keywords this short or this generic are ignored for substring matching (avoid ranking noise).
const FAQ_SEARCH_IGNORED_KEYWORD_SUBSTRINGS = new Set([
  "how",
  "why",
  "when",
  "who",
  "what",
  "which",
  "where",
  "there",
  "here"
]);

function sanitizePlainTextField(raw, maxLen) {
  let s = String(raw || "")
    .trim()
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s.replace(/[<>]/g, "").trim();
}

function parseLocalDateString(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

async function getAppointmentSlotCapacityForDate(slotId, dateISO) {
  const slotIdStr = String(slotId || "");
  if (!isValidId(slotIdStr)) return null;
  const safeDate = parseLocalDateString(dateISO);
  if (!safeDate) return null;

  const [slot, override] = await Promise.all([
    AppointmentSlot.findById(slotIdStr).select("defaultCapacity isActive label slotCode").lean(),
    AppointmentSlotOverride.findOne({ slotId: slotIdStr, overrideDate: safeDate })
      .select("capacityLimit")
      .lean()
  ]);

  if (!slot) return null;
  if (slot.isActive === false) return null;
  if (!isSlotWithinServiceHours(slot)) return null;   // lunch break / outside 8-5

  const overrideCap = Number(override?.capacityLimit);
  if (Number.isInteger(overrideCap) && overrideCap > 0) return overrideCap;

  const defaultCap = Number(slot.defaultCapacity);
  if (!Number.isInteger(defaultCap) || defaultCap <= 0) return null;
  return defaultCap;
}

async function countBookedAppointmentsForSlot(slotId, dateISO) {
  const slotIdStr = String(slotId || "");
  if (!isValidId(slotIdStr)) return null;
  const safeDate = parseLocalDateString(dateISO);
  if (!safeDate) return null;

  try {
    const count = await Appointment.countDocuments({
      slotId: slotIdStr,
      appointmentDate: safeDate,
      status: { $nin: ["Rejected", "Cancelled"] }
    });
    return count;
  } catch (_error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Slot open / closed state
//   Closed = staff closed it for that date, OR its start time has already passed (Philippine time).
//   Full is separate: a slot can be open but out of capacity.
// ---------------------------------------------------------------------------
/** Minutes before a slot starts when it stops accepting bookings (0 = closes when it starts). */
const SLOT_BOOKING_CUTOFF_MINUTES = Math.max(0, Number.parseInt(process.env.SLOT_BOOKING_CUTOFF_MINUTES || "0", 10) || 0);

/** Time-range text (as saved on service requests) -> slot code. Same variants the staff page understands. */
const SLOT_LABEL_PATTERNS = [
  { code: "0800", patterns: ["8:00 am - 9:00 am", "08:00 am - 09:00 am", "8:00 am - 09:00 am", "08:00 am - 9:00 am"] },
  { code: "0900", patterns: ["9:00 am - 10:00 am", "09:00 am - 10:00 am"] },
  { code: "1000", patterns: ["10:00 am - 11:00 am"] },
  { code: "1100", patterns: ["11:00 am - 12:00 pm", "11:00 am - 12:00 nn", "11:00 am - 12:00"] },
  { code: "0100", patterns: ["1:00 pm - 2:00 pm", "01:00 pm - 02:00 pm"] },
  { code: "0200", patterns: ["2:00 pm - 3:00 pm", "02:00 pm - 03:00 pm", "2:00 pm - 03:00 pm", "02:00 pm - 3:00 pm"] },
  { code: "0300", patterns: ["3:00 pm - 4:00 pm", "03:00 pm - 04:00 pm", "3:00 pm - 04:00 pm", "03:00 pm - 4:00 pm"] },
  { code: "0400", patterns: ["4:00 pm - 5:00 pm", "04:00 pm - 05:00 pm"] }
];

function slotCodeFromTimeLabel(label) {
  const normalized = String(label || "")
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\bnn\b/g, "pm")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  // "nn" was turned into "pm" above, so also try the original noon spelling.
  const withNn = String(label || "").toLowerCase().replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  for (const entry of SLOT_LABEL_PATTERNS) {
    if (entry.patterns.some((p) => normalized.includes(p) || withNn.includes(p))) return entry.code;
  }
  return null;
}

/** Current date (YYYY-MM-DD) and minutes since midnight in Philippine time. */
function nowPH() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { dateISO: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Start of a slot in minutes since midnight. Reads the label first ("01:00 PM" = 13:00). */
function slotStartMinutes(slot) {
  const label = String(slot?.label || "");
  const m = label.match(/(\d{1,2}):(\d{2})\s*(AM|PM|NN)?/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = (m[3] || "").toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    if (Number.isInteger(h) && h >= 0 && h <= 23) return h * 60 + min;
  }
  // Codes are 12-hour HHMM without AM/PM ("0100" = 1 PM). Slots run in office hours, so 1-7 means afternoon.
  const code = String(slot?.slotCode || "").replace(/\D/g, "").padStart(4, "0");
  let h = parseInt(code.slice(0, 2), 10);
  const min = parseInt(code.slice(2, 4), 10);
  if (!Number.isInteger(h)) return null;
  if (h >= 1 && h <= 7) h += 12;
  return h * 60 + (Number.isInteger(min) ? min : 0);
}

// ---------------------------------------------------------------------------
// Service hours: 8:00 AM - 5:00 PM, with a lunch break from 12:00 PM to 1:00 PM (no bookings).
// ---------------------------------------------------------------------------
const SERVICE_OPEN_MINUTES = 8 * 60;      // 8:00 AM
const SERVICE_CLOSE_MINUTES = 17 * 60;    // 5:00 PM
const LUNCH_START_MINUTES = 12 * 60;      // 12:00 PM
const LUNCH_END_MINUTES = 13 * 60;        // 1:00 PM
const SLOT_LENGTH_MINUTES = 60;

/** True when a slot sits inside service hours and does not overlap the 12:00-1:00 PM lunch break. */
function isSlotWithinServiceHours(slot) {
  const start = slotStartMinutes(slot);
  if (start === null) return false;
  const end = start + SLOT_LENGTH_MINUTES;
  if (start < SERVICE_OPEN_MINUTES || end > SERVICE_CLOSE_MINUTES) return false;
  if (start < LUNCH_END_MINUTES && end > LUNCH_START_MINUTES) return false;   // overlaps lunch
  return true;
}

/** The slots the office offers. Run at startup so existing databases get the 8 AM and 2 PM slots too. */
const SERVICE_SLOT_DEFAULTS = [
  { slotCode: "0800", label: "08:00 AM - 09:00 AM", phaseLabel: "Phase 1", isMorningPickupOnly: true, defaultCapacity: 10 },
  { slotCode: "0900", label: "09:00 AM - 10:00 AM", phaseLabel: "Phase 2", isMorningPickupOnly: true, defaultCapacity: 10 },
  { slotCode: "1000", label: "10:00 AM - 11:00 AM", phaseLabel: "Phase 3", isMorningPickupOnly: true, defaultCapacity: 10 },
  { slotCode: "1100", label: "11:00 AM - 12:00 PM", phaseLabel: "Phase 4", isMorningPickupOnly: true, defaultCapacity: 10 },
  { slotCode: "0100", label: "01:00 PM - 02:00 PM", phaseLabel: "Phase 5", isMorningPickupOnly: false, defaultCapacity: 15 },
  { slotCode: "0200", label: "02:00 PM - 03:00 PM", phaseLabel: "Phase 6", isMorningPickupOnly: false, defaultCapacity: 15 },
  { slotCode: "0300", label: "03:00 PM - 04:00 PM", phaseLabel: "Phase 7", isMorningPickupOnly: false, defaultCapacity: 15 },
  { slotCode: "0400", label: "04:00 PM - 05:00 PM", phaseLabel: "Phase 8", isMorningPickupOnly: false, defaultCapacity: 15 }
];

async function ensureServiceHourSlots() {
  try {
    for (const def of SERVICE_SLOT_DEFAULTS) {
      const existing = await AppointmentSlot.findOne({ slotCode: def.slotCode }).lean();
      if (!existing) {
        await AppointmentSlot.create({ ...def, isActive: true });
        console.log(`[backend] Added appointment slot ${def.label}.`);
      } else if (existing.phaseLabel !== def.phaseLabel) {
        await AppointmentSlot.updateOne({ _id: existing._id }, { $set: { phaseLabel: def.phaseLabel } });
      }
    }
    // Anything outside 8-12 / 1-5 (e.g. a lunch-hour slot added by hand) is switched off.
    const all = await AppointmentSlot.find({ isActive: true }).lean();
    for (const slot of all) {
      if (!isSlotWithinServiceHours(slot)) {
        await AppointmentSlot.updateOne({ _id: slot._id }, { $set: { isActive: false } });
        console.log(`[backend] Deactivated slot outside service hours / during lunch: ${slot.label}.`);
      }
    }
  } catch (error) {
    console.error("[backend] Could not sync appointment slots:", error.message);
  }
}

/** { isClosed, reason: "time-passed" | "manual" | null } for one slot on one date. */
function computeSlotClosure(slot, override, dateISO, now = nowPH()) {
  if (dateISO < now.dateISO) return { isClosed: true, reason: "time-passed" };
  if (dateISO === now.dateISO) {
    const start = slotStartMinutes(slot);
    if (start !== null && now.minutes >= start - SLOT_BOOKING_CUTOFF_MINUTES) {
      return { isClosed: true, reason: "time-passed" };
    }
  }
  if (override && override.isClosed === true) return { isClosed: true, reason: "manual" };
  return { isClosed: false, reason: null };
}

function slotClosedMessage(reason) {
  return reason === "time-passed"
    ? "That time slot has already passed. Please choose another slot."
    : "That time slot is closed. Please choose another slot.";
}

async function getSlotClosureForDate(slotId, dateISO) {
  const [slot, override] = await Promise.all([
    AppointmentSlot.findById(String(slotId)).select("label slotCode").lean(),
    AppointmentSlotOverride.findOne({ slotId: String(slotId), overrideDate: dateISO }).select("isClosed").lean()
  ]);
  if (!slot) return { isClosed: true, reason: "manual" };
  return computeSlotClosure(slot, override, dateISO);
}

/**
 * Validates the time slot a resident picked for a service request. Request slots are saved as text,
 * so match it to a real slot, then check it is open and not full.
 */
async function validateRequestTimeSlot(timeLabel, dateISO) {
  const code = slotCodeFromTimeLabel(timeLabel);
  const slot = code ? await AppointmentSlot.findOne({ slotCode: code, isActive: true }).lean() : null;
  if (!slot || !isSlotWithinServiceHours(slot)) {
    return { ok: false, status: 400, message: "Selected time slot is unavailable. Service hours are 8:00 AM to 5:00 PM, with lunch from 12:00 PM to 1:00 PM." };
  }

  const override = await AppointmentSlotOverride.findOne({ slotId: String(slot._id), overrideDate: dateISO }).lean();
  const closure = computeSlotClosure(slot, override, dateISO);
  if (closure.isClosed) {
    return { ok: false, status: 409, code: "SLOT_CLOSED", message: slotClosedMessage(closure.reason) };
  }

  const overrideCap = Number(override?.capacityLimit);
  const capacity = Number.isInteger(overrideCap) && overrideCap > 0 ? overrideCap : Number(slot.defaultCapacity || 0);
  if (capacity > 0) {
    // Same counting the staff slot cards use: appointments booked on this slot + requests that chose it.
    const [appointmentCount, requestRows] = await Promise.all([
      Appointment.countDocuments({ slotId: String(slot._id), appointmentDate: dateISO, status: { $nin: ["Rejected", "Cancelled"] } }),
      ServiceRequest.find({ preferredDate: dateISO, status: { $nin: ["Rejected", "Cancelled"] } }).select("preferredTimeSlot").lean()
    ]);
    const requestCount = requestRows.filter((r) => slotCodeFromTimeLabel(r.preferredTimeSlot) === code).length;
    if (appointmentCount + requestCount >= capacity) {
      return { ok: false, status: 409, code: "SLOT_FULL", message: "The slot selected is already full, select another slot." };
    }
  }
  return { ok: true };
}

async function requireStaffPortalUser(req, res) {
  const { profile, error } = await resolveProfileFromToken(req);
  if (error) {
    res.status(error.status).json({ ok: false, message: error.message });
    return null;
  }
  if (!STAFF_PORTAL_ROLES.has(profile.role)) {
    res.status(403).json({ ok: false, message: "Admin portal access required." });
    return null;
  }
  return { profile };
}

async function requireSystemAdminUser(req, res) {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return null;
  if (auth.profile.role !== "system-admin") {
    res.status(403).json({
      ok: false,
      message: "System administrator access is required for this action."
    });
    return null;
  }
  return auth;
}

function normalizeAnnouncementRow(row) {
  return {
    id: String(row._id),
    category: row.category,
    title: row.title,
    body: row.body,
    isActive: row.isActive,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    postedByRole: row.postedByRole ?? null
  };
}

function normalizeServiceCatalogRow(row) {
  return {
    id: String(row._id),
    name: row.serviceName,
    requiredDocuments: row.requiredDocuments,
    processingTime: row.processingTime,
    status: row.status,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeAppointmentPurposeCatalogRow(row) {
  return {
    id: String(row._id),
    purposeCode: row.purposeCode,
    label: row.label,
    sortOrder: row.sortOrder ?? 0,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt || null
  };
}

const PORTAL_ENVIRONMENT_VALUES = new Set(["production", "maintenance"]);

async function getPortalEnvironmentFromDb() {
  try {
    const doc = await SystemSettings.findById(SINGLETON_ID).lean();
    const env = String(doc?.environment || "production").toLowerCase();
    return PORTAL_ENVIRONMENT_VALUES.has(env) ? env : "production";
  } catch (error) {
    console.error("[system_settings] read:", error.message);
    return "production";
  }
}

async function savePortalEnvironmentToDb(environment) {
  const env = PORTAL_ENVIRONMENT_VALUES.has(String(environment || "").toLowerCase())
    ? String(environment).toLowerCase()
    : "production";

  try {
    await SystemSettings.findByIdAndUpdate(
      SINGLETON_ID,
      { $set: { environment: env } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    maintenanceEnvCache = { value: env, at: Date.now() }; // take effect immediately
    return { ok: true, environment: env };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

// ---- Barangay site info (contact details + document signatory), stored in system_settings.siteInfo ----
const SITE_INFO_DEFAULTS = Object.freeze({
  barangayName: "Burgos",
  municipality: "San Marcelino",
  province: "Zambales",
  contactNumber: "09212611575",
  officeHours: "Mon-Fri 8AM - 5PM",
  address: "353 National Highway, Barangay Burgos, Covered Court, San Marcelino, Zambales",
  signatoryName: "HON. LILIBETH C. BALLON",
  signatoryTitle: "Acting Punong Barangay"
});
const SITE_INFO_LIMITS = Object.freeze({
  barangayName: 80, municipality: 80, province: 80, contactNumber: 40, officeHours: 120, address: 250, signatoryName: 120, signatoryTitle: 120
});

/** Keeps only known text fields, trims them and caps their length. Empty values fall back to the default. */
function cleanSiteInfo(input, { useDefaults = true } = {}) {
  const out = {};
  for (const key of Object.keys(SITE_INFO_DEFAULTS)) {
    const raw = input && input[key];
    if (raw === undefined || raw === null) {
      if (useDefaults) out[key] = SITE_INFO_DEFAULTS[key];
      continue;
    }
    const value = String(raw).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, SITE_INFO_LIMITS[key]);
    if (value) out[key] = value;
    else if (useDefaults) out[key] = SITE_INFO_DEFAULTS[key];
  }
  return out;
}

async function getSiteInfoFromDb() {
  try {
    const doc = await SystemSettings.findById(SINGLETON_ID).lean();
    return cleanSiteInfo(doc && doc.siteInfo);
  } catch (error) {
    console.error("[system_settings] site info read:", error.message);
    return { ...SITE_INFO_DEFAULTS };
  }
}

async function saveSiteInfoToDb(input) {
  const clean = cleanSiteInfo(input, { useDefaults: false });
  const update = {};
  for (const [key, value] of Object.entries(clean)) update["siteInfo." + key] = value;
  if (!Object.keys(update).length) return { ok: false, status: 400, detail: "No valid fields to save." };
  try {
    await SystemSettings.findByIdAndUpdate(
      SINGLETON_ID,
      { $set: update },
      { upsert: true, setDefaultsOnInsert: true }
    );
    return { ok: true, siteInfo: await getSiteInfoFromDb() };
  } catch (error) {
    return { ok: false, status: 500, detail: error.message };
  }
}

/** URL-safe code for appointment purpose (stored in appointments.purpose). */
function slugifyAppointmentPurposeCode(raw) {
  let s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!s) s = "purpose";
  return s;
}

function normalizeFaqSearchText(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function tokenizeForFaqSearch(normalizedLower) {
  return normalizedLower
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function significantFaqTokensFromField(text) {
  const bag = new Set();
  for (const t of tokenizeForFaqSearch(normalizeFaqSearchText(text))) {
    if (t.length < 2 || FAQ_SEARCH_TOKEN_STOPWORDS.has(t)) continue;
    bag.add(t);
  }
  return bag;
}

function scoreFaqEntry(normalizedMessage, tokens, row) {
  let score = 0;
  const reasons = [];
  const keywords = Array.isArray(row.keywords) ? row.keywords : [];

  for (const kw of keywords) {
    const k = normalizeFaqSearchText(kw);
    if (k.length < 3 || FAQ_SEARCH_IGNORED_KEYWORD_SUBSTRINGS.has(k)) continue;
    if (normalizedMessage.includes(k)) {
      score += 6;
      reasons.push(`keyword:${k.slice(0, 64)}`);
    }
  }

  const questionTok = significantFaqTokensFromField(row.question);
  const answerTok = significantFaqTokensFromField(row.answer);

  for (const t of tokens) {
    if (t.length < 2 || FAQ_SEARCH_TOKEN_STOPWORDS.has(t)) continue;
    if (questionTok.has(t)) {
      score += 3;
      reasons.push(`question:${t}`);
    } else if (answerTok.has(t)) {
      score += 1;
      reasons.push(`answer:${t}`);
    }
  }

  return { score, reasons: [...new Set(reasons)].slice(0, 12) };
}

function normalizeFaqMatch(row, score, reasons) {
  return {
    id: String(row._id),
    category: row.category,
    question: row.question,
    answer: row.answer,
    score,
    matchReasons: reasons,
    sortOrder: row.sortOrder
  };
}

async function retrieveFaqMatchesInternal(query, limit) {
  let data;
  try {
    data = await FaqEntry.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
  } catch (error) {
    return {
      ok: false,
      message: "Unable to load FAQs.",
      detail: error.message
    };
  }

  const normalizedMessage = normalizeFaqSearchText(query);
  const tokens = tokenizeForFaqSearch(normalizedMessage);

  const scored = (data || [])
    .map((row) => {
      const { score, reasons } = scoreFaqEntry(normalizedMessage, tokens, row);
      return { row, score, reasons };
    })
    .filter((x) => x.score >= FAQ_SEARCH_MIN_SCORE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.row.sortOrder ?? 0) - (b.row.sortOrder ?? 0);
    })
    .slice(0, limit);

  const bestScore = scored.length ? scored[0].score : 0;
  let confidence = "none";
  if (bestScore >= 12) confidence = "high";
  else if (bestScore >= FAQ_SEARCH_MIN_SCORE) confidence = "low";

  return {
    ok: true,
    query,
    matches: scored.map(({ row, score, reasons }) => normalizeFaqMatch(row, score, reasons)),
    bestScore,
    confidence
  };
}

function buildFaqContextBlock(matches) {
  return matches
    .map((m, i) => {
      return `[${i + 1}] (${m.category})\nQ: ${m.question}\nA: ${m.answer}`;
    })
    .join("\n\n");
}

function sanitizeChatReply(raw) {
  let s = String(raw || "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
  if (s.length > MAX_GROQ_REPLY_CHARS) s = s.slice(0, MAX_GROQ_REPLY_CHARS).trim();
  return s.replace(/[<>]/g, "");
}

/** Live, admin-editable facts the chatbot may use (cached for a minute so every message does not hit the database). */
let chatFactsCache = { at: 0, text: "" };
async function buildChatFactsBlock() {
  const now = Date.now();
  if (chatFactsCache.text && now - chatFactsCache.at < 60000) return chatFactsCache.text;
  const lines = [];
  try {
    const info = await getSiteInfoFromDb();
    lines.push(`Barangay: ${info.barangayName}, ${info.municipality}, ${info.province}`);
    lines.push(`Office hours: ${info.officeHours}`);
    lines.push(`Contact number: ${info.contactNumber}`);
    lines.push(`Office address: ${info.address}`);
  } catch (_e) {
    /* settings unavailable: skip */
  }
  try {
    const services = await ServiceCatalog.find({ archivedAt: null, status: "Active" })
      .sort({ serviceName: 1 })
      .limit(40)
      .lean();
    if (services.length) {
      lines.push("Services residents can request online under \"Service Requests\":");
      for (const s of services) {
        lines.push(
          `- ${s.serviceName}: required documents: ${String(s.requiredDocuments || "").trim() || "none listed"}; processing time: ${String(s.processingTime || "").trim() || "not stated"}`
        );
      }
    }
  } catch (_e) {
    /* catalog unavailable: skip */
  }
  try {
    const purposes = await AppointmentPurposeCatalog.find({ archivedAt: null }).sort({ sortOrder: 1 }).limit(30).lean();
    if (purposes.length) {
      lines.push("Appointment purposes residents can book: " + purposes.map((p) => p.label).join("; "));
    }
  } catch (_e) {
    /* purposes unavailable: skip */
  }
  const text = lines.join("\n");
  chatFactsCache = { at: now, text };
  return text;
}

/** Last few chat turns sent by the browser. Treated as untrusted text, never as instructions. */
function sanitizeChatHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(-6)) {
    const role = item && item.role === "assistant" ? "assistant" : item && item.role === "user" ? "user" : "";
    const content = sanitizePlainTextField(item && item.content, 500);
    if (role && content) out.push({ role, content });
  }
  return out;
}

// The resident chatbot (Gemini, with Groq as backup) lives in ./services/chatbot.js

function extractJsonValueFromGroqText(raw) {
  let s = String(raw || "").trim();
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) s = m[1].trim();
  return s;
}

function parseGroqJsonArray(text) {
  const t = extractJsonValueFromGroqText(text);
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : null;
  } catch {
    const start = t.indexOf("[");
    const end = t.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    try {
      const v = JSON.parse(t.slice(start, end + 1));
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
}

/**
 * Ask Groq for one-sentence summaries of audit log descriptions (chunked).
 * Returns parallel array of strings (summary or original text on failure / skip).
 */
async function summarizeAuditDescriptionsWithGroq(logs) {
  const originals = logs.map((l) => String(l.description || ""));
  if (!logs.length) return originals;

  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) return originals;
  if (String(process.env.AUDIT_LOG_GROQ_SUMMARY || "1").trim() === "0") return originals;

  const model = String(process.env.GROQ_MODEL || "").trim() || GROQ_CHAT_DEFAULT_MODEL;
  const chunkSizeRaw = Number(process.env.AUDIT_GROQ_SUMMARY_CHUNK_SIZE);
  const chunkSize =
    Number.isInteger(chunkSizeRaw) && chunkSizeRaw > 0 ? Math.min(32, chunkSizeRaw) : 18;

  const out = [...originals];

  for (let start = 0; start < logs.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, logs.length);
    const bundle = [];
    for (let i = start; i < end; i++) {
      bundle.push({
        i: i - start,
        action: String(logs[i].displayAction || logs[i].filterAction || "").slice(0, 120),
        text: originals[i].slice(0, 1400)
      });
    }

    const systemPrompt = [
      "You polish one-line audit log descriptions for a Philippine barangay IT admin dashboard.",
      "Each input item has: i (0-based index in this batch), action (category label), text (one factual line, often already in final form).",
      "Output ONE English sentence per item. Preserve all reference codes (REQ-xxxx, APT-xxxx), emails, names, dates, and status wording.",
      "When text already matches a short factual sentence (e.g. \"Service request REQ-1 (X) status: Pending, changed to Processing\"), return it unchanged or fix only grammar/spacing.",
      "Do not invent facts. If text is empty, use: \"Audit event recorded with no extra detail.\"",
      "No markdown, no bullets.",
      "Return ONLY valid JSON: an array of objects {\"i\":number,\"summary\":\"...\"} — exactly one object per input item, every i from 0 through n-1 exactly once. Use only integer i (not strings)."
    ].join("\n");

    const userContent = `INPUT_ITEMS_JSON:\n${JSON.stringify(bundle)}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 55000);
    try {
      const res = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
          ],
          temperature: 0.1,
          max_tokens: 4096,
          ...groqReasoningParams(model)
        }),
        signal: ac.signal
      });

      const rawText = await res.text();
      let json;
      try {
        json = JSON.parse(rawText);
      } catch {
        console.warn("[audit groq] bad HTTP body:", rawText.slice(0, 200));
        continue;
      }
      if (!res.ok) {
        console.warn("[audit groq] HTTP", res.status, json?.error?.message || rawText.slice(0, 200));
        continue;
      }

      const content = String(json?.choices?.[0]?.message?.content || "");
      const arr = parseGroqJsonArray(content);
      if (!arr) {
        console.warn("[audit groq] JSON array parse failed:", content.slice(0, 300));
        continue;
      }

      const byI = new Map();
      for (const row of arr) {
        if (!row || typeof row !== "object") continue;
        const rawIdx = row.i ?? row.index;
        const idx = Number(rawIdx);
        const summary = String(row.summary || row.s || "").trim();
        const iInt = Number.isFinite(idx) ? Math.floor(idx) : -1;
        if (iInt >= 0 && iInt < bundle.length && summary) {
          byI.set(iInt, summary.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/[<>]/g, ""));
        }
      }
      for (let k = 0; k < bundle.length; k++) {
        const s = byI.get(k);
        if (s) out[start + k] = s.length > 500 ? s.slice(0, 497) + "…" : s;
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.warn("[audit groq] chunk error:", err?.message || err);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return out;
}

// Return basic API status and whether required env vars are present.
app.get("/health", async (_req, res) => {
  // Lightweight check that API server is up and env is loaded.
  const hasDbConfig = Boolean(String(process.env.DATABASE_URL || "").trim());
  const hasJwtConfig = Boolean(
    String(process.env.JWT_ACCESS_SECRET || "").trim() && String(process.env.JWT_REFRESH_SECRET || "").trim()
  );
  const groqConfigured = Boolean(String(process.env.GROQ_API_KEY || "").trim());
  const geminiConfigured = Boolean(String(process.env.GEMINI_API_KEY || "").trim());

  res.json({
    ok: true,
    service: "backend",
    databaseConfigured: hasDbConfig,
    jwtConfigured: hasJwtConfig,
    geminiConfigured,
    groqConfigured
  });
});

// Database readiness check. The path keeps its old name so any existing uptime monitor / Render
// health-check setting keeps working (/health above only reports that the API process is up).
app.get("/mongodb/health", async (_req, res) => {
  const configured = Boolean(process.env.DATABASE_URL);
  let connected = false;
  if (configured) {
    try {
      await pool.query("SELECT 1");
      connected = true;
    } catch (_) {
      connected = false;
    }
  }
  return res.json({ ok: configured && connected, configured, connected });
});

// NOTE: /auth/config was removed here — it exposed raw Supabase credentials
// to the frontend for a client-side Supabase SDK, but grep across every
// frontend file confirmed nothing ever called this route or referenced
// Supabase directly. Dead code from an earlier stage of the project,
// removed rather than ported since there's nothing to port it to.

// Public portal mode (used by landing, guards, and login redirects). No auth.
app.get("/public/system-status", async (_req, res) => {
  try {
    const environment = await getPortalEnvironmentFromDb();
    return res.json({ ok: true, environment });
  } catch (_err) {
    return res.json({ ok: true, environment: "production" });
  }
});

// Public barangay details (contact info, office hours, address, signatory) for the landing/contact pages and documents.
app.get("/public/site-info", async (_req, res) => {
  const siteInfo = await getSiteInfoFromDb();
  res.set("Cache-Control", "public, max-age=60");
  return res.json({ ok: true, siteInfo });
});

// Authenticate an admin account and return auth session details.
app.post("/auth/admin/login", authResidentLoginLimiter, loginFailureLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      message: "Email and password are required."
    });
  }

  const normalizedEmail = normalizeEmail(email);
  const userDoc = await User.findOne({ email: normalizedEmail }).select("+passwordHash");

  if (!userDoc) {
    return res.status(401).json({ ok: false, message: "Invalid email or password." });
  }

  if (isLoginLocked(userDoc)) return res.status(429).json(loginLockedResponse(userDoc));

  const passwordOk = await verifyPassword(String(password), userDoc.passwordHash);
  if (!passwordOk) {
    if (await registerFailedLogin(userDoc, req)) return res.status(429).json(loginLockedResponse(userDoc));
    return res.status(401).json({ ok: false, message: "Invalid email or password." });
  }
  await clearFailedLogins(userDoc);

  const allowedAdminRoles = new Set(["staff", "system-admin"]);
  if (!allowedAdminRoles.has(userDoc.role)) {
    return res.status(403).json({
      ok: false,
      message: "Access denied. Admin portal account required."
    });
  }

  if (!userDoc.isActive) {
    return res.status(403).json({ ok: false, message: "This account has been deactivated." });
  }

  if (userDoc.role !== "system-admin" && (await getPortalEnvironmentCached()) === "maintenance") {
    return res.status(503).json({
      ok: false,
      maintenance: true,
      message: "The portal is under maintenance. Only system administrators can sign in right now."
    });
  }

  const userPayload = {
    email: userDoc.email,
    fullName: userDoc.fullName,
    role: userDoc.role
  };

  const accessToken = signAccessToken(userDoc);
  const refreshToken = signRefreshToken(userDoc);
  const { exp: expiresAt } = verifyAccessToken(accessToken);

  void insertAuthAuditEvent({ action: "login", email: userDoc.email, role: userDoc.role, req });

  return res.json({
    ok: true,
    message: "Login successful.",
    user: userPayload,
    session: {
      accessToken,
      refreshToken,
      expiresAt // unix seconds, matches the shape the old Supabase session had
    }
  });
});

// Refresh an admin session using a valid refresh token.
app.post("/auth/admin/refresh", async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ ok: false, message: "Refresh token is required." });
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    return res.status(401).json({ ok: false, message: "Session refresh failed. Please log in again." });
  }

  const userDoc = await User.findById(payload.sub);
  if (!userDoc || !userDoc.isActive) {
    return res.status(403).json({ ok: false, message: "Profile not found." });
  }

  // tokenVersion mismatch means this refresh token was issued before a
  // forced logout (password change, deactivation) — reject it even though
  // its signature is still technically valid. This is the MongoDB
  // replacement for Supabase's server-side refresh-token revocation.
  if ((payload.tokenVersion || 0) !== (userDoc.tokenVersion || 0)) {
    return res.status(401).json({ ok: false, message: "Session refresh failed. Please log in again." });
  }

  if (userDoc.role !== "system-admin" && (await getPortalEnvironmentCached()) === "maintenance") {
    return res.status(503).json({ ok: false, maintenance: true, message: MAINTENANCE_MESSAGE });
  }

  const newAccessToken = signAccessToken(userDoc);
  const newRefreshToken = signRefreshToken(userDoc);
  const { exp: expiresAt } = verifyAccessToken(newAccessToken);

  return res.json({
    ok: true,
    user: { email: userDoc.email, role: userDoc.role },
    session: {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt
    }
  });
});

app.get("/auth/admin/authorize/:requiredRole", async (req, res) => {
  const role = String(req.params.requiredRole || "").trim();
  const roleMap = {
    staff: ["staff"],
    "system-admin": ["system-admin"]
  };

  const allowedRoles = roleMap[role];
  if (!allowedRoles) {
    return res.status(400).json({
      ok: false,
      message: "Unsupported role authorization target."
    });
  }

  const { profile, error } = await resolveProfileFromToken(req);
  if (error) {
    return res.status(error.status).json({
      ok: false,
      message: error.message
    });
  }

  if (!allowedRoles.includes(profile.role)) {
    return res.status(403).json({
      ok: false,
      message: "Access denied for this role."
    });
  }

  return res.json({
    ok: true,
    user: {
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role
    }
  });
});

const STAFF_LINEAR_SERVICE_REQUEST_STATUSES = new Set(["Processing", "Ready for Pickup", "Completed", "Rejected"]);
const STAFF_LINEAR_APPOINTMENT_STATUSES = new Set(["Processing", "Ready for Pickup", "Completed", "Rejected"]);

function parseStatusTimeline(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((x) => x && typeof x === "object");
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === "object") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function timelineForApiResponse(kind, row) {
  const stored = parseStatusTimeline(row.statusTimeline);
  if (stored.length) return stored;
  const at = row.createdAt ? String(row.createdAt) : null;
  const fallbackStatus =
    kind === "appointment"
      ? String(row.status || "Pending Review")
      : String(row.status || "Pending");
  if (!at) {
    return [{ status: fallbackStatus, at: new Date().toISOString(), note: null }];
  }
  return [{ status: fallbackStatus, at, note: null }];
}

function buildNextTimelineFromRow(row, incomingStatus, noteText) {
  const prevTimeline = parseStatusTimeline(row.statusTimeline);
  const safeNote =
    typeof noteText === "string" && noteText.trim()
      ? sanitizePlainTextField(noteText, MAX_STATUS_NOTE_LEN)
      : null;
  const entry = {
    status: String(incomingStatus),
    at: new Date().toISOString(),
    note: safeNote || null
  };
  if (!prevTimeline.length) {
    const anchorAt = row.createdAt ? String(row.createdAt) : entry.at;
    return [{ status: String(row.status ?? ""), at: anchorAt, note: null }, entry];
  }
  return [...prevTimeline, entry];
}

function requestWorkflowStage(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "pending") return 0;
  if (s === "processing" || s === "in progress") return 1;
  if (s === "ready for pickup") return 2;
  if (s === "completed") return 3;
  if (s === "rejected") return "reject";
  return "other";
}

function appointmentWorkflowStage(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "pending review") return 0;
  if (s === "processing" || s === "confirmed") return 1;
  if (s === "ready for pickup") return 2;
  if (s === "completed") return 3;
  if (s === "rejected") return "reject";
  if (s === "cancelled") return "cancelled";
  return "other";
}

function validateStaffServiceRequestTransition(currentStatus, incomingStatus) {
  const incoming = String(incomingStatus || "").trim();
  if (!STAFF_LINEAR_SERVICE_REQUEST_STATUSES.has(incoming)) {
    return { ok: true };
  }
  const stage = requestWorkflowStage(currentStatus);
  if (stage === "reject" || stage === "other") {
    return {
      ok: false,
      message: "Cannot change status once the request is closed or not in workflow."
    };
  }
  if (incoming === "Rejected") {
    if (stage === 0 || stage === 1) return { ok: true };
    return {
      ok: false,
      message: "Reject is only allowed while the request is Pending or Processing."
    };
  }
  if (incoming === "Processing") {
    if (stage === 0) return { ok: true };
    return { ok: false, message: "Processing is only available while the request is Pending." };
  }
  if (incoming === "Ready for Pickup") {
    if (stage === 1) return { ok: true };
    return {
      ok: false,
      message: "Ready for Pickup is only available while the request is Processing."
    };
  }
  if (incoming === "Completed") {
    if (stage === 2) return { ok: true };
    return { ok: false, message: "Completed is only available after Ready for Pickup." };
  }
  return { ok: false, message: "Invalid status transition." };
}

function validateStaffAppointmentTransition(currentStatus, incomingStatus) {
  const incoming = String(incomingStatus || "").trim();
  if (!STAFF_LINEAR_APPOINTMENT_STATUSES.has(incoming)) {
    return { ok: true };
  }
  const stage = appointmentWorkflowStage(currentStatus);
  if (stage === "reject" || stage === "cancelled" || stage === "other") {
    return {
      ok: false,
      message: "Cannot change status once the appointment is closed or not in workflow."
    };
  }
  if (incoming === "Rejected") {
    if (stage === 0 || stage === 1) return { ok: true };
    return {
      ok: false,
      message: "Reject is only allowed while the appointment is Pending Review or Processing."
    };
  }
  if (incoming === "Processing") {
    if (stage === 0) return { ok: true };
    return { ok: false, message: "Processing is only available while the appointment is Pending Review." };
  }
  if (incoming === "Ready for Pickup") {
    if (stage === 1) return { ok: true };
    return {
      ok: false,
      message: "Ready for Pickup is only available while the appointment is Processing."
    };
  }
  if (incoming === "Completed") {
    if (stage === 2) return { ok: true };
    return { ok: false, message: "Completed is only available after Ready for Pickup." };
  }
  return { ok: false, message: "Invalid status transition." };
}

/** Which printable document (if any) the staff Document Generator can produce for a service. */
function documentTemplateForServiceType(serviceType) {
  const t = String(serviceType || "").toLowerCase();
  if (/business/.test(t)) return null;
  if (/clearance/.test(t)) return "Barangay Clearance";
  if (/indigen/.test(t)) return "Certificate of Indigency";
  return null;
}

function normalizeRequestRow(row) {
  return {
    documentTemplate: documentTemplateForServiceType(row.serviceType),
    id: String(row._id),
    referenceNo: row.referenceNo,
    residentUserId: row.residentUserId ? String(row.residentUserId) : null,
    title: row.title,
    serviceType: row.serviceType,
    description: row.description ?? null,
    purpose: row.purpose ?? null,
    preferredDate: row.preferredDate,
    preferredTimeSlot: row.preferredTimeSlot,
    status: row.status,
    createdAt: row.createdAt || null,
    statusTimeline: timelineForApiResponse("request", row)
  };
}

function normalizeAppointmentRow(row) {
  return {
    id: String(row._id),
    referenceNo: row.referenceNo,
    residentUserId: row.residentUserId ? String(row.residentUserId) : null,
    purpose: row.purpose,
    notes: row.notes ?? null,
    appointmentDate: row.appointmentDate,
    slotId: row.slotId ? String(row.slotId) : null,
    timeLabel: row.slotLabel || null,
    status: row.status,
    createdAt: row.createdAt || null,
    statusTimeline: timelineForApiResponse("appointment", row)
  };
}

async function getResidentDisplayNameForStaff(residentUserId) {
  const id = parseResidentUserId(residentUserId);
  if (!id) return "Unknown resident";
  const userDoc = await User.findById(id).select("fullName email").lean();
  if (!userDoc) return `Resident #${id}`;
  const fullName = String(userDoc.fullName || "").trim();
  if (fullName) return fullName;
  return String(userDoc.email || "").trim() || `Resident #${id}`;
}

/**
 * Adds residentName to a list of normalized rows with ONE user query (staff lists need names;
 * calling getResidentDisplayNameForStaff per row would be one query per row).
 */
async function attachResidentNamesToRows(rows) {
  try {
    const ids = [...new Set(rows.map((r) => r.residentUserId).filter((id) => id && isValidId(id)))];
    const nameById = new Map();
    if (ids.length) {
      const users = await User.find({ _id: { $in: ids } }).select("fullName email").lean();
      users.forEach((u) => nameById.set(String(u._id), String(u.fullName || "").trim() || String(u.email || "").trim()));
    }
    return rows.map((r) => ({
      ...r,
      residentName: (r.residentUserId && nameById.get(String(r.residentUserId))) || "Unknown resident"
    }));
  } catch (_error) {
    return rows;
  }
}

async function normalizeRequestRowWithResident(row) {
  const base = normalizeRequestRow(row);
  const residentName = await getResidentDisplayNameForStaff(row?.residentUserId);
  return { ...base, residentName };
}

async function normalizeAppointmentRowWithResident(row) {
  const base = normalizeAppointmentRow(row);
  const residentName = await getResidentDisplayNameForStaff(row?.residentUserId);
  return { ...base, residentName };
}

function broadcastRequestEvent(payload) {
  const packet = `event: request-updated\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of requestEventClients) {
    try {
      client.write(packet);
    } catch (_error) {
      requestEventClients.delete(client);
    }
  }
}

function broadcastAppointmentEvent(payload) {
  const packet = `event: appointment-updated\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of appointmentEventClients) {
    try {
      client.write(packet);
    } catch (_error) {
      appointmentEventClients.delete(client);
    }
  }
}

function broadcastAnnouncementEvent(payload) {
  const packet = `event: announcements-changed\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of announcementEventClients) {
    try {
      client.write(packet);
    } catch (_error) {
      announcementEventClients.delete(client);
    }
  }
}

async function ensureResidentUserRow(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const existing = await User.findOne({ email: normalizedEmail }).select("_id").lean();
  if (existing) return String(existing._id);

  // Fallback self-heal path, matching the old behavior: if a caller has a
  // valid session for an email with no user row yet, create a bare
  // resident placeholder rather than failing outright. NOTE: since users
  // and profiles are now merged (see models/User.js), this inserts a
  // minimal-but-valid User document — passwordHash is set to a random,
  // never-communicated value, so this account can't actually be logged
  // into with a password until an explicit registration/reset flow runs.
  // This should be a rare path; the normal case is the user row already
  // existing from registration.
  const placeholderPasswordHash = await hashPassword(crypto.randomBytes(24).toString("hex"));
  try {
    const created = await User.create({
      email: normalizedEmail,
      passwordHash: placeholderPasswordHash,
      fullName: normalizedEmail,
      role: "resident",
      authProvider: "local",
      isActive: true,
    });
    return String(created._id);
  } catch (err) {
    // Race condition: another request created the row between our check
    // and this insert (duplicate key on the unique email index) — just
    // re-fetch it.
    const fallback = await User.findOne({ email: normalizedEmail }).select("_id").lean();
    return fallback ? String(fallback._id) : null;
  }
}

async function upsertResidentProfile({ email, fullName, residentSelfRegistered = false, identityVerificationFileId = null, passwordHash = null, accountStatus = null, nameParts = null, contactNumber = null }) {
  const normalizedEmail = normalizeEmail(email);
  const safeFullName = sanitizeFullNameForStorage(fullName);
  if (!normalizedEmail || !safeFullName) {
    return { ok: false, message: "Email and full name are required." };
  }

  const upsertPayload = {
    email: normalizedEmail,
    fullName: safeFullName,
    role: "resident",
    residentSelfRegistered: Boolean(residentSelfRegistered)
  };
  if (identityVerificationFileId) {
    upsertPayload.identityVerificationFileId = identityVerificationFileId;
  }
  if (passwordHash) {
    upsertPayload.passwordHash = passwordHash;
  }
  if (contactNumber) {
    upsertPayload.contactNumber = contactNumber;
  }
  // Keep the name split (as the resident typed it) on the profile, so staff do not have to re-split a full name later.
  if (nameParts && (nameParts.firstName || nameParts.lastName)) {
    upsertPayload.residentProfile = {
      firstName: nameParts.firstName || "",
      middleName: nameParts.middleName || "",
      lastName: nameParts.lastName || ""
    };
  }

  try {
    const updateDoc = { $set: upsertPayload };
    // $setOnInsert so this can never downgrade/overwrite the status of an account that already exists.
    if (accountStatus) updateDoc.$setOnInsert = { accountStatus };
    const created = await User.findOneAndUpdate(
      { email: normalizedEmail },
      updateDoc,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return { ok: true, userId: String(created._id) };
  } catch (error) {
    return { ok: false, message: "Unable to save resident profile.", detail: error.message };
  }
}

function parseResidentUserId(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return null;
  const str = String(rawValue).trim();
  return isValidId(str) ? str : null;
}

function residentRegisterUploadMiddleware(req, res, next) {
  residentRegisterUpload.single("identityVerification")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ ok: false, message: "ID document is too large (max 10MB)." });
      }
      return res.status(400).json({ ok: false, message: "Invalid file upload." });
    }
    if (String(err.message || "") === "INVALID_ID_MIME") {
      return res.status(400).json({
        ok: false,
        message: "Valid ID must be a JPEG, PNG, or PDF file."
      });
    }
    return next(err);
  });
}

async function uploadResidentIdentityDocToStorage(userId, buf, mime) {
  const ext =
    mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "application/pdf" ? "pdf" : null;
  if (!ext) {
    return { ok: false, message: "Unsupported document type." };
  }
  try {
    const fileId = await storeFile(
      { originalname: `identity-${Date.now()}.${ext}`, mimetype: mime, buffer: buf },
      { category: CATEGORY.RESIDENT_ID, uploadedBy: userId }
    );
    return { ok: true, fileId };
  } catch (error) {
    return {
      ok: false,
      message: "Unable to store ID document.",
      detail: error.message
    };
  }
}

app.get("/public/auth-options", (_req, res) => {
  res.json({ ok: true, selfRegistration: process.env.ALLOW_RESIDENT_SELF_REGISTRATION === "true" });
});

app.post(
  "/auth/resident/register",
  authResidentRegisterLimiter,
  residentRegisterUploadMiddleware,
  async (req, res) => {
    // Self-registration is disabled by default (barangay issues accounts). Set ALLOW_RESIDENT_SELF_REGISTRATION=true to re-enable.
    if (process.env.ALLOW_RESIDENT_SELF_REGISTRATION !== "true") {
      return res.status(403).json({
        ok: false,
        message: "Accounts are issued by the barangay office. Please visit the office to get your Resident ID and password."
      });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { email, password } = body;
    const normalizedEmail = normalizeEmail(email);
    const safePassword = String(password || "");
    const idFile = req.file;

    // Name comes as first / middle (optional) / last. The full name is composed here, never trusted from the client.
    const cleanNamePart = (v) => sanitizeFullNameForStorage(v).replace(/\s+/g, " ").slice(0, MAX_NAME_PART_LEN).trim();
    const nameParts = {
      firstName: cleanNamePart(body.firstName),
      middleName: cleanNamePart(body.middleName),
      lastName: cleanNamePart(body.lastName)
    };
    if (!/\p{L}/u.test(nameParts.firstName) || !/\p{L}/u.test(nameParts.lastName)) {
      return res.status(400).json({ ok: false, message: "First name and last name are required." });
    }
    if (nameParts.middleName && !/\p{L}/u.test(nameParts.middleName)) nameParts.middleName = "";
    const safeFullName = composeResidentFullName(nameParts);

    // Philippine mobile number, kept in the local 09XXXXXXXXX form (SMS sending normalizes it again).
    const phoneIntl = normalizePhNumber(body.contactNumber);
    if (!phoneIntl) {
      return res.status(400).json({
        ok: false,
        message: "Please enter a valid Philippine mobile number (for example 09171234567)."
      });
    }
    const safeContactNumber = `0${phoneIntl.slice(3)}`;

    if (!normalizedEmail || !safePassword) {
      return res.status(400).json({
        ok: false,
        message: "Name, email, mobile number, password, and identityVerification file are required."
      });
    }

    if (!idFile || !Buffer.isBuffer(idFile.buffer) || idFile.buffer.length === 0) {
      return res.status(400).json({
        ok: false,
        message: "A valid ID document (JPEG, PNG, or PDF) is required for registration."
      });
    }

    if (!isValidEmailFormat(normalizedEmail)) {
      return res.status(400).json({
        ok: false,
        message: "Please enter a valid email address."
      });
    }

    if (safePassword.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 8 characters long."
      });
    }

    if (safePassword.length > MAX_PASSWORD_LEN) {
      return res.status(400).json({
        ok: false,
        message: `Password must be at most ${MAX_PASSWORD_LEN} characters.`
      });
    }

    const docMime = sniffIdentityDocumentMime(idFile.buffer);
    if (!docMime) {
      return res.status(400).json({
        ok: false,
        message: "ID file content must be a valid JPEG, PNG, or PDF."
      });
    }

    let existing;
    try {
      existing = await User.findOne({ email: normalizedEmail }).select("_id").lean();
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: "Unable to verify email availability.",
        detail: error.message
      });
    }
    if (existing) {
      return res.status(409).json({
        ok: false,
        message: "An account with this email already exists."
      });
    }

    // Upload the ID document first so we have a fileId to attach — if this
    // fails, nothing has been created yet, so there's no rollback needed
    // (unlike the old Supabase version, which had to create the Auth user
    // BEFORE it had anywhere to attach the upload, then delete that user
    // again if the upload failed).
    const uploadResult = await uploadResidentIdentityDocToStorage(normalizedEmail, idFile.buffer, docMime);
    if (!uploadResult.ok) {
      return res.status(500).json({
        ok: false,
        message: uploadResult.message,
        detail: uploadResult.detail
      });
    }

    const passwordHash = await hashPassword(safePassword);
    const profileResult = await upsertResidentProfile({
      email: normalizedEmail,
      fullName: safeFullName,
      residentSelfRegistered: true,
      identityVerificationFileId: uploadResult.fileId,
      passwordHash,
      nameParts,
      contactNumber: safeContactNumber,
      // Self-registered accounts must be approved by barangay personnel before they can log in.
      accountStatus: "pending"
    });
    if (!profileResult.ok) {
      // Clean up the file we just uploaded, since the account record it
      // was meant to attach to was never created.
      await deleteFile(uploadResult.fileId);
      return res.status(500).json({
        ok: false,
        message: profileResult.message,
        detail: profileResult.detail
      });
    }

    void insertAuthAuditEvent({ action: "register", email: normalizedEmail, role: "resident", req });

    return res.status(201).json({
      ok: true,
      message: "Registration submitted. Your account is pending approval by the barangay office. You will be able to log in once it has been approved.",
      stored: true,
      pendingApproval: true,
      user: {
        email: normalizedEmail,
        fullName: safeFullName,
        role: "resident",
        residentUserId: profileResult.userId
      }
    });
  }
);

app.post("/auth/resident/login", authResidentLoginLimiter, loginFailureLimiter, async (req, res) => {
  const body = req.body || {};
  const loginId = String(body.identifier ?? body.residentId ?? body.email ?? "").trim();
  const safePassword = String(body.password || "");

  if (!loginId || !safePassword) {
    return res.status(400).json({
      ok: false,
      message: "Resident ID (or email) and password are required."
    });
  }

  const badCreds = { ok: false, message: "Invalid Resident ID/email or password." };
  if (safePassword.length > MAX_PASSWORD_LEN || loginId.length > 254) {
    return res.status(400).json(badCreds);
  }

  let lookup;
  if (loginId.includes("@")) {
    const normalizedEmail = normalizeEmail(loginId);
    if (!isValidEmailFormat(normalizedEmail)) return res.status(400).json(badCreds);
    lookup = { email: normalizedEmail };
  } else {
    const rid = normalizeResidentId(loginId);
    if (!rid) return res.status(400).json(badCreds);
    lookup = { residentId: rid };
  }

  const userDoc = await User.findOne(lookup).select("+passwordHash");
  if (!userDoc) {
    return res.status(401).json(badCreds);
  }

  if (isLoginLocked(userDoc)) return res.status(429).json(loginLockedResponse(userDoc));

  const passwordOk = await verifyPassword(safePassword, userDoc.passwordHash);
  if (!passwordOk) {
    if (await registerFailedLogin(userDoc, req)) return res.status(429).json(loginLockedResponse(userDoc));
    return res.status(401).json(badCreds);
  }
  await clearFailedLogins(userDoc);

  if (userDoc.role !== "resident") {
    return res.status(403).json({
      ok: false,
      message: "Access denied. Resident portal account required."
    });
  }

  const blockMsg = residentPortalAccountBlockMessage(userDoc.accountStatus);
  if (blockMsg) {
    return res.status(403).json({ ok: false, message: blockMsg });
  }

  const accessToken = signAccessToken(userDoc);
  const refreshToken = signRefreshToken(userDoc);
  const { exp: expiresAt } = verifyAccessToken(accessToken);

  void insertAuthAuditEvent({ action: "login", email: userDoc.email, role: userDoc.role, req });

  return res.json({
    ok: true,
    message: "Login successful.",
    user: {
      email: userDoc.email,
      fullName: userDoc.fullName,
      role: userDoc.role,
      residentUserId: String(userDoc._id),
      residentId: userDoc.residentId || null,
      avatarUrl: userDoc.avatarFileId ? `/files/${userDoc.avatarFileId}` : null,
      mustChangePassword: Boolean(userDoc.mustChangePassword)
    },
    session: {
      accessToken,
      refreshToken,
      expiresAt
    }
  });
});

// Unified login: one endpoint for residents, staff, admins and system admins.
// The account's role decides which portal the client should send the user to.
app.post("/auth/login", authResidentLoginLimiter, loginFailureLimiter, async (req, res) => {
  const body = req.body || {};
  const loginId = String(body.identifier ?? body.residentId ?? body.email ?? "").trim();
  const safePassword = String(body.password || "");

  if (!loginId || !safePassword) {
    return res.status(400).json({ ok: false, message: "Email (or Resident ID) and password are required." });
  }

  const badCreds = { ok: false, message: "Invalid email/Resident ID or password." };
  if (safePassword.length > MAX_PASSWORD_LEN || loginId.length > 254) {
    return res.status(400).json(badCreds);
  }

  let lookup;
  if (loginId.includes("@")) {
    const normalizedEmail = normalizeEmail(loginId);
    if (!isValidEmailFormat(normalizedEmail)) return res.status(400).json(badCreds);
    lookup = { email: normalizedEmail };
  } else {
    const rid = normalizeResidentId(loginId);
    if (!rid) return res.status(400).json(badCreds);
    lookup = { residentId: rid };
  }

  const userDoc = await User.findOne(lookup).select("+passwordHash");
  if (!userDoc) return res.status(401).json(badCreds);

  if (isLoginLocked(userDoc)) return res.status(429).json(loginLockedResponse(userDoc));

  const passwordOk = await verifyPassword(safePassword, userDoc.passwordHash);
  if (!passwordOk) {
    if (await registerFailedLogin(userDoc, req)) return res.status(429).json(loginLockedResponse(userDoc));
    return res.status(401).json(badCreds);
  }
  await clearFailedLogins(userDoc);

  const role = userDoc.role;
  const isResident = role === "resident";
  const isAdminPortalRole = role === "staff" || role === "system-admin";

  if (!isResident && !isAdminPortalRole) {
    return res.status(403).json({ ok: false, message: "This account is not allowed to sign in." });
  }

  if (isResident) {
    const blockMsg = residentPortalAccountBlockMessage(userDoc.accountStatus);
    if (blockMsg) return res.status(403).json({ ok: false, message: blockMsg });
  } else if (!userDoc.isActive) {
    return res.status(403).json({ ok: false, message: "This account has been deactivated." });
  }

  if (role !== "system-admin" && (await getPortalEnvironmentCached()) === "maintenance") {
    return res.status(503).json({
      ok: false,
      maintenance: true,
      message: "The portal is under maintenance. Please try again later."
    });
  }

  let userPayload;
  if (isResident) {
    userPayload = {
      email: userDoc.email,
      fullName: userDoc.fullName,
      role,
      residentUserId: String(userDoc._id),
      residentId: userDoc.residentId || null,
      avatarUrl: userDoc.avatarFileId ? `/files/${userDoc.avatarFileId}` : null,
      mustChangePassword: Boolean(userDoc.mustChangePassword)
    };
  } else {
    userPayload = { email: userDoc.email, fullName: userDoc.fullName, role };
  }

  const accessToken = signAccessToken(userDoc);
  const refreshToken = signRefreshToken(userDoc);
  const { exp: expiresAt } = verifyAccessToken(accessToken);

  void insertAuthAuditEvent({ action: "login", email: userDoc.email, role, req });

  return res.json({
    ok: true,
    message: "Login successful.",
    user: userPayload,
    session: { accessToken, refreshToken, expiresAt }
  });
});

// --- Resident "Forgot password" (SMS code) ---------------------------------------------------------------
// Residents are issued accounts by the barangay and often have no real email, so the reset code is texted to the
// mobile number the barangay has on file. Residents only; staff and system admins are reset by a system administrator.
// Responses never reveal whether an account exists. Codes: 6 digits, 10 minutes, 5 wrong guesses, stored hashed.
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_CODE_MAX_ATTEMPTS = 5;
const RESET_CODE_COOLDOWN_MS = 60 * 1000;
const RESET_CODE_MAX_PER_HOUR = 3;

function hashResetCode(userId, code) {
  const key = String(process.env.JWT_REFRESH_SECRET || process.env.JWT_ACCESS_SECRET || "sb-reset");
  return crypto.createHmac("sha256", key).update(`${String(userId)}:${String(code)}`).digest("hex");
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "hex");
  const bb = Buffer.from(String(b), "hex");
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

async function findResidentForPasswordReset(identifierRaw) {
  const loginId = String(identifierRaw || "").trim();
  if (!loginId || loginId.length > 254) return null;
  let lookup;
  if (loginId.includes("@")) {
    const e = normalizeEmail(loginId);
    if (!isValidEmailFormat(e)) return null;
    lookup = { email: e };
  } else {
    const rid = normalizeResidentId(loginId);
    if (!rid) return null;
    lookup = { residentId: rid };
  }
  const user = await User.findOne(lookup).select("+passwordHash");
  if (!user || user.role !== "resident") return null;
  if (residentPortalAccountBlockMessage(user.accountStatus)) return null;
  if (user.loginIssued === false) return null; // staff have not issued a login for this record yet
  return user;
}

app.post("/auth/resident/forgot-password", forgotPasswordLimiter, async (req, res) => {
  if (!isSmsConfigured()) {
    return res.status(503).json({
      ok: false,
      message: "Password reset by text message is not available right now. Please visit the barangay hall and the Barangay Secretary will reset your password."
    });
  }
  const generic = {
    ok: true,
    message: "If your account has a mobile number registered with the barangay, we sent a 6-digit code to it. The code is valid for 10 minutes."
  };
  try {
    const user = await findResidentForPasswordReset(req.body?.identifier);
    const phone = user ? normalizePhNumber(user.contactNumber) : null;
    if (!user || !phone) return res.json(generic);

    const now = Date.now();
    const recent = await PasswordResetCode.find({ userId: user._id, createdAt: { $gt: new Date(now - 60 * 60 * 1000) } })
      .sort({ createdAt: -1 })
      .lean();
    if (recent.length >= RESET_CODE_MAX_PER_HOUR) return res.json(generic);
    if (recent[0] && now - new Date(recent[0].createdAt).getTime() < RESET_CODE_COOLDOWN_MS) return res.json(generic);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    await PasswordResetCode.deleteMany({ userId: user._id });
    await PasswordResetCode.create({
      userId: user._id,
      codeHash: hashResetCode(user._id, code),
      expiresAt: new Date(now + RESET_CODE_TTL_MS),
      requestIp: req.ip || null
    });
    void insertAuthAuditEvent({ action: "password_reset_requested", email: user.email, role: user.role, req });
    // Not awaited, so the response time is the same whether or not an account exists.
    void sendSmsBatch([phone], `SerbisyoBurgos: Your password reset code is ${code}. It expires in 10 minutes. Never share this code with anyone.`, {
      purpose: "password_reset",
      relatedType: "user",
      relatedId: user._id,
      userIds: { [phone]: String(user._id) },
      logMessage: "SerbisyoBurgos: Your password reset code is ****** (hidden). It expires in 10 minutes. Never share this code with anyone."
    })
      .then((r) => { if (r.failed) console.warn("[forgot-password] SMS failed:", (r.errors || []).join("; ")); });
    return res.json(generic);
  } catch (err) {
    console.warn("[forgot-password] error:", err?.message || err);
    return res.json(generic);
  }
});

app.post("/auth/resident/reset-password", resetPasswordLimiter, async (req, res) => {
  const body = req.body || {};
  const code = String(body.code || "").trim();
  const newPassword = String(body.newPassword || "");
  const confirmPassword = String(body.confirmPassword || "");
  const invalid = { ok: false, message: "That code is incorrect or has expired. Please check it or request a new code." };

  if (!/^\d{6}$/.test(code)) return res.status(400).json(invalid);
  if (newPassword.length < 8) return res.status(400).json({ ok: false, message: "New password must be at least 8 characters." });
  if (newPassword.length > MAX_PASSWORD_LEN) return res.status(400).json({ ok: false, message: "New password is too long." });
  if (confirmPassword && newPassword !== confirmPassword) {
    return res.status(400).json({ ok: false, message: "New password and confirmation do not match." });
  }

  try {
    const user = await findResidentForPasswordReset(body.identifier);
    if (!user) return res.status(400).json(invalid);

    const record = await PasswordResetCode.findOne({ userId: user._id }).sort({ createdAt: -1 });
    if (!record || record.expiresAt.getTime() < Date.now()) return res.status(400).json(invalid);
    if (record.attempts >= RESET_CODE_MAX_ATTEMPTS) {
      await PasswordResetCode.deleteMany({ userId: user._id });
      return res.status(400).json({ ok: false, message: "Too many wrong codes. Please request a new code." });
    }
    if (!safeEqualHex(record.codeHash, hashResetCode(user._id, code))) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json(invalid);
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      return res.status(400).json({ ok: false, message: "Your new password must be different from your current one." });
    }

    user.passwordHash = await hashPassword(newPassword);
    user.mustChangePassword = false;
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    user.tokenVersion = (user.tokenVersion || 0) + 1; // signs the resident out everywhere
    await user.save();
    await PasswordResetCode.deleteMany({ userId: user._id });
    void insertAuthAuditEvent({ action: "password_reset", email: user.email, role: user.role, req });

    const phone = normalizePhNumber(user.contactNumber);
    if (phone) {
      void sendSmsBatch([phone], "SerbisyoBurgos: Your password was changed. If this was not you, please contact the barangay hall right away.", {
        purpose: "password_changed",
        relatedType: "user",
        relatedId: user._id,
        userIds: { [phone]: String(user._id) }
      });
    }
    return res.json({ ok: true, message: "Your password has been changed. You can now log in." });
  } catch (err) {
    console.warn("[reset-password] error:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Something went wrong. Please try again." });
  }
});

app.get("/auth/resident/authorize", async (req, res) => {
  const { profile, error } = await resolveProfileFromToken(req);
  if (error) {
    return res.status(error.status).json({ ok: false, message: error.message });
  }
  if (profile.role !== "resident") {
    return res.status(403).json({ ok: false, message: "Resident portal access required." });
  }

  const residentUserId = await ensureResidentUserRow(profile.email);
  if (!residentUserId) {
    return res.status(500).json({
      ok: false,
      message: "Unable to resolve resident account."
    });
  }

  return res.json({
    ok: true,
    user: {
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role,
      residentUserId,
      avatarUrl: profile.avatar_url ?? null,
      mustChangePassword: Boolean(profile.must_change_password)
    }
  });
});

app.get("/resident/context", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;
  return res.json({
    ok: true,
    residentUserId: auth.residentUserId,
    fullName: auth.profile?.full_name || null,
    email: auth.profile?.email || null,
    contactNumber: auth.profile?.contact_number ?? null,
    avatarUrl: auth.profile?.avatar_url ?? null
  });
});

const MAX_CONTACT_NUMBER_LEN = 40;

function sanitizeResidentContactNumber(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^\d+\-\s()]/g, "").slice(0, MAX_CONTACT_NUMBER_LEN);
  return cleaned || null;
}

/** Full profile for resident portal (name, email, contact). */
app.get("/resident/profile", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;
  const p = auth.profile;
  return res.json({
    ok: true,
    email: p.email,
    fullName: p.full_name || "",
    contactNumber: p.contact_number ?? null,
    smsOptOut: Boolean(p.sms_opt_out),
    residentId: p.resident_id || null,
    avatarUrl: p.avatar_url ?? null
  });
});

/** Update resident email and/or contact number (profiles + auth email + users.email). */
app.patch("/resident/profile", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const hasContact = Object.prototype.hasOwnProperty.call(body, "contactNumber");
  const hasEmail = Object.prototype.hasOwnProperty.call(body, "email");
  const hasSmsOptOut = typeof body.smsOptOut === "boolean";
  if (!hasContact && !hasEmail && !hasSmsOptOut) {
    return res.status(400).json({
      ok: false,
      message: "Provide contactNumber, email and/or smsOptOut to update."
    });
  }

  const rowEmail = auth.profile.email;
  const oldEmailNorm = normalizeEmail(rowEmail);
  let nextEmailNorm = oldEmailNorm;
  if (hasEmail) {
    nextEmailNorm = normalizeEmail(body.email);
    if (!nextEmailNorm || !isValidEmailFormat(nextEmailNorm)) {
      return res.status(400).json({ ok: false, message: "A valid email address is required." });
    }
  }

  let contact_number;
  if (hasContact) {
    contact_number = sanitizeResidentContactNumber(body.contactNumber);
  }

  const emailChanging = hasEmail && nextEmailNorm !== oldEmailNorm;

  // Merging users+profiles into one User document (see models/User.js)
  // means there's no separate Auth system or second table to keep in
  // sync here anymore — the old version of this route had to update
  // Supabase Auth's email, roll that back on failure, and separately sync
  // the `users` table. All of that collapses into one atomic document
  // update below.
  const profilePatch = {};
  if (hasContact) profilePatch.contactNumber = contact_number;
  if (emailChanging) profilePatch.email = nextEmailNorm;
  if (hasSmsOptOut) profilePatch.smsOptOut = body.smsOptOut;

  if (Object.keys(profilePatch).length === 0) {
    const p = auth.profile;
    return res.json({
      ok: true,
      email: p.email,
      fullName: p.full_name || "",
      contactNumber: p.contact_number ?? null,
      smsOptOut: Boolean(p.sms_opt_out),
      avatarUrl: p.avatar_url ?? null,
      message: "No changes to save."
    });
  }

  let updated;
  try {
    updated = await User.findOneAndUpdate(
      { email: rowEmail },
      { $set: profilePatch },
      { new: true }
    ).lean();
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ ok: false, message: "That email address is already in use." });
    }
    return res.status(500).json({
      ok: false,
      message: "Unable to update profile.",
      detail: error.message
    });
  }

  if (!updated) {
    return res.status(403).json({
      ok: false,
      message: "No profile row was updated. Confirm your session and try again."
    });
  }

  return res.json({
    ok: true,
    email: updated.email,
    fullName: updated.fullName || "",
    contactNumber: updated.contactNumber ?? null,
    smsOptOut: Boolean(updated.smsOptOut),
    avatarUrl: updated.avatarFileId ? `/files/${updated.avatarFileId}` : null
  });
});

// Streams a file stored in GridFS (avatars, resident ID documents) back to
// the browser. Replaces the public URLs Supabase Storage used to hand out
// directly — GridFS has no equivalent, so every file is served through
// this route instead. Requires a valid session; residents can only view
// their own files, staff/admin/system-admin can view any (needed to
// review uploaded ID documents during verification).
app.get("/files/:id", (req, res, next) => {
  // helmet's default Cross-Origin-Resource-Policy: same-origin blocks
  // <img>/<iframe> from embedding this response when the frontend and
  // backend run on different origins (e.g. Live Server on :5500, backend
  // on :4000 locally; or two different domains once deployed) — the
  // request succeeds (200) but the browser refuses to render it
  // (net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin). Relaxed only on this
  // route, which is exactly the "serve a file for display elsewhere" case
  // this header exists to gate — every other route keeps helmet's default.
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}, async (req, res) => {
  // <img>/<iframe> tags load resources natively and can't send an
  // Authorization header, unlike fetch() calls elsewhere in the app. Same
  // problem the SSE routes already solved with an access_token query param
  // fallback — mirroring that here, scoped to just this route rather than
  // widening the shared getBearerToken() helper (which would let every
  // route accept tokens via URL, a real step down in security for
  // password-change/delete/etc. routes that should stay header-only).
  if (!req.headers.authorization && req.query?.access_token) {
    req.headers.authorization = `Bearer ${req.query.access_token}`;
  }

  const auth = await requireStaffOrAuthenticatedResident(req, res);
  if (!auth) return;

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid file id." });
  }

  if (auth.portal === "resident") {
    let owner;
    try {
      owner = await User.findOne({
        _id: auth.residentUserId,
        $or: [{ avatarFileId: id }, { identityVerificationFileId: id }]
      })
        .select("_id")
        .lean();
    } catch (error) {
      return res.status(500).json({ ok: false, message: "Unable to verify file access.", detail: error.message });
    }
    if (!owner) {
      return res.status(403).json({ ok: false, message: "You do not have access to this file." });
    }
  }

  streamFile(id, res);
});


app.post(
  "/resident/profile/avatar",
  residentAvatarUploadLimiter,
  residentAvatarRawBodyParser,
  async (req, res) => {
    const auth = await requireResidentPortalUser(req, res);
    if (!auth) return;

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ ok: false, message: "Send a non-empty image body (JPEG, PNG, WebP, or GIF)." });
    }
    if (buf.length > MAX_AVATAR_BYTES) {
      return res.status(400).json({ ok: false, message: "Image is too large (max 5MB)." });
    }

    const mime = sniffImageMimeFromBuffer(buf);
    if (!mime) {
      return res.status(400).json({ ok: false, message: "Unsupported image type. Use JPEG, PNG, WebP, or GIF." });
    }

    // Find the previous avatar (if any) so we can clean it up — GridFS has
    // no "upsert" like Supabase Storage did, so replacing an avatar is an
    // explicit delete-old-then-store-new here rather than an overwrite.
    let previousFileId = null;
    try {
      const current = await User.findById(auth.authUserId).select("avatarFileId").lean();
      previousFileId = current?.avatarFileId || null;
    } catch (_error) {
      /* non-fatal — proceed with upload even if we couldn't check */
    }

    let newFileId;
    try {
      newFileId = await storeFile(
        { originalname: "avatar", mimetype: mime, buffer: buf },
        { category: CATEGORY.AVATAR, uploadedBy: auth.authUserId }
      );
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: "Unable to store profile photo.",
        detail: error.message
      });
    }

    let updated;
    try {
      updated = await User.findByIdAndUpdate(
        auth.authUserId,
        { $set: { avatarFileId: newFileId } },
        { new: true }
      )
        .select("avatarFileId")
        .lean();
    } catch (error) {
      await deleteFile(newFileId);
      return res.status(500).json({
        ok: false,
        message: "Photo stored but profile could not be updated.",
        detail: error.message
      });
    }

    if (previousFileId) {
      await deleteFile(previousFileId);
    }

    const bust = `t=${Date.now()}`;
    const avatarUrl = `/files/${updated.avatarFileId}?${bust}`;

    return res.json({
      ok: true,
      avatarUrl
    });
  }
);

/**
 * Change password: either verify current password, or (when currentPassword is omitted)
 * rely on an authenticated resident session — matches single-field portal forms.
 */
app.post("/resident/change-password", residentChangePasswordLimiter, async (req, res) => {
  // reachable even while a password change is still required (that is what this route is for)
  const auth = await requireResidentPortalUser(req, res, { allowPasswordChangePending: true });
  if (!auth) return;
  const mustChange = Boolean(auth.profile.must_change_password);
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  const confirmPassword = String(req.body?.confirmPassword || "");
  if (!newPassword) {
    return res.status(400).json({ ok: false, message: "New password is required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ ok: false, message: "New password must be at least 8 characters." });
  }
  if (newPassword.length > MAX_PASSWORD_LEN) {
    return res.status(400).json({ ok: false, message: "New password is too long." });
  }
  if (confirmPassword && newPassword !== confirmPassword) {
    return res.status(400).json({ ok: false, message: "New password and confirmation do not match." });
  }

  // When the password was issued by staff, the temporary one must be entered to replace it.
  if (mustChange && !currentPassword) {
    return res.status(400).json({ ok: false, message: "Enter the temporary password you were given." });
  }

  const userDoc = await User.findById(auth.authUserId).select("+passwordHash");
  if (!userDoc) {
    return res.status(500).json({ ok: false, message: "Unable to resolve user for password update." });
  }

  if (currentPassword) {
    const currentOk = await verifyPassword(currentPassword, userDoc.passwordHash);
    if (!currentOk) {
      return res.status(401).json({ ok: false, message: mustChange ? "The temporary password is incorrect." : "Current password is incorrect." });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ ok: false, message: "Your new password must be different from the current one." });
    }
  }

  userDoc.passwordHash = await hashPassword(newPassword);
  userDoc.mustChangePassword = false;
  // Invalidates every previously issued refresh token at once — the
  // MongoDB replacement for Supabase Auth's automatic session revocation
  // on password change.
  userDoc.tokenVersion = (userDoc.tokenVersion || 0) + 1;
  await userDoc.save();

  void insertAuthAuditEvent({ action: "password_change", email: userDoc.email, role: userDoc.role, req });

  return res.json({ ok: true, message: "Password updated successfully.", mustChangePassword: false });
});

/** Services residents may request (matches admin catalog: Active and not archived). */
app.get("/resident/service-catalog", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;

  let services;
  try {
    services = await ServiceCatalog.find({ archivedAt: null, status: "Active" })
      .sort({ serviceName: 1 })
      .lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load service catalog.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    services: services.map(normalizeServiceCatalogRow)
  });
});

// Combined service requests + appointments for a resident, newest activity first.
app.get("/resident/history", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;
  const residentUserId = auth.residentUserId;

  let requestsData, appointmentsData;
  try {
    [requestsData, appointmentsData] = await Promise.all([
      ServiceRequest.find({ residentUserId }).lean(),
      Appointment.find({ residentUserId }).lean()
    ]);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load history.",
      detail: error.message
    });
  }

  const requests = requestsData.map(normalizeRequestRow);
  const appointments = appointmentsData.map(normalizeAppointmentRow);

  const items = [
    ...requests.map((request) => ({
      kind: "request",
      sortAt: request.createdAt || null,
      request
    })),
    ...appointments.map((appointment) => ({
      kind: "appointment",
      sortAt: appointment.createdAt || null,
      appointment
    }))
  ].sort((a, b) => {
    const left = new Date(a.sortAt || 0).getTime();
    const right = new Date(b.sortAt || 0).getTime();
    return right - left;
  });

  return res.json({
    ok: true,
    items
  });
});

app.get("/requests/events", async (req, res) => {
  const gate = await validateSseAccess(req);
  if (!gate.ok) {
    res.status(gate.status).setHeader("Content-Type", "text/plain").send(gate.message);
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: ready\ndata: {"ok":true}\n\n`);
  requestEventClients.add(res);

  req.on("close", () => {
    requestEventClients.delete(res);
  });
});

app.get("/appointments/events", async (req, res) => {
  const gate = await validateSseAccess(req);
  if (!gate.ok) {
    res.status(gate.status).setHeader("Content-Type", "text/plain").send(gate.message);
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: ready\ndata: {"ok":true}\n\n`);
  appointmentEventClients.add(res);

  req.on("close", () => {
    appointmentEventClients.delete(res);
  });
});

app.get("/announcements/events", async (req, res) => {
  const gate = await validateSseAccess(req);
  if (!gate.ok) {
    res.status(gate.status).setHeader("Content-Type", "text/plain").send(gate.message);
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: ready\ndata: {"ok":true}\n\n`);
  announcementEventClients.add(res);

  req.on("close", () => {
    announcementEventClients.delete(res);
  });
});

// --- Appointment slot availability (staff + resident) ---

app.get("/appointment-slots", async (req, res) => {
  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  const dateISO = parseLocalDateString(req.query?.date);
  if (!dateISO) {
    return res.status(400).json({ ok: false, message: "date (YYYY-MM-DD) is required." });
  }

  let slots, overrides, bookedRows;
  try {
    slots = await AppointmentSlot.find({ isActive: true }).lean();
    slots = slots
      .filter(isSlotWithinServiceHours)                                   // never offer 12:00-1:00 PM or off-hours
      .sort((a, b) => (slotStartMinutes(a) ?? 0) - (slotStartMinutes(b) ?? 0));
    overrides = await AppointmentSlotOverride.find({ overrideDate: dateISO }).lean();
    bookedRows = await Appointment.find({
      appointmentDate: dateISO,
      status: { $nin: ["Rejected", "Cancelled"] }
    })
      .select("slotId")
      .lean();
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to load appointment slots.", detail: error.message });
  }

  const overrideMap = new Map(overrides.map((o) => [String(o.slotId), Number(o.capacityLimit)]));
  const overrideDocBySlot = new Map(overrides.map((o) => [String(o.slotId), o]));
  const nowInfo = nowPH();

  const bookedCountBySlot = new Map();
  for (const row of bookedRows) {
    if (!row.slotId) continue;
    const id = String(row.slotId);
    bookedCountBySlot.set(id, (bookedCountBySlot.get(id) || 0) + 1);
  }

  const results = slots.map((slot) => {
    const slotId = String(slot._id);
    const overrideCap = overrideMap.get(slotId);
    const capacity =
      Number.isInteger(overrideCap) && overrideCap > 0 ? overrideCap : Number(slot.defaultCapacity || 0);
    const booked = bookedCountBySlot.get(slotId) || 0;
    const remaining = Math.max(0, capacity - booked);
    const closure = computeSlotClosure(slot, overrideDocBySlot.get(slotId), dateISO, nowInfo);
    const isFull = capacity > 0 ? booked >= capacity : true;
    return {
      id: slotId,
      code: slot.slotCode,
      label: slot.label,
      phaseLabel: slot.phaseLabel || null,
      isMorningPickupOnly: Boolean(slot.isMorningPickupOnly),
      capacity,
      booked,
      remaining,
      isFull,
      // Closed = staff closed it, or its time has passed. Closed slots cannot be booked.
      isClosed: closure.isClosed,
      closedReason: closure.reason,
      status: closure.isClosed ? "Closed" : isFull ? "Full" : "Open"
    };
  });

  return res.json({ ok: true, date: dateISO, slots: results });
});

app.put("/admin/appointment-slot-overrides", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const { slotId, date, capacityLimit } = req.body || {};
  const parsedLimit = Number(capacityLimit);
  const dateISO = parseLocalDateString(date);

  if (!isValidId(String(slotId || ""))) {
    return res.status(400).json({ ok: false, message: "slotId must be a valid id." });
  }
  if (!dateISO) {
    return res.status(400).json({ ok: false, message: "date (YYYY-MM-DD) is required." });
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0 || parsedLimit > 1000) {
    return res.status(400).json({ ok: false, message: "capacityLimit must be a positive integer (max 1000)." });
  }

  try {
    await AppointmentSlotOverride.findOneAndUpdate(
      { slotId, overrideDate: dateISO },
      { $set: { slotId, overrideDate: dateISO, capacityLimit: parsedLimit } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to save slot capacity override.", detail: error.message });
  }

  let slotLabel = "";
  const slotMeta = await AppointmentSlot.findById(slotId).select("label slotCode").lean();
  if (slotMeta) {
    slotLabel = String(slotMeta.label || slotMeta.slotCode || "").trim();
  }
  void insertPortalAuditEvent({
    action: "Updated Slots",
    description: `Appointment slot capacity override: slot ID ${slotId}${slotLabel ? ` (${slotLabel})` : ""}, date ${dateISO}, capacity limit set to ${parsedLimit}.`,
    profile: auth.profile,
    metadata: {
      entity: "appointment_slot_override",
      slotId,
      slotLabel: slotLabel || null,
      date: dateISO,
      capacityLimit: parsedLimit
    }
  });

  return res.json({ ok: true, slotId, date: dateISO, capacityLimit: parsedLimit });
});

/** Staff opens or closes one time slot for one date. */
app.put("/admin/appointment-slot-status", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const { slotId, date, isClosed } = req.body || {};
  const dateISO = parseLocalDateString(date);
  if (!isValidId(String(slotId || ""))) {
    return res.status(400).json({ ok: false, message: "slotId must be a valid id." });
  }
  if (!dateISO) {
    return res.status(400).json({ ok: false, message: "date (YYYY-MM-DD) is required." });
  }
  if (typeof isClosed !== "boolean") {
    return res.status(400).json({ ok: false, message: "isClosed must be true or false." });
  }

  let slot;
  try {
    slot = await AppointmentSlot.findById(String(slotId)).select("label slotCode").lean();
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to load the slot.", detail: error.message });
  }
  if (!slot) return res.status(404).json({ ok: false, message: "Time slot not found." });

  // A slot whose time has passed is already closed and cannot be reopened.
  const timeClosure = computeSlotClosure(slot, null, dateISO);
  if (timeClosure.isClosed) {
    return res.status(409).json({ ok: false, message: "That time slot has already passed, so it stays closed." });
  }

  try {
    const updated = await AppointmentSlotOverride.findOneAndUpdate(
      { slotId: String(slotId), overrideDate: dateISO },
      { $set: { isClosed } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    // Reopening a slot with no capacity change left: drop the empty override row.
    if (!isClosed && updated && !(Number(updated.capacityLimit) > 0)) {
      await AppointmentSlotOverride.deleteOne({ _id: updated._id });
    }
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to update the slot.", detail: error.message });
  }

  const slotLabel = String(slot.label || slot.slotCode || "").trim();
  void insertPortalAuditEvent({
    action: "Updated Slots",
    description: `${isClosed ? "Closed" : "Opened"} appointment slot ID ${slotId}${slotLabel ? ` (${slotLabel})` : ""} for ${dateISO}.`,
    profile: auth.profile,
    metadata: { entity: "appointment_slot_status", slotId: String(slotId), slotLabel: slotLabel || null, date: dateISO, isClosed }
  });

  return res.json({ ok: true, slotId: String(slotId), date: dateISO, isClosed });
});

app.get("/requests", async (req, res) => {
  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  const filter = {};
  if (actor.portal === "resident") {
    filter.residentUserId = actor.residentUserId;
  } else {
    const requestedResidentUserId = parseResidentUserId(req.query?.residentUserId);
    if (requestedResidentUserId) {
      filter.residentUserId = requestedResidentUserId;
    }
  }

  let data;
  try {
    data = await ServiceRequest.find(filter).sort({ createdAt: -1 }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load requests.",
      detail: error.message
    });
  }

  const requestRows = data.map(normalizeRequestRow);
  return res.json({
    ok: true,
    requests: actor.portal === "resident" ? requestRows : await attachResidentNamesToRows(requestRows)
  });
});

app.get("/requests/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid request id."
    });
  }

  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  let data;
  try {
    data = await ServiceRequest.findById(id).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load request.",
      detail: error.message
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Request not found."
    });
  }

  if (actor.portal === "resident") {
    const ownerId = parseResidentUserId(data.residentUserId);
    if (!ownerId || ownerId !== actor.residentUserId) {
      return res.status(403).json({
        ok: false,
        message: "You do not have access to this request."
      });
    }
  }

  const requestRow = await normalizeRequestRowWithResident(data);
  return res.json({
    ok: true,
    request: requestRow
  });
});

app.get("/requests/by-reference/:referenceNo", async (req, res) => {
  const referenceNo = sanitizePlainTextField(req.params.referenceNo, 40);
  if (!referenceNo || referenceNo.length < 3) {
    return res.status(400).json({
      ok: false,
      message: "Invalid reference number."
    });
  }

  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  let data;
  try {
    data = await ServiceRequest.findOne({ referenceNo }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load request by reference.",
      detail: error.message
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Request not found."
    });
  }

  if (actor.portal === "resident") {
    const ownerId = parseResidentUserId(data.residentUserId);
    if (!ownerId || ownerId !== actor.residentUserId) {
      return res.status(404).json({
        ok: false,
        message: "Request not found."
      });
    }
  }

  const requestRow = await normalizeRequestRowWithResident(data);
  return res.json({
    ok: true,
    request: requestRow
  });
});

// ---------------------------------------------------------------------------
// SMS to the resident when their service request is Rejected or Ready for Pickup.
// Runs in the background: a texting problem must never fail or slow down the status update.
// Skipped when the resident opted out of SMS, has no valid PH mobile number, the request has no
// linked resident account, or TextBee is not configured.
// ---------------------------------------------------------------------------
const REQUEST_SMS_STATUSES = new Set(["Ready for Pickup", "Rejected"]);

function buildRequestStatusSms({ referenceNo, serviceLabel, status, note, officeHours, contactNumber }) {
  // Plain ASCII on purpose: a single non-GSM character (like "…") makes the phone split the text
  // into much shorter segments.
  const ref = String(referenceNo || "").trim();
  const label = String(serviceLabel || "").trim().slice(0, 60);
  const what = [ref, label ? `(${label})` : ""].filter(Boolean).join(" ");
  let extra = String(note || "").replace(/\s+/g, " ").trim();
  if (extra.length > 80) extra = extra.slice(0, 77).trimEnd() + "...";
  const end = (t) => (/[.!?]$/.test(t) ? t : t + ".");

  if (status === "Ready for Pickup") {
    let text = `SerbisyoBurgos: Your request ${what} is now ready for pickup at the Barangay Hall.`;
    if (officeHours) text += ` Office hours: ${end(String(officeHours).trim())}`;
    if (extra) text += ` Note: ${end(extra)}`;
    return text;
  }
  let text = `SerbisyoBurgos: Your request ${what} was not approved.`;
  if (extra) text += ` Reason: ${end(extra)}`;
  text += " Please contact the Barangay Hall for details";
  if (contactNumber) text += ` at ${String(contactNumber).trim()}`;
  return text + ".";
}

async function notifyResidentOfRequestStatus(requestDoc, status, note, actorEmail) {
  try {
    if (!REQUEST_SMS_STATUSES.has(status) || !requestDoc?.residentUserId) return;
    const resident = await User.findOne({
      _id: requestDoc.residentUserId,
      role: "resident",
      isActive: true,
      smsOptOut: { $ne: true }
    })
      .select("contactNumber")
      .lean();
    const phone = normalizePhNumber(resident?.contactNumber);
    if (!phone) return;
    const site = await getSiteInfoFromDb();
    const text = buildRequestStatusSms({
      referenceNo: requestDoc.referenceNo,
      serviceLabel: requestDoc.serviceType || requestDoc.title,
      status,
      note,
      officeHours: site?.officeHours,
      contactNumber: site?.contactNumber
    });
    const result = await sendSmsBatch([phone], text, {
      purpose: "request_status",
      relatedType: "service_request",
      relatedId: requestDoc._id,
      createdByEmail: actorEmail || null,
      userIds: { [phone]: String(requestDoc.residentUserId) }
    });
    if (result.failed) console.warn("[request-sms] SMS failed:", (result.errors || []).join("; "));
  } catch (err) {
    console.warn("[request-sms] error:", err?.message || err);
  }
}

// Rejecting something always needs a reason the resident can read (shown in the portal, and in the SMS for
// service requests). Enforced here, not only in the staff UI, so no client can skip it.
const MIN_REJECTION_REASON_LEN = 5;
function rejectionReasonError(nextStatus, safeNote, what) {
  if (nextStatus !== "Rejected") return null;
  if (String(safeNote || "").trim().length >= MIN_REJECTION_REASON_LEN) return null;
  return `Please enter the reason for rejecting this ${what} (at least ${MIN_REJECTION_REASON_LEN} characters). The resident will see it.`;
}

app.patch("/requests/:id/status", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const id = String(req.params.id || "");
  const { status, note } = req.body || {};
  const safeNote =
    typeof note === "string" && note.trim() ? sanitizePlainTextField(note, MAX_STATUS_NOTE_LEN) : null;
  if (!isValidId(id)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid request id."
    });
  }

  const allowedStatuses = new Set(SERVICE_REQUEST_STATUSES);
  if (!status || !allowedStatuses.has(String(status))) {
    return res.status(400).json({
      ok: false,
      message: "Invalid status value."
    });
  }

  const nextStatus = String(status);
  const missingReason = rejectionReasonError(nextStatus, safeNote, "request");
  if (missingReason) {
    return res.status(400).json({ ok: false, message: missingReason });
  }
  let existing;
  try {
    existing = await ServiceRequest.findById(id).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to update request status.",
      detail: error.message
    });
  }
  if (!existing) {
    return res.status(404).json({
      ok: false,
      message: "Request not found."
    });
  }

  const transitionCheck = validateStaffServiceRequestTransition(existing.status, nextStatus);
  if (!transitionCheck.ok) {
    return res.status(400).json({
      ok: false,
      message: transitionCheck.message || "Invalid status transition."
    });
  }

  const nextTimeline = buildNextTimelineFromRow(existing, nextStatus, safeNote || "");

  let data;
  try {
    data = await ServiceRequest.findByIdAndUpdate(
      id,
      { $set: { status: nextStatus, statusTimeline: nextTimeline } },
      { new: true }
    ).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to update request status.",
      detail: error.message
    });
  }
  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Request not found."
    });
  }

  const requestRow = await normalizeRequestRowWithResident(data);
  broadcastRequestEvent({
    type: "status-updated",
    request: requestRow,
    note: safeNote
  });

  const auditCat = portalAuditCategoryForServiceRequestStatus(nextStatus);
  const prev = String(existing.status || "").trim();
  const svcLabel = String(existing.serviceType || "").trim() || String(existing.title || "").trim() || "—";
  const refNo = String(existing.referenceNo || id).trim();
  const oneLine = `Service request ${refNo} (${svcLabel}) status: ${prev}, changed to ${nextStatus}`;
  void insertPortalAuditEvent({
    action: auditCat,
    description: oneLine.slice(0, 2000),
    profile: auth.profile,
    metadata: {
      entity: "service_request",
      requestId: id,
      referenceNo: existing.referenceNo,
      previousStatus: prev,
      newStatus: nextStatus,
      serviceType: existing.serviceType,
      title: existing.title,
      staffNote: safeNote || null
    }
  });

  // Text the resident for the two statuses that need their attention (only on a real change).
  if (prev !== nextStatus) void notifyResidentOfRequestStatus(data, nextStatus, safeNote, auth.profile?.email);

  return res.json({
    ok: true,
    request: requestRow
  });
});

app.post("/requests", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;

  const { title, serviceType, preferredDate, preferredTimeSlot, purpose } = req.body || {};

  const safeTitle = sanitizePlainTextField(title, MAX_REQUEST_TITLE_LEN);
  const safePurpose = sanitizePlainTextField(purpose, MAX_REQUEST_PURPOSE_LEN);
  const safeServiceType = sanitizePlainTextField(serviceType, MAX_SERVICE_TYPE_LEN);
  const safePreferredDate = parseLocalDateString(preferredDate);
  const safeTimeSlot = sanitizePlainTextField(preferredTimeSlot, MAX_TIME_SLOT_LEN);

  if (!safeTitle || !safeServiceType || !safePreferredDate || !safeTimeSlot) {
    return res.status(400).json({
      ok: false,
      message: "title, serviceType, preferredDate, and preferredTimeSlot are required. Use YYYY-MM-DD for dates."
    });
  }
  if (!safePurpose) {
    return res.status(400).json({
      ok: false,
      message: "Purpose is required. Please state what the document is for."
    });
  }

  let slotCheck;
  try {
    slotCheck = await validateRequestTimeSlot(safeTimeSlot, safePreferredDate);
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to validate the time slot.", detail: error.message });
  }
  if (!slotCheck.ok) {
    return res.status(slotCheck.status).json({ ok: false, code: slotCheck.code, message: slotCheck.message });
  }

  let catalogRow;
  try {
    catalogRow = await ServiceCatalog.findOne({
      serviceName: safeServiceType,
      archivedAt: null,
      status: "Active"
    })
      .select("_id")
      .lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to validate service type.",
      detail: error.message
    });
  }
  if (!catalogRow) {
    return res.status(400).json({
      ok: false,
      message: "That service is not available for new requests. It may be inactive, under review, or removed."
    });
  }

  const referenceNo = `REQ-${Math.floor(1000 + Math.random() * 9000)}`;
  const resolvedResidentUserId = auth.residentUserId;
  const insertPayload = {
    referenceNo,
    title: safeTitle,
    serviceType: safeServiceType,
    preferredDate: safePreferredDate,
    preferredTimeSlot: safeTimeSlot,
    status: "Pending"
  };
  if (resolvedResidentUserId) {
    insertPayload.residentUserId = resolvedResidentUserId;
  }
  if (safePurpose) {
    insertPayload.purpose = safePurpose;
  }

  let data;
  try {
    data = await ServiceRequest.create(insertPayload);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to submit request.",
      detail: error.message
    });
  }

  const requestRow = normalizeRequestRow(data.toObject());
  broadcastRequestEvent({ type: "created", request: requestRow });

  return res.status(201).json({
    ok: true,
    message: "Request submitted successfully.",
    request: requestRow
  });
});

/** Staff may open the Document Generator unless their account has that permission switched off. */
async function requireDocumentGeneratorAccess(req, res) {
  // The Barangay Secretary (staff) has full access; no per-page permission switches any more.
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return null;
  return auth;
}

/**
 * Everything the Document Generator needs to pre-fill a certificate for one service request:
 * the request itself plus the resident's profile on file. Staff only; kept off the list
 * endpoints so personal details are only sent when a document is actually being prepared.
 */
app.get("/requests/:id/document-data", async (req, res) => {
  const auth = await requireDocumentGeneratorAccess(req, res);
  if (!auth) return;

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid request id." });
  }

  try {
    const row = await ServiceRequest.findById(id).lean();
    if (!row) return res.status(404).json({ ok: false, message: "Request not found." });

    const template = documentTemplateForServiceType(row.serviceType);
    if (!template) {
      return res.status(422).json({
        ok: false,
        message: `There is no document template for "${row.serviceType}" yet.`
      });
    }

    let resident = null;
    const residentId = parseResidentUserId(row.residentUserId);
    if (residentId) {
      const u = await User.findById(residentId).select("fullName email contactNumber residentProfile").lean();
      if (u) {
        const rp = u.residentProfile || {};
        const birth = rp.birthDate ? new Date(rp.birthDate) : null;
        resident = {
          fullName: String(u.fullName || "").trim(),
          email: u.email || "",
          contactNumber: u.contactNumber || "",
          sex: rp.sex || "",
          birthDate: birth && !Number.isNaN(birth.getTime()) ? birth.toISOString().slice(0, 10) : "",
          birthPlace: rp.birthPlace || "",
          civilStatus: rp.civilStatus || "",
          purok: rp.purok || "",
          address: rp.address || "",
          occupation: rp.occupation || ""
        };
      }
    }

    return res.json({
      ok: true,
      template,
      request: {
        id: String(row._id),
        referenceNo: row.referenceNo,
        serviceType: row.serviceType,
        purpose: row.purpose || "",
        status: row.status,
        preferredDate: row.preferredDate,
        createdAt: row.createdAt || null
      },
      resident
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to load document data.", detail: error.message });
  }
});

app.delete("/requests/:id", async (req, res) => {
  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid request id."
    });
  }

  let existing;
  try {
    existing = await ServiceRequest.findById(id).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to cancel request.",
      detail: error.message
    });
  }

  if (!existing) {
    return res.status(404).json({
      ok: false,
      message: "Request not found."
    });
  }

  if (actor.portal === "resident") {
    const ownerId = parseResidentUserId(existing.residentUserId);
    if (!ownerId || ownerId !== actor.residentUserId) {
      return res.status(403).json({
        ok: false,
        message: "You do not have access to this request."
      });
    }
  }

  // Cancelling keeps the record (status becomes "Cancelled") instead of removing it.
  const CANCELLABLE_REQUEST_STATUSES = new Set(["pending", "processing", "in progress", "revision requested", "approved"]);
  if (!CANCELLABLE_REQUEST_STATUSES.has(String(existing.status || "").trim().toLowerCase())) {
    return res.status(409).json({
      ok: false,
      message: `This request is already "${existing.status}" and can no longer be cancelled.`
    });
  }

  const cancelNote = actor.portal === "resident" ? "Cancelled by the resident." : "Cancelled by barangay personnel.";
  const nextTimeline = buildNextTimelineFromRow(existing, "Cancelled", cancelNote);

  let data;
  try {
    data = await ServiceRequest.findByIdAndUpdate(
      id,
      { $set: { status: "Cancelled", statusTimeline: nextTimeline } },
      { new: true }
    ).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to cancel request.",
      detail: error.message
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Request not found."
    });
  }

  const requestRow = await normalizeRequestRowWithResident(data);
  broadcastRequestEvent({ type: "status-updated", request: requestRow, note: cancelNote });

  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Cancelled service request ${existing.referenceNo || id} (${String(existing.serviceType || "").trim() || "—"}). Prior status: "${String(existing.status || "").trim() || "—"}".`,
    profile: actor.profile,
    metadata: {
      entity: "service_request",
      requestId: id,
      referenceNo: existing.referenceNo,
      serviceType: existing.serviceType,
      title: existing.title,
      status: "Cancelled",
      previousStatus: existing.status,
      portal: actor.portal
    }
  });

  return res.json({
    ok: true,
    request: requestRow
  });
});

app.get("/appointments", async (req, res) => {
  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  const filter = {};
  if (actor.portal === "resident") {
    filter.residentUserId = actor.residentUserId;
  } else {
    const requestedResidentUserId = parseResidentUserId(req.query?.residentUserId);
    if (requestedResidentUserId) {
      filter.residentUserId = requestedResidentUserId;
    }
  }

  let data;
  try {
    data = await Appointment.find(filter).sort({ appointmentDate: 1, createdAt: -1 }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load appointments.",
      detail: error.message
    });
  }

  const appointmentRows = data.map(normalizeAppointmentRow);
  return res.json({
    ok: true,
    appointments: actor.portal === "resident" ? appointmentRows : await attachResidentNamesToRows(appointmentRows)
  });
});

app.get("/appointments/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid appointment id."
    });
  }

  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  let data;
  try {
    data = await Appointment.findById(id).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load appointment.",
      detail: error.message
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Appointment not found."
    });
  }

  if (actor.portal === "resident") {
    const ownerId = parseResidentUserId(data.residentUserId);
    if (!ownerId || ownerId !== actor.residentUserId) {
      return res.status(403).json({
        ok: false,
        message: "You do not have access to this appointment."
      });
    }
  }

  const appointmentRow = await normalizeAppointmentRowWithResident(data);
  return res.json({
    ok: true,
    appointment: appointmentRow
  });
});

app.get("/appointments/by-reference/:referenceNo", async (req, res) => {
  const referenceNo = sanitizePlainTextField(req.params.referenceNo, 40);
  if (!referenceNo || referenceNo.length < 3) {
    return res.status(400).json({
      ok: false,
      message: "Invalid appointment reference number."
    });
  }

  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  let data;
  try {
    data = await Appointment.findOne({ referenceNo }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load appointment by reference.",
      detail: error.message
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Appointment not found."
    });
  }

  if (actor.portal === "resident") {
    const ownerId = parseResidentUserId(data.residentUserId);
    if (!ownerId || ownerId !== actor.residentUserId) {
      return res.status(404).json({
        ok: false,
        message: "Appointment not found."
      });
    }
  }

  const appointmentRowByRef = await normalizeAppointmentRowWithResident(data);
  return res.json({
    ok: true,
    appointment: appointmentRowByRef
  });
});

app.post("/appointments", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;

  const { purpose, appointmentDate, slotId } = req.body || {};

  const safePurpose = sanitizePlainTextField(purpose, MAX_APPOINTMENT_PURPOSE_LEN);
  const safeAppointmentDate = parseLocalDateString(appointmentDate);

  if (!safePurpose || !safeAppointmentDate || slotId === undefined || slotId === null || slotId === "") {
    return res.status(400).json({
      ok: false,
      message: "purpose, appointmentDate, and slotId are required."
    });
  }

  let purposeAllowed;
  try {
    purposeAllowed = await AppointmentPurposeCatalog.findOne({
      purposeCode: safePurpose,
      archivedAt: null
    })
      .select("_id")
      .lean();
  } catch (_error) {
    purposeAllowed = null;
  }

  if (!purposeAllowed) {
    return res.status(400).json({
      ok: false,
      message: "That appointment purpose is not available. Please refresh and choose a valid option."
    });
  }

  const parsedSlotId = String(slotId || "");
  if (!isValidId(parsedSlotId)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid slotId."
    });
  }

  const resolvedResidentUserId = auth.residentUserId;

  const capacity = await getAppointmentSlotCapacityForDate(parsedSlotId, safeAppointmentDate);
  if (!capacity) {
    return res.status(400).json({
      ok: false,
      message: "Selected time slot is unavailable."
    });
  }
  const slotClosure = await getSlotClosureForDate(parsedSlotId, safeAppointmentDate);
  if (slotClosure.isClosed) {
    return res.status(409).json({
      ok: false,
      code: "SLOT_CLOSED",
      message: slotClosedMessage(slotClosure.reason)
    });
  }
  const bookedCount = await countBookedAppointmentsForSlot(parsedSlotId, safeAppointmentDate);
  if (bookedCount === null) {
    return res.status(500).json({
      ok: false,
      message: "Unable to validate slot availability."
    });
  }
  if (bookedCount >= capacity) {
    return res.status(409).json({
      ok: false,
      code: "SLOT_FULL",
      message: "The slot selected is already full, select another slot."
    });
  }

  const referenceNo = `APT-${Math.floor(1000 + Math.random() * 9000)}`;
  const slotMeta = await AppointmentSlot.findById(parsedSlotId).select("label").lean();
  const insertPayload = {
    referenceNo,
    residentUserId: resolvedResidentUserId,
    purpose: safePurpose,
    appointmentDate: safeAppointmentDate,
    slotId: parsedSlotId,
    slotLabel: slotMeta?.label || null,
    status: "Pending Review"
  };

  let data;
  try {
    data = await Appointment.create(insertPayload);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to book appointment.",
      detail: error.message
    });
  }

  const appointmentRow = normalizeAppointmentRow(data.toObject());
  broadcastAppointmentEvent({ type: "created", appointment: appointmentRow });

  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Booked appointment ${referenceNo}. Date: ${safeAppointmentDate}. Time: ${appointmentRow.timeLabel || `slot ID ${parsedSlotId}`}. Purpose: ${safePurpose}. Status: ${appointmentRow.status || "Pending Review"}. Appointment ID: ${data?._id ?? "—"}.`,
    profile: auth.profile,
    performedByRole: "resident",
    metadata: {
      entity: "appointment",
      appointmentId: data?._id ? String(data._id) : null,
      referenceNo,
      appointmentDate: safeAppointmentDate,
      slotId: parsedSlotId,
      timeLabel: appointmentRow.timeLabel,
      purpose: safePurpose,
      status: appointmentRow.status
    }
  });

  return res.status(201).json({
    ok: true,
    message: "Appointment booked successfully.",
    appointment: appointmentRow
  });
});

app.patch("/appointments/:id/status", async (req, res) => {
  const staffAuth = await requireStaffPortalUser(req, res);
  if (!staffAuth) return;

  const id = String(req.params.id || "");
  const { status, note } = req.body || {};
  const safeNote =
    typeof note === "string" && note.trim() ? sanitizePlainTextField(note, MAX_STATUS_NOTE_LEN) : "";
  if (!isValidId(id)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid appointment id."
    });
  }

  const normalizedInputStatus = String(status || "").trim();
  const mappedStatus = (() => {
    const key = normalizedInputStatus.toLowerCase();
    if (key === "approved") return "Confirmed";
    if (key === "processing") return "Processing";
    if (key === "ready for pickup") return "Ready for Pickup";
    if (key === "in progress") return "Processing";
    if (key === "revision requested") return "Pending Review";
    if (key === "rejected") return "Rejected";
    if (
      key === "completed" ||
      key === "cancelled" ||
      key === "pending review" ||
      key === "confirmed"
    ) {
      return normalizedInputStatus;
    }
    return null;
  })();
  if (!mappedStatus) {
    return res.status(400).json({
      ok: false,
      message: "Invalid status value."
    });
  }
  const missingReason = rejectionReasonError(mappedStatus, safeNote, "appointment");
  if (missingReason) {
    return res.status(400).json({ ok: false, message: missingReason });
  }

  let existing;
  try {
    existing = await Appointment.findById(id).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to update appointment status.",
      detail: error.message
    });
  }
  if (!existing) {
    return res.status(404).json({
      ok: false,
      message: "Appointment not found."
    });
  }

  const transitionCheck = validateStaffAppointmentTransition(existing.status, mappedStatus);
  if (!transitionCheck.ok) {
    return res.status(400).json({
      ok: false,
      message: transitionCheck.message || "Invalid status transition."
    });
  }

  const nextTimeline = buildNextTimelineFromRow(existing, mappedStatus, safeNote || "");

  const updatePayload = { status: mappedStatus, statusTimeline: nextTimeline };
  if (safeNote) {
    updatePayload.notes = safeNote;
  }

  let data;
  try {
    data = await Appointment.findByIdAndUpdate(id, { $set: updatePayload }, { new: true }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to update appointment status.",
      detail: error.message
    });
  }
  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Appointment not found."
    });
  }

  const appointmentRow = await normalizeAppointmentRowWithResident(data);
  broadcastAppointmentEvent({
    type: "status-updated",
    appointment: appointmentRow,
    note: safeNote || null
  });

  const apAuditCat = portalAuditCategoryForAppointmentStatus(mappedStatus);
  const apPrev = String(existing.status || "").trim();
  const apNoteLine = safeNote ? ` Barangay Secretary note: ${safeNote}` : "";
  void insertPortalAuditEvent({
    action: apAuditCat,
    description: `Appointment ${existing.referenceNo || id} (${appointmentRow.timeLabel || `slot ID ${existing.slotId}`}): status "${apPrev}" → "${mappedStatus}". Date: ${String(existing.appointmentDate || "").trim() || "—"}. Purpose: "${String(existing.purpose || "").trim() || "—"}". Appointment ID: ${id}.${apNoteLine}`,
    profile: staffAuth.profile,
    metadata: {
      entity: "appointment",
      appointmentId: id,
      referenceNo: existing.referenceNo,
      previousStatus: apPrev,
      newStatus: mappedStatus,
      appointmentDate: existing.appointmentDate,
      purpose: existing.purpose,
      slotId: existing.slotId ? String(existing.slotId) : null,
      staffNote: safeNote || null
    }
  });

  return res.json({
    ok: true,
    appointment: appointmentRow
  });
});

app.delete("/appointments/:id", async (req, res) => {
  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid appointment id."
    });
  }

  let existing;
  try {
    existing = await Appointment.findById(id).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to cancel appointment.",
      detail: error.message
    });
  }

  if (!existing) {
    return res.status(404).json({
      ok: false,
      message: "Appointment not found."
    });
  }

  if (actor.portal === "resident") {
    const ownerId = parseResidentUserId(existing.residentUserId);
    if (!ownerId || ownerId !== actor.residentUserId) {
      return res.status(403).json({
        ok: false,
        message: "You do not have access to this appointment."
      });
    }
  }

  // Cancelling keeps the record (status becomes "Cancelled") and frees the slot.
  const CANCELLABLE_APPOINTMENT_STATUSES = new Set(["pending review", "processing", "confirmed"]);
  if (!CANCELLABLE_APPOINTMENT_STATUSES.has(String(existing.status || "").trim().toLowerCase())) {
    return res.status(409).json({
      ok: false,
      message: `This appointment is already "${existing.status}" and can no longer be cancelled.`
    });
  }

  const cancelNote = actor.portal === "resident" ? "Cancelled by the resident." : "Cancelled by barangay personnel.";
  const nextTimeline = buildNextTimelineFromRow(existing, "Cancelled", cancelNote);

  let data;
  try {
    data = await Appointment.findByIdAndUpdate(
      id,
      { $set: { status: "Cancelled", statusTimeline: nextTimeline } },
      { new: true }
    ).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to cancel appointment.",
      detail: error.message
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Appointment not found."
    });
  }

  const appointmentRow = await normalizeAppointmentRowWithResident(data);
  broadcastAppointmentEvent({ type: "status-updated", appointment: appointmentRow, note: cancelNote });

  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Cancelled appointment ${existing.referenceNo || id}. Prior status: "${String(existing.status || "").trim() || "—"}". Date: ${String(existing.appointmentDate || "").trim() || "—"}.`,
    profile: actor.profile,
    metadata: {
      entity: "appointment",
      appointmentId: id,
      referenceNo: existing.referenceNo,
      status: "Cancelled",
      previousStatus: existing.status,
      appointmentDate: existing.appointmentDate,
      purpose: existing.purpose,
      slotId: existing.slotId ? String(existing.slotId) : null,
      portal: actor.portal
    }
  });

  return res.json({ ok: true, appointment: appointmentRow });
});

// --- FAQ retrieval + AI answer (resident chatbot: Gemini, Groq backup) ---

app.post("/faq/search", faqSearchLimiter, async (req, res) => {
  const rawQuery = req.body?.query ?? req.body?.message ?? "";
  const query = sanitizePlainTextField(rawQuery, MAX_FAQ_SEARCH_QUERY_LEN);
  if (!query) {
    return res.status(400).json({ ok: false, message: "Query is required." });
  }

  let limit = Number(req.body?.limit);
  if (!Number.isInteger(limit) || limit <= 0) {
    limit = FAQ_SEARCH_TOP_LIMIT_DEFAULT;
  }
  limit = Math.min(limit, FAQ_SEARCH_TOP_LIMIT_MAX);

  const result = await retrieveFaqMatchesInternal(query, limit);
  if (!result.ok) {
    return res.status(500).json({
      ok: false,
      message: result.message,
      detail: result.detail
    });
  }

  return res.json({
    ok: true,
    query,
    matches: result.matches,
    bestScore: result.bestScore,
    confidence: result.confidence,
    minScoreUsed: FAQ_SEARCH_MIN_SCORE
  });
});

app.post("/faq/chat", faqChatLimiter, async (req, res) => {
  const rawQuery = req.body?.query ?? req.body?.message ?? "";
  const query = sanitizePlainTextField(rawQuery, MAX_FAQ_SEARCH_QUERY_LEN);
  if (!query) {
    return res.status(400).json({ ok: false, message: "Query is required." });
  }

  let limit = Number(req.body?.limit ?? req.body?.contextLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    limit = FAQ_SEARCH_TOP_LIMIT_DEFAULT;
  }
  limit = Math.min(limit, FAQ_CHAT_CONTEXT_MAX);

  const history = sanitizeChatHistory(req.body?.history);
  // A very short follow-up ("how much?") is matched together with the resident's previous question.
  const lastResidentTurn = [...history].reverse().find((h) => h.role === "user");
  const retrievalQuery =
    lastResidentTurn && tokenizeForFaqSearch(normalizeFaqSearchText(query)).length < 4
      ? `${lastResidentTurn.content} ${query}`.slice(0, MAX_FAQ_SEARCH_QUERY_LEN)
      : query;

  const retrieved = await retrieveFaqMatchesInternal(retrievalQuery, limit);
  if (!retrieved.ok) {
    return res.status(500).json({
      ok: false,
      message: retrieved.message,
      detail: retrieved.detail
    });
  }

  // Give the model every active FAQ (best keyword matches first). Keyword search is English-heavy, so a Tagalog
  // question may match nothing; the model can still read the whole short FAQ list and answer from it.
  const startedAt = Date.now();
  const loadAllFaqs = async () => {
    if (!isAiConfigured()) return retrieved.matches;
    try {
      const allRows = await FaqEntry.find({ isActive: true }).sort({ sortOrder: 1 }).limit(30).lean();
      const seen = new Set(retrieved.matches.map((m) => m.id));
      const rest = allRows.filter((row) => !seen.has(String(row._id))).map((row) => normalizeFaqMatch(row, 0, []));
      return [...retrieved.matches, ...rest];
    } catch (_e) {
      return retrieved.matches; // keep keyword matches only
    }
  };
  // Run the two database lookups at the same time instead of one after the other.
  const [contextMatches, facts] = await Promise.all([loadAllFaqs(), buildChatFactsBlock()]);

  const sources = retrieved.matches.map((m) => ({ id: m.id, question: m.question, category: m.category }));
  const dbMs = Date.now() - startedAt;
  const ai = await askChatbot({ question: query, matches: contextMatches, facts, history });
  console.log(`[faq/chat] db=${dbMs}ms ai=${Date.now() - startedAt - dbMs}ms ${ai.ok ? `${ai.provider}/${ai.model || ""}${ai.cached ? " (cached)" : ""} intent=${ai.intent}` : `failed: ${ai.reason}`}`);

  if (ai.ok) {
    // Off-topic and "not covered" replies are fixed messages, never model-written text.
    if (ai.intent === "off_topic") {
      return res.json({ ok: true, reply: OFF_TOPIC_REPLY, mode: "off_topic", language: ai.language, provider: ai.provider, sources: [] });
    }
    if (ai.intent === "not_covered") {
      return res.json({ ok: true, reply: NOT_COVERED_REPLY, mode: "no_match", language: ai.language, provider: ai.provider, confidence: retrieved.confidence, sources: [] });
    }
    return res.json({
      ok: true,
      reply: sanitizeChatReply(ai.reply),
      mode: ai.intent === "greeting" ? "greeting" : "ai",
      language: ai.language,
      provider: ai.provider,
      model: ai.model,
      cached: Boolean(ai.cached),
      confidence: retrieved.confidence,
      sources: ai.intent === "greeting" ? [] : sources
    });
  }

  // No AI available (no key, quota used up, or outage): fall back to the stored FAQ answer word for word, if one matched.
  if (!retrieved.matches.length) {
    return res.json({
      ok: true,
      reply: NOT_COVERED_REPLY,
      mode: "no_match",
      aiUnavailable: ai.reason,
      confidence: retrieved.confidence,
      sources: []
    });
  }
  return res.json({
    ok: true,
    reply: sanitizeChatReply(retrieved.matches[0].answer),
    mode: "verbatim_fallback",
    aiUnavailable: ai.reason,
    confidence: retrieved.confidence,
    sources
  });
});

// --- Community announcements (resident bulletin; admin creates) ---

app.get("/announcements", async (_req, res) => {
  let announcements;
  try {
    announcements = await CommunityAnnouncement.find({ isActive: true, archivedAt: null })
      .sort({ createdAt: -1 })
      .lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load announcements.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    announcements: announcements.map(normalizeAnnouncementRow)
  });
});

app.get("/resident/announcements", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;

  const filter = { isActive: true, archivedAt: null };
  const filterRole = String(req.query?.postedByRole ?? "").trim();
  if (filterRole === "admin" || filterRole === "staff") filter.postedByRole = { $in: ["admin", "staff"] };

  let announcements;
  try {
    announcements = await CommunityAnnouncement.find(filter).sort({ createdAt: -1 }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load announcements.",
      detail: error.message
    });
  }
  return res.json({
    ok: true,
    announcements: announcements.map(normalizeAnnouncementRow)
  });
});

// ---- SMS (TextBee) for announcements ----
// Announcement SMS goes ONLY to residents marked "Head of the family" in Resident Profiling (one text per
// household). Request-status SMS is separate: it always goes to the resident who made the request.
const isHouseholdHeadRow = (row) => row?.residentProfile?.isHouseholdHead === true;

async function loadSmsEligibleRows() {
  return User.find({
    role: "resident",
    isActive: true,
    accountStatus: "active",
    smsOptOut: { $ne: true },
    contactNumber: { $nin: [null, ""] }
  })
    .select("contactNumber residentProfile.purok residentProfile.isHouseholdHead")
    .lean();
}

function parseSmsPuroks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => String(v || "").trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 50);
}

/** Valid +639… numbers of opted-in heads of family, optionally limited to the given puroks. */
async function collectResidentSmsNumbers(puroks) {
  const rows = (await loadSmsEligibleRows()).filter(isHouseholdHeadRow);
  const want = Array.isArray(puroks) && puroks.length ? new Set(puroks.map((p) => p.toLowerCase())) : null;
  const valid = new Set();
  const userIds = {}; // number -> resident id (first resident wins when a family shares a number)
  let invalid = 0;
  for (const row of rows) {
    const purok = String(row.residentProfile?.purok || "").trim().toLowerCase();
    if (want && !want.has(purok)) continue;
    const n = normalizePhNumber(row.contactNumber);
    if (n) {
      valid.add(n);
      if (!userIds[n]) userIds[n] = String(row._id);
    } else invalid += 1;
  }
  return { numbers: [...valid], invalid, userIds };
}

function buildAnnouncementSms({ category, title, body }) {
  const head = `Barangay Burgos - ${category}\n${title}\n`;
  const room = Math.max(0, 300 - head.length);
  const text = String(body || "").replace(/\s+/g, " ").trim();
  const tail = text.length > room ? text.slice(0, Math.max(0, room - 1)).trimEnd() + "…" : text;
  return head + tail;
}

app.get("/admin/sms/recipient-count", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  try {
    const selected = parseSmsPuroks(String(req.query?.puroks || "").split("|"));
    const eligibleRows = await loadSmsEligibleRows();
    const rows = eligibleRows.filter(isHouseholdHeadRow);
    const notHead = eligibleRows.length - rows.length;   // opted-in residents skipped because they are not a head of family
    const groups = new Map();
    let noPurok = 0;
    for (const row of rows) {
      if (!normalizePhNumber(row.contactNumber)) continue;
      const name = String(row.residentProfile?.purok || "").trim();
      if (!name) { noPurok += 1; continue; }
      const key = name.toLowerCase();
      const g = groups.get(key) || { name, count: 0 };
      g.count += 1;
      groups.set(key, g);
    }
    const puroks = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const total = puroks.reduce((n, g) => n + g.count, 0) + noPurok;
    const { numbers } = await collectResidentSmsNumbers(selected);
    const optedOut = await User.countDocuments({
      role: "resident", isActive: true, accountStatus: "active", smsOptOut: true, contactNumber: { $nin: [null, ""] }
    });
    return res.json({
      ok: true,
      configured: isSmsConfigured(),
      recipients: numbers.length,
      notHead,
      totalEligible: total,
      puroks,
      noPurok,
      optedOut
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to count SMS recipients.", detail: error.message });
  }
});

app.post("/admin/announcements", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const { category, title, body } = req.body || {};
  const safeTitle = sanitizePlainTextField(title, MAX_ANNOUNCEMENT_TITLE_LEN);
  const safeBody = sanitizePlainTextField(body, MAX_ANNOUNCEMENT_BODY_LEN);
  const safeCategory = sanitizePlainTextField(category || "Community News", MAX_ANNOUNCEMENT_CATEGORY_LEN);

  if (!safeTitle) {
    return res.status(400).json({ ok: false, message: "Title is required." });
  }
  if (!safeBody) {
    return res.status(400).json({ ok: false, message: "Announcement details are required." });
  }

  let created;
  try {
    created = await CommunityAnnouncement.create({
      category: safeCategory || "Community News",
      title: safeTitle,
      body: safeBody,
      isActive: true,
      postedByRole: auth.profile?.role ?? null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to post announcement.",
      detail: error.message
    });
  }

  const createdRow = normalizeAnnouncementRow(created.toObject());
  broadcastAnnouncementEvent({ type: "created", announcement: createdRow });

  // Optional SMS blast via TextBee (runs in the background so posting stays fast).
  let smsInfo = { requested: false };
  if (req.body?.sendSms === true) {
    if (!isSmsConfigured()) {
      smsInfo = { requested: true, queued: 0, message: "SMS is not configured on the server." };
    } else {
      try {
        const smsPuroks = parseSmsPuroks(req.body?.smsPuroks);
        const { numbers, invalid, userIds } = await collectResidentSmsNumbers(smsPuroks);
        const smsText = buildAnnouncementSms({ category: safeCategory || "Community News", title: safeTitle, body: safeBody });
        smsInfo = { requested: true, queued: numbers.length, skippedInvalid: invalid, puroks: smsPuroks };
        if (numbers.length) {
          void sendSmsBatch(numbers, smsText, {
            purpose: "announcement",
            relatedType: "announcement",
            relatedId: createdRow.id,
            createdByEmail: auth.profile?.email || null,
            userIds
          }).then((r) => {
            console.log(`[sms] announcement ${createdRow.id}: sent ${r.sent}, failed ${r.failed}`, r.errors);
            void insertPortalAuditEvent({
              action: "Updated Record",
              description: `SMS for announcement ID ${createdRow.id}: ${r.sent} sent, ${r.failed} failed.`,
              profile: auth.profile,
              metadata: { entity: "announcement_sms", announcementId: createdRow.id, sent: r.sent, failed: r.failed, puroks: smsPuroks }
            });
          });
        }
      } catch (error) {
        smsInfo = { requested: true, queued: 0, message: "Announcement posted, but SMS could not be started." };
        console.error("[sms] failed to start:", error.message);
      }
    }
  }

  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Posted community announcement ID ${createdRow.id}. Category: "${safeCategory}". Title: "${safeTitle}". Posted by role: ${createdRow.postedByRole || auth.profile?.role || "—"}.`,
    profile: auth.profile,
    metadata: {
      entity: "community_announcement",
      announcementId: createdRow.id,
      category: safeCategory,
      title: safeTitle,
      postedByRole: createdRow.postedByRole
    }
  });

  return res.status(201).json({
    ok: true,
    message: "Announcement posted.",
    announcement: createdRow,
    sms: smsInfo
  });
});

/** List all announcements (including inactive) for admin reporting table. */
app.get("/admin/announcements", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "staff") {
    return res.status(403).json({ ok: false, message: "Barangay Secretary role required to list announcements." });
  }

  let announcements;
  try {
    announcements = await CommunityAnnouncement.find({}).sort({ createdAt: -1 }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load announcements.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    announcements: announcements.map(normalizeAnnouncementRow)
  });
});

/** Archive an announcement (admin only). It is hidden from residents but kept in the records. */
app.post("/admin/announcements/:id/archive", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "staff") {
    return res.status(403).json({
      ok: false,
      message: "Admin role required to archive announcements."
    });
  }

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid announcement id." });
  }

  let existing;
  try {
    existing = await CommunityAnnouncement.findById(id).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to verify announcement.",
      detail: error.message
    });
  }
  if (!existing) {
    return res.status(404).json({ ok: false, message: "Announcement not found." });
  }
  if (existing.archivedAt) {
    return res.status(409).json({ ok: false, message: "Announcement is already archived." });
  }

  try {
    await CommunityAnnouncement.findByIdAndUpdate(id, { $set: { archivedAt: new Date(), isActive: false } });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to archive announcement.",
      detail: error.message
    });
  }

  // Residents' boards drop the post the same way they did when it was deleted.
  broadcastAnnouncementEvent({ type: "deleted", id });

  void insertPortalAuditEvent({
    action: "Archived Record",
    description: `Archived community announcement ID ${id}. Title: "${String(existing.title || "").trim() || "—"}". Category: "${String(existing.category || "").trim() || "—"}".`,
    profile: auth.profile,
    metadata: {
      entity: "community_announcement",
      announcementId: id,
      title: existing.title,
      category: existing.category,
      postedByRole: existing.postedByRole,
      createdAt: existing.createdAt
    }
  });

  return res.json({ ok: true, message: "Announcement archived." });
});

/** Restore an archived announcement (admin only). */
app.post("/admin/announcements/:id/restore", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "staff") {
    return res.status(403).json({ ok: false, message: "Admin role required to restore announcements." });
  }

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid announcement id." });
  }

  let restored;
  try {
    restored = await CommunityAnnouncement.findOneAndUpdate(
      { _id: id, archivedAt: { $ne: null } },
      { $set: { archivedAt: null, isActive: true } },
      { new: true }
    ).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to restore announcement.",
      detail: error.message
    });
  }
  if (!restored) {
    return res.status(404).json({ ok: false, message: "Archived announcement not found." });
  }

  broadcastAnnouncementEvent({ type: "created", announcement: normalizeAnnouncementRow(restored) });

  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Restored archived community announcement ID ${id}. Title: "${String(restored.title || "").trim() || "—"}".`,
    profile: auth.profile,
    metadata: { entity: "community_announcement", announcementId: id, title: restored.title }
  });

  return res.json({ ok: true, message: "Announcement restored." });
});

// ---- Announcement drafts (admin only) ----

function normalizeAnnouncementDraftRow(row) {
  return {
    id: String(row._id),
    category: row.category || "Community News",
    title: row.title || "",
    body: row.body || "",
    sendSms: row.sendSms !== false,
    smsAudience: row.smsAudience === "puroks" ? "puroks" : "all",
    smsPuroks: Array.isArray(row.smsPuroks) ? row.smsPuroks : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function buildAnnouncementDraftFields(reqBody) {
  const { category, title, body, sendSms, smsAudience, smsPuroks } = reqBody || {};
  return {
    category: sanitizePlainTextField(category || "Community News", MAX_ANNOUNCEMENT_CATEGORY_LEN) || "Community News",
    title: sanitizePlainTextField(title, MAX_ANNOUNCEMENT_TITLE_LEN),
    body: sanitizePlainTextField(body, MAX_ANNOUNCEMENT_BODY_LEN),
    sendSms: sendSms !== false,
    smsAudience: smsAudience === "puroks" ? "puroks" : "all",
    smsPuroks: (Array.isArray(smsPuroks) ? smsPuroks : [])
      .map((p) => sanitizePlainTextField(p, 80))
      .filter(Boolean)
      .slice(0, 100)
  };
}

async function requireAdminForDrafts(req, res) {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return null;
  if (auth.profile.role !== "staff") {
    res.status(403).json({ ok: false, message: "Barangay Secretary role required to manage announcement drafts." });
    return null;
  }
  return auth;
}

app.get("/admin/announcement-drafts", async (req, res) => {
  const auth = await requireAdminForDrafts(req, res);
  if (!auth) return;
  try {
    const drafts = await AnnouncementDraft.find({}).sort({ updatedAt: -1 }).lean();
    return res.json({ ok: true, drafts: drafts.map(normalizeAnnouncementDraftRow) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to load drafts.", detail: error.message });
  }
});

/** Create a draft, or update an existing one when body.id is provided. */
app.post("/admin/announcement-drafts", async (req, res) => {
  const auth = await requireAdminForDrafts(req, res);
  if (!auth) return;

  const fields = buildAnnouncementDraftFields(req.body);
  if (!fields.title && !fields.body) {
    return res.status(400).json({ ok: false, message: "Enter a title or details before saving a draft." });
  }

  const id = String(req.body?.id || "").trim();
  try {
    let saved;
    if (id) {
      if (!isValidId(id)) {
        return res.status(400).json({ ok: false, message: "Invalid draft id." });
      }
      saved = await AnnouncementDraft.findByIdAndUpdate(id, { $set: fields }, { new: true }).lean();
      if (!saved) {
        return res.status(404).json({ ok: false, message: "Draft not found. It may have been deleted." });
      }
    } else {
      const created = await AnnouncementDraft.create({
        ...fields,
        createdByRole: auth.profile?.role ?? "staff",
        createdById: String(auth.profile?.id ?? auth.profile?._id ?? "") || null
      });
      saved = created.toObject();
    }
    return res.json({ ok: true, message: "Draft saved.", draft: normalizeAnnouncementDraftRow(saved) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to save draft.", detail: error.message });
  }
});

app.delete("/admin/announcement-drafts/:id", async (req, res) => {
  const auth = await requireAdminForDrafts(req, res);
  if (!auth) return;
  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid draft id." });
  }
  try {
    const removed = await AnnouncementDraft.findByIdAndDelete(id).lean();
    if (!removed) return res.status(404).json({ ok: false, message: "Draft not found." });
    return res.json({ ok: true, message: "Draft deleted." });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to delete draft.", detail: error.message });
  }
});

// --- Admin reports & analytics ---

function pctCompleted(completed, total) {
  const t = Number(total);
  const c = Number(completed);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (!Number.isFinite(c) || c <= 0) return 0;
  return Math.round((c / t) * 1000) / 10;
}

/** Inclusive office-hour window for peak-hours chart (9 AM–5 PM bars; excludes 8 AM / 6 PM). */
const ANALYTICS_HOURLY_CHART_START_HOUR = 8;
const ANALYTICS_HOURLY_CHART_END_HOUR = 17;

/**
 * Parse one side of a time range (e.g. "09:00 AM", "14:30", "1200") to hour 0–23 (start of window).
 */
function parseClockSegmentToHour24(segment) {
  const firstSegment = String(segment ?? "").trim();
  if (!firstSegment) return null;
  if (/\b(AM|PM)\b/i.test(firstSegment)) {
    const m = firstSegment.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const ap = m[3].toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    if (!Number.isInteger(h) || h < 0 || h > 23) return null;
    return h;
  }
  /** Noon marker used in portal copy (e.g. "12:00 NN"). */
  if (/\bNN\b/i.test(firstSegment)) {
    const m = firstSegment.match(/\b(\d{1,2})(?::(\d{2}))?\s*NN\b/i);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    if (h === 12) return 12;
    return null;
  }
  const m24 = firstSegment.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  }
  const digitRun = firstSegment.replace(/\D/g, "");
  if (digitRun.length >= 3 && digitRun.length <= 4 && /^\d+$/.test(digitRun)) {
    const pad = digitRun.padStart(4, "0").slice(-4);
    const h = parseInt(pad.slice(0, 2), 10);
    if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  }
  return null;
}

/** Parse slot label, time range, or HHMM `slot_code` to hour 0–23 (start of window). */
function parseClockToHour24(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const segments = raw.split(/\s*[–-]\s*/u).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const h = parseClockSegmentToHour24(seg);
    if (h !== null) return h;
  }
  /** e.g. "0900-1000" or "09:00-10:00" → digits "09001000" — use first HHMM as start hour */
  const digitRun = raw.replace(/\D/g, "");
  if (digitRun.length === 8 && /^\d+$/.test(digitRun)) {
    const pad = digitRun.slice(0, 4).padStart(4, "0");
    const h = parseInt(pad.slice(0, 2), 10);
    if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  }
  if (digitRun.length >= 3 && digitRun.length <= 4 && /^\d+$/.test(digitRun)) {
    const pad = digitRun.padStart(4, "0").slice(-4);
    const h = parseInt(pad.slice(0, 2), 10);
    if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  }
  return null;
}

function hourFitsAnalyticsChart(hour24) {
  if (!Number.isInteger(hour24)) return null;
  if (hour24 < ANALYTICS_HOURLY_CHART_START_HOUR || hour24 > ANALYTICS_HOURLY_CHART_END_HOUR) return null;
  return hour24;
}

function formatAnalyticsHourAxisLabel(hour24) {
  if (hour24 === 12) return "12 NN";
  if (hour24 < 12) return `${hour24} AM`;
  return `${hour24 - 12} PM`;
}

/** Bar chart order: 8 AM first, then forward through the day. */
function analyticsSlotBarOrderKey(hour24) {
  if (!Number.isInteger(hour24) || hour24 < 0 || hour24 > 23) return 1000;
  return (hour24 + 16) % 24;
}

function appointmentPreferredStartHour24(slot) {
  if (slot && slot.slotCode != null && String(slot.slotCode).trim()) {
    const fromCode = parseClockToHour24(String(slot.slotCode).trim());
    if (fromCode !== null) return fromCode;
  }
  if (slot && slot.label) {
    return parseClockToHour24(String(slot.label));
  }
  return null;
}

app.get("/admin/analytics/hourly-demand", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "staff") {
    return res.status(403).json({
      ok: false,
      message: "Barangay Secretary role required to view hourly demand analytics."
    });
  }

  const fromDate = parseLocalDateString(req.query?.from);
  const toDate = parseLocalDateString(req.query?.to);

  const reqFilter = {};
  if (fromDate || toDate) {
    reqFilter.preferredDate = {};
    if (fromDate) reqFilter.preferredDate.$gte = fromDate;
    if (toDate) reqFilter.preferredDate.$lte = toDate;
  }
  const apptFilter = {};
  if (fromDate || toDate) {
    apptFilter.appointmentDate = {};
    if (fromDate) apptFilter.appointmentDate.$gte = fromDate;
    if (toDate) apptFilter.appointmentDate.$lte = toDate;
  }

  let reqRows, apptRows;
  try {
    [reqRows, apptRows] = await Promise.all([
      ServiceRequest.find(reqFilter).select("preferredTimeSlot preferredDate").limit(10000).lean(),
      Appointment.find(apptFilter).select("appointmentDate status slotId").limit(10000).lean()
    ]);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load analytics data.",
      detail: error.message
    });
  }

  const slotIdStrs = [...new Set(apptRows.map((r) => (r.slotId ? String(r.slotId) : null)).filter(Boolean))];

  let catalogSlots;
  try {
    catalogSlots = await AppointmentSlot.find({}).select("slotCode label").sort({ slotCode: 1 }).lean();
  } catch (_error) {
    catalogSlots = [];
  }

  // Every appointment's slotId should reference a slot already in the
  // catalog (slots aren't deleted, only deactivated), so unlike the old
  // Postgres version there's no need for a separate "missing slot ids"
  // backfill query here — kept the catalog-fetch-first structure anyway
  // in case a slot was hard-deleted by direct DB edit.
  const catalogIdSet = new Set(catalogSlots.map((s) => String(s._id)));
  const missingSlotIds = slotIdStrs.filter((id) => !catalogIdSet.has(id));
  if (missingSlotIds.length) {
    try {
      const extraSlots = await AppointmentSlot.find({ _id: { $in: missingSlotIds } })
        .select("slotCode label")
        .lean();
      const merged = new Map(catalogSlots.map((s) => [String(s._id), s]));
      for (const s of extraSlots) merged.set(String(s._id), s);
      catalogSlots = [...merged.values()];
    } catch (_error) {
      /* best-effort; proceed with what we have */
    }
  }

  catalogSlots.sort((a, b) => {
    const ha = appointmentPreferredStartHour24(a);
    const hb = appointmentPreferredStartHour24(b);
    const ka = analyticsSlotBarOrderKey(ha);
    const kb = analyticsSlotBarOrderKey(hb);
    return (
      ka - kb ||
      String(a.slotCode || "").localeCompare(String(b.slotCode || "")) ||
      String(a._id).localeCompare(String(b._id))
    );
  });

  /** One bar per appointment slot in the catalog (no office-hour filter). `hour` is slot start for insight when parseable. */
  const buckets = [];
  const bucketBySlotId = new Map();
  const bucketByStartHour = new Map();
  for (const slot of catalogSlots) {
    const sid = String(slot._id);
    const hourRaw = appointmentPreferredStartHour24(slot);
    const hour24 = Number.isInteger(hourRaw) ? hourRaw : null;
    const b = {
      slotId: sid,
      hour: hour24,
      label:
        String(slot.label || "").trim() ||
        (hour24 !== null ? formatAnalyticsHourAxisLabel(hour24) : `Slot ${sid}`),
      requests: 0,
      appointments: 0,
      total: 0
    };
    buckets.push(b);
    bucketBySlotId.set(sid, b);
    if (hour24 !== null && !bucketByStartHour.has(hour24)) bucketByStartHour.set(hour24, b);
  }

  let unbucketedRequests = 0;
  for (const row of reqRows) {
    const rawPref = String(row.preferredTimeSlot ?? "").trim();
    let b = null;
    if (rawPref) {
      for (const slot of catalogSlots) {
        const lab = String(slot.label ?? "").trim();
        if (lab && rawPref === lab) {
          b = bucketBySlotId.get(String(slot._id)) || null;
          break;
        }
      }
    }
    if (!b) {
      const hourParsed = parseClockToHour24(row.preferredTimeSlot);
      if (Number.isInteger(hourParsed)) b = bucketByStartHour.get(hourParsed) || null;
    }
    if (!b) {
      unbucketedRequests += 1;
      continue;
    }
    b.requests += 1;
    b.total += 1;
  }

  let unbucketedAppointments = 0;
  const skipApptStatus = new Set(["Cancelled", "Rejected"]);
  for (const row of apptRows) {
    if (skipApptStatus.has(String(row.status || ""))) continue;
    const sid = row.slotId ? String(row.slotId) : null;
    if (!sid) {
      unbucketedAppointments += 1;
      continue;
    }
    const b = bucketBySlotId.get(sid);
    if (!b) {
      unbucketedAppointments += 1;
      continue;
    }
    b.appointments += 1;
    b.total += 1;
  }

  const maxTotal = buckets.reduce((m, b) => Math.max(m, b.total), 0);
  let peakHour = null;
  for (const b of buckets) {
    if (b.total <= 0) continue;
    if (peakHour === null || b.total > peakHour.total) peakHour = b;
  }

  return res.json({
    ok: true,
    bucketKind: "appointment_slot",
    chartStartHour: ANALYTICS_HOURLY_CHART_START_HOUR,
    chartEndHour: ANALYTICS_HOURLY_CHART_END_HOUR,
    /** How bars are built: one column per configured slot; appointments by `slot_id`, requests by preferred time mapped to same slot start. */
    demandSourceNote:
      "Every configured appointment slot appears as its own column. Service requests attach by exact preferred-time label match, else by parsed start hour; appointments attach by booking slot.",
    dateFilter: {
      from: fromDate,
      to: toDate
    },
    buckets,
    maxTotal,
    peakHour: peakHour
      ? {
          slotId: peakHour.slotId,
          hour: peakHour.hour,
          label: peakHour.label,
          total: peakHour.total,
          requests: peakHour.requests,
          appointments: peakHour.appointments
        }
      : null,
    unbucketedRequests,
    unbucketedAppointments
  });
});

app.get("/admin/analytics/summary", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "staff") {
    return res.status(403).json({
      ok: false,
      message: "Barangay Secretary role required to view analytics."
    });
  }

  let requestsTotal, requestsCompleted, appointmentsTotal, appointmentsCompleted;
  try {
    [requestsTotal, requestsCompleted, appointmentsTotal, appointmentsCompleted] = await Promise.all([
      ServiceRequest.countDocuments({}),
      ServiceRequest.countDocuments({ status: "Completed" }),
      Appointment.countDocuments({}),
      Appointment.countDocuments({ status: "Completed" })
    ]);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load analytics counts.",
      detail: error.message
    });
  }

  const totalRequestsAndAppointments = requestsTotal + appointmentsTotal;
  const completedTotal = requestsCompleted + appointmentsCompleted;
  const overallCompletionRatePercent = pctCompleted(completedTotal, totalRequestsAndAppointments);

  let activeResidents;
  try {
    activeResidents = await User.countDocuments(confirmedResidentQuery({ isActive: true }));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to count active residents.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    totalRequestsAndAppointments,
    requestsTotal,
    appointmentsTotal,
    requestsCompleted,
    appointmentsCompleted,
    overallCompletionRatePercent,
    requestsCompletionRatePercent: pctCompleted(requestsCompleted, requestsTotal),
    appointmentsCompletionRatePercent: pctCompleted(appointmentsCompleted, appointmentsTotal),
    activeResidents
  });
});

function sanitizeSummaryForDecisionInsight(s) {
  if (!s || typeof s !== "object") return {};
  return {
    totalRequestsAndAppointments: s.totalRequestsAndAppointments,
    requestsTotal: s.requestsTotal,
    appointmentsTotal: s.appointmentsTotal,
    requestsCompleted: s.requestsCompleted,
    appointmentsCompleted: s.appointmentsCompleted,
    overallCompletionRatePercent: s.overallCompletionRatePercent,
    requestsCompletionRatePercent: s.requestsCompletionRatePercent,
    appointmentsCompletionRatePercent: s.appointmentsCompletionRatePercent,
    activeResidents: s.activeResidents
  };
}

function sanitizeHourlyDemandForDecisionInsight(h) {
  if (!h || typeof h !== "object") {
    return {
      bucketKind: null,
      chartStartHour: null,
      chartEndHour: null,
      maxTotal: 0,
      peakHour: null,
      buckets: [],
      unbucketedRequests: 0,
      unbucketedAppointments: 0,
      dateFilter: null
    };
  }
  const buckets = Array.isArray(h.buckets)
    ? h.buckets.map((b) => ({
        hour: b.hour,
        slotId: b.slotId,
        label: b.label,
        requests: b.requests,
        appointments: b.appointments,
        total: b.total
      }))
    : [];
  return {
    bucketKind: h.bucketKind,
    chartStartHour: h.chartStartHour,
    chartEndHour: h.chartEndHour,
    maxTotal: h.maxTotal,
    peakHour: h.peakHour ?? null,
    buckets,
    unbucketedRequests: h.unbucketedRequests,
    unbucketedAppointments: h.unbucketedAppointments,
    dateFilter: h.dateFilter ?? null
  };
}

function buildBarangayDecisionInsightFallback(summary, hourlyDemand) {
  const parts = [];
  const overall = Number(summary?.overallCompletionRatePercent);
  const total = Number(summary?.totalRequestsAndAppointments) || 0;
  const reqPct = Number(summary?.requestsCompletionRatePercent);
  const apptPct = Number(summary?.appointmentsCompletionRatePercent);

  if (Number.isFinite(overall) && total > 0 && overall < 65) {
    parts.push(
      `Overall completion is about ${overall}%, which is low for steady barangay operations. Prioritise clearing the oldest pending requests, verify resident contact details, and hold a brief daily triage so nothing stalls more than a few days.`
    );
  } else if (Number.isFinite(overall) && total > 0) {
    parts.push(
      `Overall completion is about ${overall}%. Keep documenting turnaround times and watch for any single service type dragging the average down.`
    );
  }

  if (
    Number.isFinite(reqPct) &&
    Number.isFinite(apptPct) &&
    total > 0 &&
    reqPct + 8 < apptPct
  ) {
    parts.push(
      `Document request completion (${reqPct}%) is noticeably weaker than appointment completion (${apptPct}%); consider dedicating more staff time to request processing or simplifying documentary requirements where policy allows.`
    );
  }

  const peak = hourlyDemand?.peakHour;
  const maxT = Number(hourlyDemand?.maxTotal) || 0;
  if (peak && Number(peak.total) > 0 && maxT > 0) {
    const concentration = peak.total / maxT;
    if (concentration >= 0.42 && peak.total >= 5) {
      parts.push(
        `Demand is concentrated around ${peak.label} (${peak.total} requests and appointments in that time slot). Adding counter staff or staggering breaks during that window usually reduces queues more than uniform staffing all day.`
      );
    } else {
      parts.push(
        `The busiest time slot is ${peak.label} with ${peak.total} combined bookings; align clerk breaks so coverage stays strong in that window.`
      );
    }
  }

  const ub =
    (Number(hourlyDemand?.unbucketedRequests) || 0) + (Number(hourlyDemand?.unbucketedAppointments) || 0);
  if (ub > 0) {
    parts.push(
      `${ub} booking(s) could not be placed on the hourly chart; standardising preferred time labels in the portal will improve future staffing decisions.`
    );
  }

  if (!parts.length) {
    return "Collect a few more weeks of bookings with consistent time slots, then revisit staffing. There is not enough structured volume yet for a strong barangay-specific recommendation.";
  }
  return parts.join(" ");
}

async function groqBarangayDecisionInsight(context) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || GROQ_CHAT_DEFAULT_MODEL;
  if (!apiKey) return null;

  const system = `You are an experienced advisor helping a Philippine BARANGAY (local government unit) front office deliver citizen services: clearances, certificates, appointments for pickup, and similar desk work.

You receive JSON with:
- summary: counts of service requests and appointments, completion rates (percent), and active portal residents.
- hourlyDemand: per appointment time slot (barangay schedule), totals from residents' preferred time on service requests (matched by slot start or exact label) and appointments by chosen slot_id; peakHour.slotId/label refer to busiest slot; includes unbucketed counts.

Write exactly ONE paragraph in clear English (100–220 words) with practical recommendations for the Barangay Captain, Secretary, or clerks: staffing at peak windows, reducing backlog when completion is low, communicating with residents, slot or queue policy, or follow-up. Use ONLY numbers and facts from the JSON; never invent statistics. If data is very sparse, say so briefly and suggest what to track next. Plain text only; no markdown, bullets, or headings.`;

  const userMsg = `Analytics JSON:\n${JSON.stringify(context, null, 2)}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg }
      ],
      temperature: 0.35,
      max_tokens: 1200,
      ...groqReasoningParams(model)
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Groq HTTP ${res.status}: ${t.slice(0, 600)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  return typeof text === "string" && text.length ? text : null;
}

/** AI-assisted barangay operations insight (Groq); falls back to heuristics if key missing or Groq fails. */
app.post(
  "/admin/analytics/decision-insight",
  adminAnalyticsDecisionInsightLimiter,
  async (req, res) => {
    const auth = await requireStaffPortalUser(req, res);
    if (!auth) return;
    if (auth.profile.role !== "staff") {
      return res.status(403).json({
        ok: false,
        message: "Barangay Secretary role required to generate decision insights."
      });
    }

    const { summary: rawSummary, hourlyDemand: rawHourly } = req.body || {};
    if (!rawSummary || typeof rawSummary !== "object" || !rawHourly || typeof rawHourly !== "object") {
      return res.status(400).json({
        ok: false,
        message:
          "JSON body must include `summary` and `hourlyDemand` objects (responses from GET /admin/analytics/summary and GET /admin/analytics/hourly-demand)."
      });
    }

    const context = {
      summary: sanitizeSummaryForDecisionInsight(rawSummary),
      hourlyDemand: sanitizeHourlyDemandForDecisionInsight(rawHourly)
    };

    let insight = null;
    let source = "groq";
    try {
      if (process.env.GROQ_API_KEY) {
        insight = await groqBarangayDecisionInsight(context);
      }
    } catch (err) {
      console.warn("[admin/analytics/decision-insight] Groq error:", err?.message || err);
    }

    if (!insight) {
      insight = buildBarangayDecisionInsightFallback(context.summary, context.hourlyDemand);
      source = "fallback";
    }

    return res.json({
      ok: true,
      insight,
      source,
      groqConfigured: Boolean(process.env.GROQ_API_KEY)
    });
  }
);

// --- Admin user profiles (User & Role management) ---

function mapDirectoryProfileRow(row) {
  const profile = {
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    createdAt: row.createdAt,
    residentSelfRegistered: row.role === "resident" && Boolean(row.residentSelfRegistered),
    accountStatus: mapAccountStatusToUiLabel(row.accountStatus)
  };
  if (row.role === "staff") {
    profile.staffPermissions = normalizeStaffPermissionsFromDb(row.staffPermissions);
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Resident Profiling (staff portal): list / view / add / update / export resident records.
// Open to admin and system-admin; staff need the "residentProfiling" permission.
// ---------------------------------------------------------------------------
// Allowed values follow the barangay's RBI template (RBI-Profiling.xlsx, INSTRUCTIONS sheet).
const RESIDENT_INHABITANT = ["Non-Migrant", "Migrant", "Transient"];
const RESIDENT_SEX = ["Male", "Female"];
const RESIDENT_CIVIL = ["Single", "Married", "Widowed", "Divorced", "Separated", "Common Law/ Live-in", "Unknown", "Annulled"];
const RESIDENT_CITIZENSHIP = ["Filipino", "Dual Citizenship", "Foreigner"];
const RESIDENT_SELECT =
  "residentId email fullName contactNumber accountStatus residentSelfRegistered createdAt smsOptOut loginIssued residentProfile";
const RESIDENT_SORTS = {
  name: { fullName: 1, _id: 1 },
  name_desc: { fullName: -1, _id: -1 },
  newest: { createdAt: -1, _id: -1 },
  updated: { "residentProfile.updatedAt": -1, _id: -1 }
};

async function requireResidentProfilingAccess(req, res) {
  // The Barangay Secretary (staff) has full access; no per-page permission switches any more.
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return null;
  return auth;
}

function escapeRegexLiteral(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapResidentProfilingRow(row) {
  const rp = row.residentProfile || {};
  return {
    id: String(row._id),
    residentId: row.residentId || "",
    fullName: row.fullName || "",
    email: isPlaceholderResidentEmail(row.email) ? "" : row.email || "",
    contactNumber: row.contactNumber || "",
    accountStatus: mapAccountStatusToUiLabel(row.accountStatus),
    selfRegistered: Boolean(row.residentSelfRegistered),
    registeredAt: row.createdAt || null,
    smsOptOut: Boolean(row.smsOptOut),
    loginIssued: row.loginIssued !== false,
    philsysId: rp.philsysId || "",
    inhabitantType: rp.inhabitantType || "",
    lastName: rp.lastName || "",
    firstName: rp.firstName || "",
    middleName: rp.middleName || "",
    suffix: rp.suffix || "",
    birthPlace: rp.birthPlace || "",
    birthDate: rp.birthDate || null,
    sex: rp.sex || "",
    civilStatus: rp.civilStatus || "",
    citizenship: rp.citizenship || "",
    occupation: rp.occupation || "",
    highestEducation: rp.highestEducation || "",
    motherFirstName: rp.motherFirstName || "",
    motherMiddleName: rp.motherMiddleName || "",
    motherLastName: rp.motherLastName || "",
    purok: rp.purok || "",
    address: rp.address || "",
    householdNo: rp.householdNo || "",
    isHouseholdHead: rp.isHouseholdHead === true,
    profileUpdatedBy: rp.updatedByEmail || "",
    profileUpdatedAt: rp.updatedAt || null
  };
}

/**
 * Resident Profiling is for CONFIRMED residents only. A self-registered account stays out of
 * profiling while it is "pending" (awaiting approval) or "rejected"; it is linked to profiling
 * only once an administrator approves it (accountStatus becomes "active").
 * Records created by staff or imported from the RBI are "active" from the start.
 */
const UNCONFIRMED_RESIDENT_STATUSES = ["pending", "rejected"];
function confirmedResidentQuery(extra = {}) {
  return { role: "resident", accountStatus: { $nin: UNCONFIRMED_RESIDENT_STATUSES }, ...extra };
}

function buildResidentFilter(query) {
  const filter = confirmedResidentQuery();
  const q = String(query?.q || "").trim().slice(0, 80);
  if (q) {
    const rx = new RegExp(escapeRegexLiteral(q), "i");
    filter.$or = [
      { fullName: rx },
      { residentId: rx },
      { email: rx },
      { contactNumber: rx },
      { "residentProfile.lastName": rx },
      { "residentProfile.firstName": rx },
      { "residentProfile.philsysId": rx },
      { "residentProfile.purok": rx },
      { "residentProfile.householdNo": rx },
      { "residentProfile.address": rx }
    ];
  }
  const purok = String(query?.purok || "").trim().slice(0, 80);
  if (purok) filter["residentProfile.purok"] = purok;
  const profiled = String(query?.profiled || "");
  if (profiled === "no") filter["residentProfile.updatedAt"] = null;
  else if (profiled === "yes") filter["residentProfile.updatedAt"] = { $ne: null };
  return filter;
}

/** Case/spacing-insensitive match against an allowed list ("COMMON LAW/LIVE-IN" -> "Common Law/ Live-in"). */
function canonResidentEnum(value, list) {
  const key = (v) => String(v ?? "").toLowerCase().replace(/\s+/g, "");
  const k = key(value);
  if (!k) return "";
  return list.find((item) => key(item) === k) || null; // null = not an allowed value
}

/** "First Middle Last Suffix" — the display name used across the rest of the portal. */
function composeResidentFullName(p) {
  return sanitizeFullNameForStorage([p.firstName, p.middleName, p.lastName, p.suffix].filter(Boolean).join(" "));
}

/**
 * Validates the RBI profile fields of a request body. Returns { error } or { value }.
 * strict=true (add / import): the template's required fields cannot be blank.
 * strict=false (edit): only the values that are sent are checked and returned, so older
 * records can still be saved while they are being completed.
 */
// Required fields from the RBI template (RBI-Profiling.xlsx, DATA tab columns B, C, D, H, I, J, K).
// Required fields cannot be null/empty on create, import, or edit.
const RESIDENT_REQUIRED_FIELDS = [
  ["inhabitantType", "Inhabitant type"], ["lastName", "Last name"], ["firstName", "First name"],
  ["birthDate", "Birthdate"], ["sex", "Sex"], ["civilStatus", "Civil status"], ["citizenship", "Citizenship"]
];

/** Labels of required RBI fields that are empty in the given profile-shaped object. */
function missingRequiredResidentFields(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  return RESIDENT_REQUIRED_FIELDS.filter(([k]) => !p[k]).map(([, label]) => label);
}

function parseResidentProfileInput(body, actorEmail, { strict = false } = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const clean = (v, max) => String(v ?? "").trim().replace(/[\x00-\x1f\x7f<>]/g, "").slice(0, max);
  const out = {};

  const textFields = {
    philsysId: ["PhilSys ID", 30], lastName: ["Last name", 60], firstName: ["First name", 60],
    middleName: ["Middle name", 60], suffix: ["Suffix", 20], birthPlace: ["Birth place", 120],
    occupation: ["Profession/Occupation", 120], highestEducation: ["Highest educational attainment", 80],
    motherFirstName: ["Mother's first name", 60], motherMiddleName: ["Mother's middle name", 60],
    motherLastName: ["Mother's last name", 60], purok: ["Purok", 80], address: ["Address", 250],
    householdNo: ["Household No.", 40]
  };
  for (const [k, [, max]] of Object.entries(textFields)) {
    if (strict || has(k)) out[k] = clean(body[k], max);
  }
  if (typeof out.householdNo === "string") out.householdNo = out.householdNo.replace(/\s+/g, " ").toUpperCase();   // "hh-001 " and "HH-001" are the same household

  const enumFields = {
    inhabitantType: ["Inhabitant type", RESIDENT_INHABITANT],
    sex: ["Sex", RESIDENT_SEX],
    civilStatus: ["Civil status", RESIDENT_CIVIL],
    citizenship: ["Citizenship", RESIDENT_CITIZENSHIP]
  };
  for (const [k, [label, list]] of Object.entries(enumFields)) {
    if (!strict && !has(k)) continue;
    const v = canonResidentEnum(body[k], list);
    if (v === null) return { error: `${label} "${clean(body[k], 40)}" is not valid. Use: ${list.join(", ")}.` };
    out[k] = v;
  }

  if (strict || has("isHouseholdHead")) {
    const v = body.isHouseholdHead;
    out.isHouseholdHead = v === true || (typeof v === "string" && /^(true|yes|y|1|x|head)$/i.test(v.trim()));
  }

  if (strict || has("birthDate")) {
    if (body.birthDate) {
      const d = new Date(body.birthDate);
      if (Number.isNaN(d.getTime()) || d > new Date() || d.getFullYear() < 1900) {
        return { error: "Birthdate is not valid (use YYYY-MM-DD)." };
      }
      out.birthDate = d;
    } else {
      out.birthDate = null;
    }
  }

  if (strict) {
    const missing = missingRequiredResidentFields(out);
    if (missing.length) return { error: `Required field(s) missing: ${missing.join(", ")}.` };
  }

  out.updatedByEmail = actorEmail || "";
  out.updatedAt = new Date();
  return { value: out };
}

/**
 * A household is identified by its Household No. (from the barangay's household records). Exactly one resident
 * per household number may be the head of the family, and a head needs a Household No. Returns an error message
 * or null. `profile` is the resulting profile (existing values + edit); `exceptId` is the resident being saved.
 */
async function householdHeadProblem(profile, exceptId) {
  if (profile?.isHouseholdHead !== true) return null;
  const no = String(profile.householdNo || "").trim().toUpperCase();
  if (!no) return "Enter the Household No. before marking this resident as head of the family.";
  const heads = await User.find({
    role: "resident", "residentProfile.householdNo": no, "residentProfile.isHouseholdHead": true
  }).select("fullName").lean();
  const other = heads.find((h) => String(h._id) !== String(exceptId || ""));
  return other ? `Household ${no} already has a head of the family (${other.fullName}). Remove that mark first.` : null;
}

function csvCell(value) {
  let text = value == null ? "" : String(value);
  // Neutralise spreadsheet formulas (CSV injection) but keep normal phone numbers intact.
  if (/^[=+\-@\t\r]/.test(text) && !/^\+?[\d\s\-()]+$/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function ageFromDate(d) {
  if (!d) return "";
  const b = new Date(d);
  if (Number.isNaN(b.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now < new Date(now.getFullYear(), b.getMonth(), b.getDate())) age -= 1;
  return age >= 0 ? age : "";
}

app.get("/staff/residents", async (req, res) => {
  const auth = await requireResidentProfilingAccess(req, res);
  if (!auth) return;

  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query?.limit, 10) || 25));
  const offset = Math.max(0, Number.parseInt(req.query?.offset, 10) || 0);
  const filter = buildResidentFilter(req.query);
  const sort = RESIDENT_SORTS[String(req.query?.sort || "")] || RESIDENT_SORTS.name;

  try {
    const [total, rows] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).select(RESIDENT_SELECT).sort(sort).skip(offset).limit(limit).lean()
    ]);
    return res.json({ ok: true, residents: rows.map(mapResidentProfilingRow), total, limit, offset });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to load residents.", detail: error.message });
  }
});

// NOTE: must be declared before "/staff/residents/:id".
app.get("/staff/residents/export", async (req, res) => {
  const auth = await requireResidentProfilingAccess(req, res);
  if (!auth) return;
  const sort = RESIDENT_SORTS[String(req.query?.sort || "")] || RESIDENT_SORTS.name;
  try {
    const rows = await User.find(buildResidentFilter(req.query)).select(RESIDENT_SELECT).sort(sort).limit(5000).lean();
    // Same 18 columns, order and wording as the barangay's RBI template (DATA sheet),
    // so the file can be re-imported or uploaded as-is.
    const header = [
      "PHILSYS ID", "INHABITANT TYPE", "LAST NAME", "FIRST NAME", "MIDDLE NAME", "SUFFIX", "BIRTH PLACE",
      "BIRTHDATE (YYYY-MM-DD)", "SEX", "CIVIL STATUS", "CITIZENSHIP", "PROFESSION/ OCCUPATION", "CONTACT NUMBER",
      "EMAIL ADDRESS", "HIGHEST EDUCATIONAL ATTAINMENT", "MOTHER'S FIRST NAME", "MOTHER'S MIDDLE NAME", "MOTHER'S LAST NAME"
    ];
    const up = (v) => String(v || "").toUpperCase();
    const lines = [header.map(csvCell).join(",")];
    for (const row of rows) {
      const r = mapResidentProfilingRow(row);
      lines.push([
        r.philsysId, up(r.inhabitantType), up(r.lastName), up(r.firstName), up(r.middleName), up(r.suffix), up(r.birthPlace),
        r.birthDate ? new Date(r.birthDate).toISOString().slice(0, 10) : "",
        up(r.sex), up(r.civilStatus), up(r.citizenship), up(r.occupation), r.contactNumber, r.email,
        up(r.highestEducation), up(r.motherFirstName), up(r.motherMiddleName), up(r.motherLastName)
      ].map(csvCell).join(","));
    }
    void insertPortalAuditEvent({
      action: "Updated Record",
      description: `Exported ${rows.length} resident record(s) to CSV.`,
      profile: auth.profile,
      metadata: { entity: "resident_export", count: rows.length }
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="RBI-Profiling-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send("\uFEFF" + lines.join("\r\n"));
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to export residents.", detail: error.message });
  }
});

// Resident Profiling analytics: head-count of confirmed residents, split by sex, plus senior citizens.
// Counts the whole barangay (not just the current page or search). Senior citizen = 60 years old or above
// (RA 9994, Expanded Senior Citizens Act). Residents with no recorded birthdate cannot be counted as seniors.
// NOTE: must be declared before "/staff/residents/:id".
const SENIOR_CITIZEN_AGE = 60;
const PH_UTC_OFFSET_MS = 8 * 60 * 60 * 1000; // birthdates are stored as a calendar day, so compare by the barangay's (PH) date
app.get("/staff/residents/stats", async (req, res) => {
  const auth = await requireResidentProfilingAccess(req, res);
  if (!auth) return;
  try {
    const today = new Date(Date.now() + PH_UTC_OFFSET_MS);
    // Someone born on or before this day is already 60 today.
    const seniorCutoff = new Date(Date.UTC(today.getUTCFullYear() - SENIOR_CITIZEN_AGE, today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999));
    const people = await User.find(confirmedResidentQuery()).select("residentProfile.sex residentProfile.birthDate").lean();
    const row = { total: 0, male: 0, female: 0, seniors: 0, seniorMale: 0, seniorFemale: 0, noBirthDate: 0 };
    for (const person of people) {
      const rp = person.residentProfile || {};
      const hasBirthDate = rp.birthDate instanceof Date && !Number.isNaN(rp.birthDate.getTime());
      const senior = hasBirthDate && rp.birthDate <= seniorCutoff;
      row.total += 1;
      if (rp.sex === "Male") row.male += 1;
      if (rp.sex === "Female") row.female += 1;
      if (senior) {
        row.seniors += 1;
        if (rp.sex === "Male") row.seniorMale += 1;
        if (rp.sex === "Female") row.seniorFemale += 1;
      }
      if (!hasBirthDate) row.noBirthDate += 1;
    }
    const r = row || {};
    return res.json({
      ok: true,
      stats: {
        total: r.total || 0,
        male: r.male || 0,
        female: r.female || 0,
        seniors: r.seniors || 0,
        seniorMale: r.seniorMale || 0,
        seniorFemale: r.seniorFemale || 0,
        noBirthDate: r.noBirthDate || 0,
        seniorAge: SENIOR_CITIZEN_AGE,
        asOf: new Date().toISOString()
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to load resident statistics.", detail: error.message });
  }
});

/**
 * Staff issues a resident account: a unique Resident ID + password the resident uses to log in.
 * Resident ID and password are auto-generated unless staff provides them. The password is only
 * ever returned in this response — it is stored hashed.
 */
app.post("/staff/residents", adminStaffCreateLimiter, async (req, res) => {
  const auth = await requireResidentProfilingAccess(req, res);
  if (!auth) return;
  const body = req.body && typeof req.body === "object" ? req.body : {};

  const parsed = parseResidentProfileInput(body, auth.profile.email, { strict: true });
  if (parsed.error) return res.status(400).json({ ok: false, message: parsed.error });
  const fullName = composeResidentFullName(parsed.value);
  if (!fullName) return res.status(400).json({ ok: false, message: "First and last name are required." });
  try {
    const headProblem = await householdHeadProblem(parsed.value, null);
    if (headProblem) return res.status(400).json({ ok: false, message: headProblem });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to add resident.", detail: error.message });
  }
  const contactNumber = sanitizeResidentContactNumber(body.contactNumber);

  const rawEmail = String(body.email || "").trim();
  let email = "";
  if (rawEmail) {
    email = normalizeEmail(rawEmail);
    if (!isValidEmailFormat(email)) {
      return res.status(400).json({ ok: false, message: "That email address is not valid (or leave it blank)." });
    }
  }

  let customId = "";
  if (String(body.residentId || "").trim()) {
    customId = normalizeResidentId(body.residentId);
    if (!customId) {
      return res.status(400).json({
        ok: false,
        message: "Resident ID must be 4–20 characters: letters, numbers and dashes only."
      });
    }
  }

  const customPassword = String(body.password || "");
  if (customPassword) {
    if (customPassword.length < 8) {
      return res.status(400).json({ ok: false, message: "Password must be at least 8 characters long." });
    }
    if (customPassword.length > MAX_PASSWORD_LEN) {
      return res.status(400).json({ ok: false, message: `Password must be at most ${MAX_PASSWORD_LEN} characters.` });
    }
  }
  const password = customPassword || residentDefaultPassword(parsed.value.lastName, fullName);

  try {
    if (email && (await User.findOne({ email }).select("_id").lean())) {
      return res.status(409).json({ ok: false, message: "An account with this email already exists." });
    }
    if (customId && (await User.findOne({ residentId: customId }).select("_id").lean())) {
      return res.status(409).json({ ok: false, message: `Resident ID ${customId} is already assigned to someone else.` });
    }

    const passwordHash = await hashPassword(password);
    let created = null;
    let residentId = customId;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      if (!customId) residentId = await generateResidentId();
      try {
        created = await User.create({
          residentId,
          email: email || placeholderResidentEmail(residentId),
          passwordHash,
          fullName,
          role: "resident",
          authProvider: "local",
          isActive: true,
          accountStatus: "active",
          residentSelfRegistered: false,
          // staff chose/know this password, so the resident must replace it at first login
          mustChangePassword: true,
          ...(contactNumber ? { contactNumber } : {}),
          residentProfile: parsed.value
        });
      } catch (error) {
        if (error?.code === 11000 && !customId) continue; // ID collision: try the next number
        throw error;
      }
    }
    if (!created) {
      return res.status(500).json({ ok: false, message: "Could not assign a Resident ID. Please try again." });
    }

    void insertPortalAuditEvent({
      action: "Updated Record",
      description: `Barangay Secretary issued resident account ${residentId} for "${fullName}".`,
      profile: auth.profile,
      metadata: { entity: "resident_account", residentId }
    });

    const row = await User.findById(created._id).select(RESIDENT_SELECT).lean();
    return res.status(201).json({
      ok: true,
      resident: mapResidentProfilingRow(row),
      credentials: { residentId, password }
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ ok: false, message: "That email or Resident ID is already in use." });
    }
    return res.status(500).json({ ok: false, message: "Unable to add resident.", detail: error.message });
  }
});

/** Staff issues a new password for a resident (forgotten password / lost slip). Signs them out everywhere. */
app.post("/staff/residents/:id/reset-password", adminStaffCreateLimiter, async (req, res) => {
  const auth = await requireResidentProfilingAccess(req, res);
  if (!auth) return;
  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid resident id." });
  }
  const custom = String(req.body?.password || "");
  if (custom && (custom.length < 8 || custom.length > MAX_PASSWORD_LEN)) {
    return res.status(400).json({ ok: false, message: "Password must be 8–128 characters long." });
  }
  let password = custom;
  if (!password) {
    const current = await User.findOne(confirmedResidentQuery({ _id: id })).select("fullName residentProfile").lean().catch(() => null);
    if (!current) return res.status(404).json({ ok: false, message: "Resident not found." });
    password = residentDefaultPassword(current.residentProfile?.lastName, current.fullName);
  }
  try {
    const updated = await User.findOneAndUpdate(
      confirmedResidentQuery({ _id: id }),
      { $set: { passwordHash: await hashPassword(password), loginIssued: true, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null }, $inc: { tokenVersion: 1 } },
      { new: true }
    ).select("residentId email fullName").lean();
    if (!updated) return res.status(404).json({ ok: false, message: "Resident not found." });
    void insertPortalAuditEvent({
      action: "Updated Record",
      description: `Barangay Secretary reset the password of resident ${updated.residentId || updated.email}.`,
      profile: auth.profile,
      metadata: { entity: "resident_password_reset", residentId: updated.residentId || null }
    });
    return res.json({
      ok: true,
      credentials: {
        residentId: updated.residentId || "",
        email: isPlaceholderResidentEmail(updated.email) ? "" : updated.email,
        fullName: updated.fullName,
        password
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to reset password.", detail: error.message });
  }
});

/**
 * Bulk import of RBI (Record of Barangay Inhabitants) rows, sent in small batches by the page.
 * Each row becomes a resident record with an auto-assigned Resident ID but NO usable password
 * (loginIssued=false). Staff issue a login later from the resident drawer.
 */
async function findImportDuplicate({ fullName, email, birthDate, purok, philsysId }) {
  if (email && (await User.exists({ email }))) return "Email already registered";
  if (philsysId && (await User.exists({ role: "resident", "residentProfile.philsysId": philsysId }))) {
    return "PhilSys ID already registered";
  }
  const nameRx = new RegExp("^" + escapeRegexLiteral(fullName) + "$", "i");
  if (birthDate) {
    if (await User.exists({ role: "resident", fullName: nameRx, "residentProfile.birthDate": birthDate })) {
      return "Same name and birth date already exists";
    }
  } else if (purok) {
    if (await User.exists({ role: "resident", fullName: nameRx, "residentProfile.purok": purok })) {
      return "Same name and purok already exists";
    }
  }
  return "";
}

app.post("/staff/residents/import", residentImportLimiter, async (req, res) => {
  const auth = await requireResidentProfilingAccess(req, res);
  if (!auth) return;
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ ok: false, message: "No rows to import." });
  }
  if (rows.length > 50) {
    return res.status(400).json({ ok: false, message: "Send at most 50 rows per request." });
  }

  const result = { created: [], skipped: [], failed: [] };
  try {
    // One random, unknown password hash for the whole batch: these records cannot log in yet.
    const lockedHash = await hashPassword(crypto.randomBytes(24).toString("hex"));

    for (let i = 0; i < rows.length; i += 1) {
      const raw = rows[i] && typeof rows[i] === "object" ? rows[i] : {};
      const rowNumber = Number.isInteger(raw.rowNumber) ? raw.rowNumber : i + 1;
      const rawName = [raw.firstName, raw.lastName].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
      const fail = (reason) => result.failed.push({ rowNumber, fullName: rawName.slice(0, 120), reason });

      const parsed = parseResidentProfileInput(raw, auth.profile.email, { strict: true });
      if (parsed.error) { fail(parsed.error); continue; }
      const fullName = composeResidentFullName(parsed.value);
      if (!fullName) { fail("First and last name are required"); continue; }
      const headProblem = await householdHeadProblem(parsed.value, null);
      if (headProblem) { fail(headProblem); continue; }

      let email = "";
      if (String(raw.email || "").trim()) {
        email = normalizeEmail(raw.email);
        if (!isValidEmailFormat(email)) { fail("Email is not valid"); continue; }
      }
      const contactNumber = sanitizeResidentContactNumber(raw.contactNumber);

      const dup = await findImportDuplicate({
        fullName, email, birthDate: parsed.value.birthDate, purok: parsed.value.purok, philsysId: parsed.value.philsysId
      });
      if (dup) { result.skipped.push({ rowNumber, fullName, reason: dup }); continue; }

      let created = null;
      for (let attempt = 0; attempt < 4 && !created; attempt += 1) {
        const residentId = await generateResidentId();
        try {
          created = await User.create({
            residentId,
            email: email || placeholderResidentEmail(residentId),
            passwordHash: lockedHash,
            fullName,
            role: "resident",
            authProvider: "local",
            isActive: true,
            accountStatus: "active",
            residentSelfRegistered: false,
            loginIssued: false,
            ...(contactNumber ? { contactNumber } : {}),
            residentProfile: parsed.value
          });
          result.created.push({ rowNumber, fullName, residentId });
        } catch (error) {
          if (error?.code === 11000 && error?.keyPattern?.email && email) {
            result.skipped.push({ rowNumber, fullName, reason: "Email already registered" });
            created = true; // stop retrying this row
          } else if (error?.code !== 11000) {
            fail("Could not be saved");
            created = true;
          }
          // ID collision: loop again and take the next number
        }
      }
      if (!created) fail("Could not assign a Resident ID");
    }

    void insertPortalAuditEvent({
      action: "Updated Record",
      description: `RBI import batch: ${result.created.length} added, ${result.skipped.length} skipped, ${result.failed.length} failed.`,
      profile: auth.profile,
      metadata: { entity: "resident_import", created: result.created.length, skipped: result.skipped.length, failed: result.failed.length }
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Import failed.", detail: error.message, ...result });
  }
});

app.get("/staff/residents/:id", async (req, res) => {
  const auth = await requireResidentProfilingAccess(req, res);
  if (!auth) return;
  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid resident id." });
  }
  try {
    const row = await User.findOne(confirmedResidentQuery({ _id: id })).select(RESIDENT_SELECT).lean();
    if (!row) return res.status(404).json({ ok: false, message: "Resident not found." });
    const [requestCount, appointmentCount] = await Promise.all([
      ServiceRequest.countDocuments({ residentUserId: id }),
      Appointment.countDocuments({ residentUserId: id })
    ]);
    return res.json({
      ok: true,
      resident: { ...mapResidentProfilingRow(row), requestCount, appointmentCount }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to load resident.", detail: error.message });
  }
});

app.patch("/staff/residents/:id", async (req, res) => {
  const auth = await requireResidentProfilingAccess(req, res);
  if (!auth) return;
  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid resident id." });
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const parsed = parseResidentProfileInput(body, auth.profile.email);
  if (parsed.error) return res.status(400).json({ ok: false, message: parsed.error });

  // Required RBI fields cannot be blanked or left empty. When any profile field is being saved,
  // the resulting record (existing values + this edit) must have all required fields filled.
  const touchesProfile = Object.keys(parsed.value).some((k) => k !== "updatedByEmail" && k !== "updatedAt");
  if (touchesProfile) {
    let existing;
    try {
      existing = await User.findOne(confirmedResidentQuery({ _id: id })).select("residentProfile").lean();
    } catch (error) {
      return res.status(500).json({ ok: false, message: "Unable to save resident profile.", detail: error.message });
    }
    if (!existing) return res.status(404).json({ ok: false, message: "Resident not found." });
    const missing = missingRequiredResidentFields({ ...(existing.residentProfile || {}), ...parsed.value });
    if (missing.length) {
      return res.status(400).json({ ok: false, message: `Required field(s) missing: ${missing.join(", ")}.` });
    }
    if ("isHouseholdHead" in parsed.value || "householdNo" in parsed.value) {
      try {
        const headProblem = await householdHeadProblem({ ...(existing.residentProfile || {}), ...parsed.value }, id);
        if (headProblem) return res.status(400).json({ ok: false, message: headProblem });
      } catch (error) {
        return res.status(500).json({ ok: false, message: "Unable to save resident profile.", detail: error.message });
      }
    }
  }

  // Set each field individually (dotted paths) so fields not on the form (purok, address, old
  // remarks / voter status) are never wiped by a save.
  const set = {};
  for (const [k, v] of Object.entries(parsed.value)) set[`residentProfile.${k}`] = v;
  if (typeof body.smsOptOut === "boolean") set.smsOptOut = body.smsOptOut;
  if (Object.prototype.hasOwnProperty.call(body, "contactNumber")) {
    set.contactNumber = sanitizeResidentContactNumber(body.contactNumber);
  }
  // Keep the display name in sync when the name parts are edited.
  if (parsed.value.firstName !== undefined || parsed.value.lastName !== undefined) {
    const current = await User.findOne(confirmedResidentQuery({ _id: id })).select("residentProfile").lean();
    const rp = current?.residentProfile || {};
    const merged = {
      firstName: parsed.value.firstName ?? rp.firstName ?? "",
      middleName: parsed.value.middleName ?? rp.middleName ?? "",
      lastName: parsed.value.lastName ?? rp.lastName ?? "",
      suffix: parsed.value.suffix ?? rp.suffix ?? ""
    };
    const composed = composeResidentFullName(merged);
    if (composed && merged.firstName && merged.lastName) set.fullName = composed;
  }

  try {
    const updated = await User.findOneAndUpdate(confirmedResidentQuery({ _id: id }), { $set: set }, { new: true, runValidators: true })
      .select(RESIDENT_SELECT)
      .lean();
    if (!updated) return res.status(404).json({ ok: false, message: "Resident not found." });
    return res.json({ ok: true, resident: mapResidentProfilingRow(updated) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to save resident profile.", detail: error.message });
  }
});

app.get("/admin/profiles", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const actorRole = auth.profile.role;
  if (actorRole !== "staff" && actorRole !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "Barangay Secretary or system administrator role is required to list users."
    });
  }

  const rawLimit = req.query?.limit;
  const rawOffset = req.query?.offset;
  let pageLimit = 0;
  if (rawLimit !== undefined && rawLimit !== null && String(rawLimit).trim() !== "") {
    const parsed = Number(rawLimit);
    if (Number.isInteger(parsed) && parsed > 0) {
      pageLimit = Math.min(100, parsed);
    }
  }
  const offsetParsed = Number(rawOffset);
  const pageOffset = Number.isInteger(offsetParsed) && offsetParsed >= 0 ? offsetParsed : 0;

  const roleFilter =
    actorRole === "system-admin" ? { role: { $ne: "system-admin" } } : { role: "resident" };

  if (pageLimit > 0) {
    let total, data;
    try {
      [total, data] = await Promise.all([
        User.countDocuments(roleFilter),
        User.find(roleFilter)
          .select("email fullName role createdAt staffPermissions residentSelfRegistered accountStatus")
          .sort({ createdAt: -1, fullName: 1 })
          .skip(pageOffset)
          .limit(pageLimit)
          .lean()
      ]);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: "Unable to load user profiles.",
        detail: error.message
      });
    }

    return res.json({
      ok: true,
      profiles: data.map(mapDirectoryProfileRow),
      total,
      limit: pageLimit,
      offset: pageOffset
    });
  }

  let data;
  try {
    data = await User.find(roleFilter)
      .select("email fullName role createdAt staffPermissions residentSelfRegistered accountStatus")
      .sort({ createdAt: -1, fullName: 1 })
      .lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load user profiles.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    profiles: data.map(mapDirectoryProfileRow)
  });
});

app.get("/admin/profiles/by-email", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const actorRole = auth.profile.role;
  if (actorRole !== "staff" && actorRole !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "Barangay Secretary or system administrator role is required to load profiles."
    });
  }

  const targetEmail = normalizeEmail(req.query?.email ?? "");
  if (!targetEmail || !isValidEmailFormat(targetEmail)) {
    return res.status(400).json({ ok: false, message: "A valid email query parameter is required." });
  }

  let data;
  try {
    data = await User.findOne({ email: targetEmail })
      .select("email fullName role contactNumber identityVerificationFileId avatarFileId accountStatus residentSelfRegistered")
      .lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load profile.",
      detail: error.message
    });
  }
  if (!data) {
    return res.status(404).json({ ok: false, message: "No profile found for that email." });
  }

  if (actorRole === "staff" && data.role !== "resident") {
    return res.status(403).json({ ok: false, message: "You cannot load this profile." });
  }

  const profile = {
    email: data.email,
    fullName: data.fullName || "",
    role: data.role,
    contactNumber: data.contactNumber ?? null,
    phone: data.contactNumber ?? null,
    idUrl: data.identityVerificationFileId ? `/files/${data.identityVerificationFileId}` : null,
    avatarUrl: data.avatarFileId ? `/files/${data.avatarFileId}` : null,
    accountStatus: mapAccountStatusToUiLabel(data.accountStatus),
    residentSelfRegistered: data.role === "resident" && Boolean(data.residentSelfRegistered)
  };

  return res.json({ ok: true, profile });
});

app.patch("/admin/profiles/update", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const actorRole = auth.profile.role;
  if (actorRole !== "staff" && actorRole !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "Barangay Secretary or system administrator role is required."
    });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const targetEmail = normalizeEmail(body.email ?? "");
  const password = body.password != null ? String(body.password) : "";
  const hasPassword = password.length > 0;
  const hasContact = Object.prototype.hasOwnProperty.call(body, "contactNumber");

  if (!targetEmail || !isValidEmailFormat(targetEmail)) {
    return res.status(400).json({ ok: false, message: "A valid email is required." });
  }
  if (!hasPassword && !hasContact) {
    return res.status(400).json({
      ok: false,
      message: "Provide password and/or contactNumber to update."
    });
  }

  let target;
  try {
    target = await User.findOne({ email: targetEmail }).select("email role").lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load target profile.",
      detail: error.message
    });
  }
  if (!target) {
    return res.status(404).json({ ok: false, message: "No profile found for that email." });
  }
  if (actorRole === "staff" && target.role !== "resident") {
    return res.status(403).json({ ok: false, message: "You cannot update this account from here." });
  }

  const updatePayload = {};

  if (hasPassword) {
    if (password.length < 8) {
      return res.status(400).json({ ok: false, message: "Password must be at least 8 characters." });
    }
    if (password.length > MAX_PASSWORD_LEN) {
      return res.status(400).json({
        ok: false,
        message: `Password must be at most ${MAX_PASSWORD_LEN} characters.`
      });
    }
    updatePayload.passwordHash = await hashPassword(password);
    // Invalidate any sessions issued before this change — same reasoning
    // as the resident change-password route.
    updatePayload.$inc = { tokenVersion: 1 };
    // an administrator chose this password: the resident must replace it at next login
    if (target.role === "resident") updatePayload.mustChangePassword = true;
  }

  if (hasContact) {
    updatePayload.contactNumber = sanitizeResidentContactNumber(body.contactNumber);
  }

  try {
    const { $inc, ...setFields } = updatePayload;
    const updateQuery = { $set: setFields };
    if ($inc) updateQuery.$inc = $inc;
    await User.updateOne({ email: targetEmail }, updateQuery);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: hasPassword ? "Unable to update password." : "Unable to update contact number.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    message:
      hasPassword && hasContact
        ? "Password and contact number updated."
        : hasPassword
          ? "Password updated."
          : "Contact number updated."
  });
});

// ---- Linking a self-registered resident to an existing RBI record (avoids duplicate residents) ----
// A resident who is already in the Record of Barangay Inhabitants (imported/created by staff, with no
// login e-mail yet) and then signs up on their own would otherwise exist twice. On approval, the admin
// can link the sign-up to the existing record: the record keeps its Resident ID and RBI data and gains
// the e-mail, password and ID photo from the sign-up; the duplicate pending account is removed.
const NAME_NOISE_TOKENS = new Set(["jr", "sr", "ii", "iii", "iv", "de", "del", "dela", "delos", "la", "las", "los"]);

function linkNameTokens(text) {
  return String(text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !NAME_NOISE_TOKENS.has(t));
}

function linkableRecordFilter() {
  // RBI records that do not have a real login e-mail yet, and are not themselves sign-ups.
  return {
    role: "resident",
    residentSelfRegistered: { $ne: true },
    accountStatus: { $nin: ["pending", "rejected"] },
    email: new RegExp(escapeRegexLiteral(PLACEHOLDER_EMAIL_DOMAIN) + "$", "i")
  };
}

async function findLinkCandidates({ searchText, contactNumber }) {
  const tokens = linkNameTokens(searchText);
  if (!tokens.length) return [];
  const digits = String(contactNumber || "").replace(/\D/g, "");
  const phoneTail = digits.length >= 10 ? digits.slice(-10) : "";

  const rows = await User.find({
    ...linkableRecordFilter(),
    $or: tokens.map((t) => ({ fullName: new RegExp(escapeRegexLiteral(t), "i") }))
  })
    .select(RESIDENT_SELECT)
    .limit(120)
    .lean();

  const scored = rows.map((row) => {
    const cand = new Set(linkNameTokens(row.fullName));
    let exact = 0;
    let partial = 0;
    for (const t of tokens) {
      if (cand.has(t)) exact += 1;
      else if ([...cand].some((c) => c.startsWith(t) || t.startsWith(c))) partial += 1;
    }
    const phoneMatch = Boolean(phoneTail) && String(row.contactNumber || "").replace(/\D/g, "").endsWith(phoneTail);
    const strong = tokens.length >= 2 && exact === tokens.length;
    const score = exact * 10 + partial * 4 + (phoneMatch ? 15 : 0);
    const rp = row.residentProfile || {};
    return {
      score,
      candidate: {
        id: String(row._id),
        residentId: row.residentId || "",
        fullName: row.fullName || "",
        birthDate: rp.birthDate ? new Date(rp.birthDate).toISOString().slice(0, 10) : "",
        sex: rp.sex || "",
        purok: rp.purok || "",
        address: rp.address || "",
        contactNumber: row.contactNumber || "",
        loginIssued: row.loginIssued !== false,
        match: strong ? "Same name" : phoneMatch ? "Same contact number" : "Similar name"
      }
    };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.fullName.localeCompare(b.candidate.fullName))
    .slice(0, 8)
    .map((x) => x.candidate);
}

/** Possible RBI matches for a pending self-registration (optionally narrowed by a manual search `q`). */
app.get("/admin/profiles/link-candidates", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "staff" && auth.profile.role !== "system-admin") {
    return res.status(403).json({ ok: false, message: "Barangay Secretary or system administrator role is required." });
  }
  const email = normalizeEmail(req.query?.email ?? "");
  if (!email || !isValidEmailFormat(email)) {
    return res.status(400).json({ ok: false, message: "A valid email is required." });
  }
  const q = String(req.query?.q ?? "").trim().slice(0, 80);
  try {
    const pending = await User.findOne({ email, role: "resident", accountStatus: "pending", residentSelfRegistered: true })
      .select("email fullName contactNumber")
      .lean();
    if (!pending) {
      return res.status(404).json({ ok: false, message: "No pending self-registration found for that email." });
    }
    const candidates = await findLinkCandidates({
      searchText: q || pending.fullName,
      contactNumber: q ? "" : pending.contactNumber
    });
    return res.json({
      ok: true,
      pending: { email: pending.email, fullName: pending.fullName, contactNumber: pending.contactNumber || "" },
      candidates
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to look for matching records.", detail: error.message });
  }
});

/** Approve a pending self-registration by linking it to an existing RBI record instead of creating a new resident. */
app.post("/admin/profiles/approve-link", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "staff" && auth.profile.role !== "system-admin") {
    return res.status(403).json({ ok: false, message: "Barangay Secretary or system administrator role is required." });
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const email = normalizeEmail(body.email ?? "");
  const recordId = String(body.residentRecordId ?? "");
  if (!email || !isValidEmailFormat(email)) {
    return res.status(400).json({ ok: false, message: "A valid email is required." });
  }
  if (!isValidId(recordId)) {
    return res.status(400).json({ ok: false, message: "Choose the resident record to link." });
  }

  try {
    const pending = await User.findOne({ email, role: "resident", accountStatus: "pending", residentSelfRegistered: true })
      .select("+passwordHash");
    if (!pending) {
      return res.status(404).json({ ok: false, message: "No pending self-registration found for that email." });
    }
    const target = await User.findOne({ ...linkableRecordFilter(), _id: recordId }).select(RESIDENT_SELECT + " avatarFileId");
    if (!target) {
      return res.status(409).json({
        ok: false,
        message: "That resident record can no longer be linked (it may already have an account e-mail). Refresh and try again."
      });
    }

    // 1) Free the e-mail address (it is unique) by parking the pending account under a throwaway address.
    const parked = await User.updateOne(
      { _id: pending._id, accountStatus: "pending" },
      { $set: { email: `merged-${pending._id}${PLACEHOLDER_EMAIL_DOMAIN}` } }
    );
    if (!parked.matchedCount) {
      return res.status(409).json({ ok: false, message: "This registration was already reviewed. Refresh and try again." });
    }

    // 2) Move the sign-up's login onto the RBI record; undo step 1 if that fails.
    const setFields = {
      email,
      passwordHash: pending.passwordHash,
      loginIssued: true,
      mustChangePassword: false, // they chose this password themselves
      residentSelfRegistered: true,
      accountStatus: "active",
      isActive: true
    };
    if (pending.identityVerificationFileId) setFields.identityVerificationFileId = pending.identityVerificationFileId;
    if (pending.avatarFileId && !target.avatarFileId) setFields.avatarFileId = pending.avatarFileId;
    if (!target.contactNumber && pending.contactNumber) setFields.contactNumber = pending.contactNumber;

    let linked = null;
    try {
      linked = await User.findOneAndUpdate(
        { _id: target._id, email: target.email },
        { $set: setFields, $inc: { tokenVersion: 1 } },
        { new: true }
      ).select("residentId email fullName").lean();
    } catch (error) {
      await User.updateOne({ _id: pending._id }, { $set: { email } });
      throw error;
    }
    if (!linked) {
      await User.updateOne({ _id: pending._id }, { $set: { email } });
      return res.status(409).json({ ok: false, message: "That resident record was changed by someone else. Refresh and try again." });
    }

    // 3) The sign-up's data now lives on the RBI record, so the duplicate goes away
    //    (its ID photo was moved, so the file itself is kept).
    try {
      await User.deleteOne({ _id: pending._id });
    } catch (error) {
      await User.updateOne({ _id: pending._id }, { $set: { accountStatus: "rejected" } }); // never leave a usable duplicate
      console.warn("[approve-link] could not delete merged pending account:", error?.message || error);
    }

    void insertAuthAuditEvent({ action: "account_approved", email, role: "resident", req });
    void insertPortalAuditEvent({
      action: "Updated Record",
      description: `Approved the self-registration of ${email} and linked it to RBI record ${linked.residentId || ""} (${linked.fullName}).`,
      profile: auth.profile,
      metadata: { entity: "resident_account_link", residentId: linked.residentId || null }
    });

    return res.json({
      ok: true,
      resident: { residentId: linked.residentId || "", fullName: linked.fullName, email: linked.email }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to link the registration.", detail: error.message });
  }
});

/** Set account status (Pending Approval / Active / Suspended / Deactivated / Rejected). Active = full resident portal access; other values block login and APIs. Moving a pending account to Active approves it; to Rejected declines it. */
app.patch("/admin/profiles/account-status", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const actorRole = auth.profile.role;
  if (actorRole !== "staff" && actorRole !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "Barangay Secretary or system administrator role is required."
    });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const targetEmail = normalizeEmail(body.email ?? "");
  const nextStatus = normalizeAccountStatusFromInput(body.accountStatus ?? body.status);
  if (!targetEmail || !isValidEmailFormat(targetEmail)) {
    return res.status(400).json({ ok: false, message: "A valid email is required." });
  }
  if (!nextStatus) {
    return res.status(400).json({
      ok: false,
      message: "accountStatus must be Pending Approval, Active, Suspended, Deactivated, or Rejected."
    });
  }

  if (normalizeEmail(auth.profile.email) === targetEmail) {
    return res.status(400).json({ ok: false, message: "You cannot change your own account status here." });
  }

  let target;
  try {
    target = await User.findOne({ email: targetEmail }).select("email role accountStatus").lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load target profile.",
      detail: error.message
    });
  }
  if (!target) {
    return res.status(404).json({ ok: false, message: "No profile found for that email." });
  }
  if (target.role === "system-admin" || (actorRole === "staff" && target.role !== "resident")) {
    return res.status(403).json({ ok: false, message: "This account's status cannot be changed from this action." });
  }

  let updated;
  try {
    updated = await User.findOneAndUpdate(
      { email: targetEmail },
      { $set: { accountStatus: nextStatus } },
      { new: true }
    )
      .select("email accountStatus")
      .lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to update account status.",
      detail: error.message
    });
  }

  // Audit trail for registration review decisions (pending -> active / rejected).
  if (target.accountStatus === "pending" && nextStatus === "active") {
    void insertAuthAuditEvent({ action: "account_approved", email: targetEmail, role: target.role, req });
  } else if (target.accountStatus === "pending" && nextStatus === "rejected") {
    void insertAuthAuditEvent({ action: "account_rejected", email: targetEmail, role: target.role, req });
  }

  return res.json({
    ok: true,
    email: updated?.email || targetEmail,
    accountStatus: mapAccountStatusToUiLabel(updated?.accountStatus)
  });
});

/** System administrator creates the Barangay Secretary (staff) account in the database. */
app.post("/admin/staff", adminStaffCreateLimiter, async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "Only system administrators can create Barangay Secretary accounts."
    });
  }

  const body = req.body || {};
  const { fullName, email, password } = body;
  const normalizedEmail = normalizeEmail(email);
  const safeFullName = sanitizeFullNameForStorage(fullName);
  const safePassword = String(password || "");
  const perms = defaultStaffPermissionsAllTrue();

  if (!safeFullName || !normalizedEmail || !safePassword) {
    return res.status(400).json({
      ok: false,
      message: "fullName, email, and password are required."
    });
  }

  if (!isValidEmailFormat(normalizedEmail)) {
    return res.status(400).json({
      ok: false,
      message: "Please enter a valid email address."
    });
  }

  if (safePassword.length < 8) {
    return res.status(400).json({
      ok: false,
      message: "Password must be at least 8 characters long."
    });
  }

  if (safePassword.length > MAX_PASSWORD_LEN) {
    return res.status(400).json({
      ok: false,
      message: `Password must be at most ${MAX_PASSWORD_LEN} characters.`
    });
  }

  let existingUser;
  try {
    existingUser = await User.findOne({ email: normalizedEmail }).select("email").lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to verify email availability.",
      detail: error.message
    });
  }

  if (existingUser) {
    return res.status(409).json({
      ok: false,
      message: "An account with this email already exists."
    });
  }

  // With users+profiles merged into one collection (see models/User.js),
  // account creation is a single atomic document insert. The old version
  // had to create a Supabase Auth user first, then upsert a profile row,
  // then roll back (delete) the Auth user if the profile write failed —
  // a two-step process with a manual compensating action. That entire
  // failure mode no longer exists here.
  const passwordHash = await hashPassword(safePassword);
  let created;
  try {
    created = await User.create({
      email: normalizedEmail,
      passwordHash,
      fullName: safeFullName,
      role: "staff",
      authProvider: "local",
      isActive: true,
      staffPermissions: perms
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "An account with this email already exists."
      });
    }
    return res.status(500).json({
      ok: false,
      message: "Unable to create Barangay Secretary account.",
      detail: error.message
    });
  }

  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Created Barangay Secretary account for ${normalizedEmail}. Name: "${safeFullName}". Permissions JSON keys: ${Object.keys(perms || {}).join(", ") || "—"}.`,
    profile: auth.profile,
    metadata: {
      entity: "staff_account",
      staffEmail: normalizedEmail,
      fullName: safeFullName,
      staffPermissions: perms
    }
  });

  return res.status(201).json({
    ok: true,
    message: "Barangay Secretary account created.",
    user: {
      email: normalizedEmail,
      fullName: safeFullName,
      role: "staff",
      staffPermissions: perms
    }
  });
});

// NOTE: findAuthUserIdByEmail (a helper that paged through Supabase Auth's
// listUsers to find a user's Auth ID by email) was removed here. It has no
// callers left — every route that used it (profile update, profile
// delete) now works directly against the merged User model instead of
// needing a separate Auth-system lookup.

/** Permanently delete a user account (barangay admin or system admin; rules differ by actor). */
app.post("/admin/profiles/delete", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const actorRole = auth.profile.role;
  if (actorRole !== "staff" && actorRole !== "system-admin") {
    return res.status(403).json({ ok: false, message: "Barangay Secretary or system administrator role is required." });
  }

  const email = normalizeEmail(req.body?.email ?? "");
  if (!email || !isValidEmailFormat(email)) {
    return res.status(400).json({ ok: false, message: "A valid email is required." });
  }

  if (normalizeEmail(auth.profile.email) === email) {
    return res.status(400).json({ ok: false, message: "You cannot delete your own account." });
  }

  let profile;
  try {
    profile = await User.findOne({ email }).select("email role").lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load profile.",
      detail: error.message
    });
  }

  if (!profile) {
    return res.status(404).json({ ok: false, message: "No profile found for that email." });
  }

  if (profile.role === "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "System administrator accounts cannot be deleted from this action."
    });
  }

  if (actorRole === "staff" && profile.role !== "resident") {
    return res.status(403).json({ ok: false, message: "The Barangay Secretary can only delete resident accounts." });
  }

  if (profile.role === "resident") {
    try {
      const residentDoc = await User.findOne({ email }).select("_id").lean();
      const requestCount = residentDoc
        ? await ServiceRequest.countDocuments({ residentUserId: residentDoc._id })
        : 0;
      if (requestCount > 0) {
        return res.status(409).json({
          ok: false,
          message:
            "This resident has service requests on file. Resolve or remove those records before deleting the account."
        });
      }
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: "Unable to check for related service requests.",
        detail: error.message
      });
    }
  }

  // With users+profiles+Auth merged into one User document (see
  // models/User.js), this is a single delete instead of three separate
  // ones (users row, profiles row, Supabase Auth user) that the old
  // version had to coordinate with individual error handling at each step.
  try {
    await User.deleteOne({ email });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to delete account.",
      detail: error.message
    });
  }

  void insertPortalAuditEvent({
    action: "Deleted Record",
    description: `Permanently deleted user account for email ${email}. Prior profile role: ${profile.role}.`,
    profile: auth.profile,
    metadata: {
      entity: "profile",
      deletedEmail: email,
      deletedRole: profile.role
    }
  });

  return res.json({ ok: true, message: "Account deleted." });
});

function getLocalCalendarMonthStartEndIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = new Date(y, m, 1, 0, 0, 0, 0);
  const end = new Date(y, m + 1, 0, 23, 59, 59, 999);
  return { monthStartIso: start.toISOString(), monthEndIso: end.toISOString() };
}

/** Inclusive YYYY-MM-DD bounds for the current local calendar month (for date columns). */
function getLocalCalendarMonthDateStrings() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  const monthStartDate = `${y}-${pad(m + 1)}-01`;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const monthEndDate = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
  return { monthStartDate, monthEndDate };
}

function currentMonthYearLabel() {
  return new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
}

/** Overview metrics for the admin service management dashboard (catalog table, users, month volume, announcements). */
app.get("/admin/service-dashboard/summary", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "staff") {
    return res.status(403).json({ ok: false, message: "Barangay Secretary role required to view this summary." });
  }

  const { monthStartIso, monthEndIso } = getLocalCalendarMonthStartEndIso();
  const { monthStartDate, monthEndDate } = getLocalCalendarMonthDateStrings();

  let totalServices, staffCount, residentCount, monthRequestsCount, monthAppointmentsCount, totalAnnouncementsPosted;
  try {
    [totalServices, staffCount, residentCount, monthRequestsCount, monthAppointmentsCount, totalAnnouncementsPosted] =
      await Promise.all([
        ServiceCatalog.countDocuments({ archivedAt: null }),
        User.countDocuments({ role: "staff" }),
        User.countDocuments(confirmedResidentQuery()),
        // Use preferredDate (always present); appointments below use createdAt for month-of-booking instead.
        ServiceRequest.countDocuments({
          preferredDate: { $gte: monthStartDate, $lte: monthEndDate }
        }),
        Appointment.countDocuments({
          createdAt: { $gte: new Date(monthStartIso), $lte: new Date(monthEndIso) }
        }),
        CommunityAnnouncement.countDocuments({})
      ]);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load dashboard summary.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    totalServices,
    staffCount,
    residentCount,
    staffAndResidentsTotal: staffCount + residentCount,
    monthRequestsCount,
    monthAppointmentsCount,
    monthRequestsAndAppointmentsTotal: monthRequestsCount + monthAppointmentsCount,
    monthLabel: currentMonthYearLabel(),
    monthRangeStartIso: monthStartIso,
    monthRangeEndIso: monthEndIso,
    totalAnnouncementsPosted
  });
});

// --- Admin service catalog ---

app.get("/admin/service-catalog", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const includeArchived = String(req.query?.includeArchived || "") === "1";
  const filter = includeArchived ? {} : { archivedAt: null };

  let services;
  try {
    services = await ServiceCatalog.find(filter).sort({ createdAt: 1 }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load service catalog.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    services: services.map(normalizeServiceCatalogRow)
  });
});

app.post("/admin/service-catalog", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const { name, requiredDocuments, processingTime, status } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ ok: false, message: "Service name is required." });
  }

  const allowedStatuses = new Set(["Active", "Under Review", "Inactive"]);
  const nextStatus = allowedStatuses.has(String(status)) ? String(status) : "Active";

  let created;
  try {
    created = await ServiceCatalog.create({
      serviceName: String(name).trim(),
      requiredDocuments: String(requiredDocuments ?? "").trim(),
      processingTime: String(processingTime || "1-2 Days").trim(),
      status: nextStatus,
      archivedAt: null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to create service.",
      detail: error.message
    });
  }

  const svcRow = normalizeServiceCatalogRow(created.toObject());
  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Created catalog service ID ${svcRow.id}. Name: "${svcRow.name}". Status: ${svcRow.status}. Processing time: ${svcRow.processingTime || "—"}. Required documents: ${svcRow.requiredDocuments ? String(svcRow.requiredDocuments).slice(0, 240) + (svcRow.requiredDocuments.length > 240 ? "…" : "") : "—"}.`,
    profile: auth.profile,
    metadata: {
      entity: "service_catalog",
      serviceId: svcRow.id,
      name: svcRow.name,
      status: svcRow.status,
      processingTime: svcRow.processingTime,
      requiredDocuments: svcRow.requiredDocuments
    }
  });

  return res.status(201).json({
    ok: true,
    service: svcRow
  });
});

app.patch("/admin/service-catalog/:id", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid service id." });
  }

  const { name, requiredDocuments, processingTime, status } = req.body || {};
  const updatePayload = {};
  if (typeof name === "string" && name.trim()) updatePayload.serviceName = name.trim();
  if (typeof requiredDocuments === "string") updatePayload.requiredDocuments = requiredDocuments.trim();
  if (typeof processingTime === "string") updatePayload.processingTime = processingTime.trim();
  if (typeof status === "string") {
    const allowedStatuses = new Set(["Active", "Under Review", "Inactive"]);
    if (allowedStatuses.has(status)) updatePayload.status = status;
  }

  if (!Object.keys(updatePayload).length) {
    return res.status(400).json({ ok: false, message: "No valid fields to update." });
  }

  let updated;
  try {
    updated = await ServiceCatalog.findByIdAndUpdate(id, { $set: updatePayload }, { new: true }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to update service.",
      detail: error.message
    });
  }

  if (!updated) {
    return res.status(404).json({ ok: false, message: "Service not found." });
  }

  const svcPatched = normalizeServiceCatalogRow(updated);
  const changedKeys = Object.keys(updatePayload);
  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Updated catalog service ID ${id}. Fields changed: ${changedKeys.join(", ") || "—"}. Current name: "${svcPatched.name}". Status: ${svcPatched.status}. Processing time: ${svcPatched.processingTime || "—"}. Required documents: ${String(svcPatched.requiredDocuments || "").slice(0, 400)}${String(svcPatched.requiredDocuments || "").length > 400 ? "…" : ""}.`,
    profile: auth.profile,
    metadata: {
      entity: "service_catalog",
      serviceId: id,
      fieldsChanged: changedKeys,
      name: svcPatched.name,
      status: svcPatched.status,
      processingTime: svcPatched.processingTime,
      requiredDocuments: svcPatched.requiredDocuments
    }
  });

  return res.json({
    ok: true,
    service: svcPatched
  });
});

app.post("/admin/service-catalog/:id/archive", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid service id." });
  }

  let archived;
  try {
    archived = await ServiceCatalog.findOneAndUpdate(
      { _id: id, archivedAt: null },
      { $set: { archivedAt: new Date() } },
      { new: true }
    ).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to archive service.",
      detail: error.message
    });
  }

  if (!archived) {
    return res.status(404).json({ ok: false, message: "Service not found or already archived." });
  }

  const svcArchived = normalizeServiceCatalogRow(archived);
  void insertPortalAuditEvent({
    action: "Archived Record",
    description: `Archived catalog service ID ${id}. Name: "${svcArchived.name}". Status at archive: ${svcArchived.status}. Archived at: ${svcArchived.archivedAt || "—"}.`,
    profile: auth.profile,
    metadata: {
      entity: "service_catalog",
      serviceId: id,
      name: svcArchived.name,
      status: svcArchived.status,
      archivedAt: svcArchived.archivedAt
    }
  });

  return res.json({
    ok: true,
    service: svcArchived
  });
});

// --- System admin: configuration (service request types & appointment purpose options) ---

app.get("/system-admin/system-environment", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
  if (!auth) return;
  const environment = await getPortalEnvironmentFromDb();
  return res.json({ ok: true, environment });
});

/** Dashboard overview for system admin home (counts + environment + audit recency). */
app.get("/system-admin/dashboard-stats", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
  if (!auth) return;

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);

  let staff, residents, serviceRequestsTotal, appointmentsTotal, latestAuditEvent, auditEventsLast7Days;
  try {
    [staff, residents, serviceRequestsTotal, appointmentsTotal, latestAuditEvent, auditEventsLast7Days] =
      await Promise.all([
        User.countDocuments({ role: "staff" }),
        User.countDocuments({ role: "resident" }),
        ServiceRequest.countDocuments({}),
        Appointment.countDocuments({}),
        PortalAuditEvent.findOne({}).sort({ createdAt: -1 }).select("createdAt").lean(),
        PortalAuditEvent.countDocuments({ createdAt: { $gte: sevenDaysAgo } })
      ]);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load dashboard stats.",
      detail: error.message
    });
  }

  const portalUserTotal = staff + residents;
  const environment = await getPortalEnvironmentFromDb();
  const lastAuditAt = latestAuditEvent?.createdAt ? String(latestAuditEvent.createdAt) : null;

  return res.json({
    ok: true,
    portalUsers: {
      total: portalUserTotal,
      staff,
      residents
    },
    serviceRequestsTotal,
    appointmentsTotal,
    environment,
    lastAuditAt,
    auditEventsLast7Days
  });
});

app.put("/system-admin/system-environment", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
  if (!auth) return;
  const raw = String((req.body || {}).environment || "").toLowerCase();
  if (!PORTAL_ENVIRONMENT_VALUES.has(raw)) {
    return res.status(400).json({
      ok: false,
      message: "Invalid environment. Use production or maintenance."
    });
  }
  const result = await savePortalEnvironmentToDb(raw);
  if (!result.ok) {
    return res.status(500).json({
      ok: false,
      message: "Unable to update system environment.",
      detail: result.detail
    });
  }
  void insertPortalAuditEvent({
    action: "Updated Record",
    description:
      result.environment === "maintenance"
        ? "Portal environment set to maintenance mode (non-system-admin access restricted)."
        : "Portal environment set to production (full portal access).",
    profile: auth.profile,
    metadata: {
      entity: "system_settings",
      environment: result.environment,
      source: "system-admin"
    }
  });
  return res.json({ ok: true, environment: result.environment });
});

app.get("/admin/site-info", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  return res.json({ ok: true, siteInfo: await getSiteInfoFromDb(), defaults: SITE_INFO_DEFAULTS });
});

app.put("/admin/site-info", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const result = await saveSiteInfoToDb(req.body || {});
  if (!result.ok) {
    return res.status(result.status || 500).json({
      ok: false,
      message: "Unable to update barangay information.",
      detail: result.detail
    });
  }
  void insertPortalAuditEvent({
    action: "Updated Record",
    description: "Barangay information (contact details / signatory) updated.",
    profile: auth.profile,
    metadata: { entity: "system_settings", field: "siteInfo", source: "secretary" }
  });
  return res.json({ ok: true, siteInfo: result.siteInfo });
});

app.get("/system-admin/service-request-types", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
  if (!auth) return;

  let data;
  try {
    data = await ServiceCatalog.find({ archivedAt: null }).sort({ createdAt: 1 }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load service request types.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    services: data.map(normalizeServiceCatalogRow)
  });
});

app.post("/system-admin/service-request-types", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
  if (!auth) return;

  const body = req.body || {};
  const { name, requiredDocuments, processingTime, category, serviceName } = body;
  const rawName = name ?? category ?? serviceName;
  const safeName = sanitizePlainTextField(rawName, MAX_SERVICE_TYPE_LEN);
  if (!safeName) {
    return res.status(400).json({ ok: false, message: "Service name is required." });
  }

  const rawDocs = requiredDocuments ?? body.required_documents ?? body.documents ?? "";
  const insertPayload = {
    serviceName: safeName,
    requiredDocuments: sanitizePlainTextField(rawDocs, 2000),
    processingTime: sanitizePlainTextField(processingTime || "1-2 Days", 120),
    status: "Active",
    archivedAt: null
  };

  let created;
  try {
    created = await ServiceCatalog.create(insertPayload);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "A service with this name already exists in the catalog."
      });
    }
    return res.status(500).json({
      ok: false,
      message: "Unable to add service request type.",
      detail: error.message
    });
  }

  const svcRow = normalizeServiceCatalogRow(created.toObject());
  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Service catalog added: "${svcRow.name}" (${svcRow.status}).`,
    profile: auth.profile,
    metadata: {
      entity: "service_catalog",
      serviceId: svcRow.id,
      name: svcRow.name,
      status: svcRow.status,
      source: "system-admin"
    }
  });

  return res.status(201).json({ ok: true, service: svcRow });
});

app.delete("/system-admin/service-request-types/:id", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
  if (!auth) return;

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid service id." });
  }

  let data;
  try {
    data = await ServiceCatalog.findOneAndUpdate(
      { _id: id, archivedAt: null },
      { $set: { archivedAt: new Date() } },
      { new: true }
    ).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to remove service request type.",
      detail: error.message
    });
  }

  if (!data) {
    return res.status(404).json({ ok: false, message: "Service not found or already removed." });
  }

  const svcArchived = normalizeServiceCatalogRow(data);
  void insertPortalAuditEvent({
    action: "Archived Record",
    description: `Service catalog archived: "${svcArchived.name}".`,
    profile: auth.profile,
    metadata: {
      entity: "service_catalog",
      serviceId: id,
      name: svcArchived.name,
      source: "system-admin"
    }
  });

  return res.json({ ok: true, service: svcArchived });
});

app.get("/admin/appointment-purpose-types", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  let purposes;
  try {
    purposes = await AppointmentPurposeCatalog.find({ archivedAt: null })
      .sort({ sortOrder: 1, _id: 1 })
      .lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load appointment purpose types.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    purposes: purposes.map(normalizeAppointmentPurposeCatalogRow)
  });
});

app.post("/admin/appointment-purpose-types", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const { label, purposeCode } = req.body || {};
  const safeLabel = sanitizePlainTextField(label, MAX_APPOINTMENT_PURPOSE_LEN);
  if (!safeLabel) {
    return res.status(400).json({ ok: false, message: "Label is required." });
  }

  let code = purposeCode != null ? slugifyAppointmentPurposeCode(purposeCode) : slugifyAppointmentPurposeCode(safeLabel);

  const maxRow = await AppointmentPurposeCatalog.findOne({ archivedAt: null })
    .sort({ sortOrder: -1 })
    .lean();
  const nextOrder = (Number(maxRow?.sortOrder) || 0) + 1;

  for (let attempt = 0; attempt < 40; attempt++) {
    const tryCode = attempt === 0 ? code : `${code}-${attempt + 1}`.slice(0, 80);

    try {
      const created = await AppointmentPurposeCatalog.create({
        purposeCode: tryCode,
        label: safeLabel,
        sortOrder: nextOrder,
        archivedAt: null
      });
      const row = normalizeAppointmentPurposeCatalogRow(created.toObject());
      void insertPortalAuditEvent({
        action: "Updated Record",
        description: `Appointment purpose option added: ${row.label} (${row.purposeCode}).`,
        profile: auth.profile,
        metadata: {
          entity: "appointment_purpose_catalog",
          purposeId: row.id,
          purposeCode: row.purposeCode,
          label: row.label,
          source: "system-admin"
        }
      });
      return res.status(201).json({ ok: true, purpose: row });
    } catch (error) {
      // 11000 = the duplicate-key code db/engine.js reports for a Postgres unique violation, matching the old Postgres
      // "duplicate/unique/idx_appointment_purpose_code_active" check —
      // same partial-unique-index behavior enforced in
      // models/AppointmentPurposeCatalog.js, just a different error shape.
      if (error?.code === 11000) {
        continue;
      }
      return res.status(500).json({
        ok: false,
        message: "Unable to add appointment purpose type.",
        detail: error?.message || "unknown"
      });
    }
  }

  return res.status(409).json({
    ok: false,
    message: "Could not allocate a unique purpose code. Try a different label or purposeCode."
  });
});

app.delete("/admin/appointment-purpose-types/:id", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const id = String(req.params.id || "");
  if (!isValidId(id)) {
    return res.status(400).json({ ok: false, message: "Invalid purpose id." });
  }

  let existing;
  try {
    existing = await AppointmentPurposeCatalog.findOne({ _id: id, archivedAt: null }).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load appointment purpose type.",
      detail: error.message
    });
  }
  if (!existing) {
    return res.status(404).json({ ok: false, message: "Purpose type not found or already removed." });
  }

  let updated;
  try {
    updated = await AppointmentPurposeCatalog.findOneAndUpdate(
      { _id: id, archivedAt: null },
      { $set: { archivedAt: new Date() } },
      { new: true }
    ).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to remove appointment purpose type.",
      detail: error.message
    });
  }

  const row = updated ? normalizeAppointmentPurposeCatalogRow(updated) : null;
  void insertPortalAuditEvent({
    action: "Archived Record",
    description: row ? `Appointment purpose archived: "${row.label}" (${row.purposeCode}).` : "Appointment purpose archived.",
    profile: auth.profile,
    metadata: {
      entity: "appointment_purpose_catalog",
      purposeId: id,
      purposeCode: existing.purposeCode,
      label: existing.label,
      source: "system-admin"
    }
  });

  return res.json({ ok: true, purpose: row });
});

/** Active appointment purposes for resident booking UI (ordered). */
app.get("/resident/appointment-purpose-types", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;

  let purposes;
  try {
    purposes = await AppointmentPurposeCatalog.find({ archivedAt: null })
      .select("purposeCode label sortOrder")
      .sort({ sortOrder: 1, _id: 1 })
      .lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load appointment types.",
      detail: error.message
    });
  }

  return res.json({
    ok: true,
    purposes: purposes.map((r) => ({
      purposeCode: r.purposeCode,
      label: r.label,
      sortOrder: r.sortOrder ?? 0
    }))
  });
});

/** Auth audit log action → short label for UI (system-admin audit table). */
// Matches AUTH_AUDIT_ACTIONS in models/AuthAuditEvent.js — pared down from
// Supabase's ~20 internal event types (MFA, identity linking, token
// refresh, etc.) since we only log the handful of events that actually
// happen in our own auth code now.
const AUTH_AUDIT_ACTION_LABELS = {
  login: "User Login",
  register: "User Registered",
  password_change: "Password Changed",
  password_reset_requested: "Password Reset Code Requested",
  password_reset: "Password Reset (SMS Code)",
  account_approved: "Account Approved",
  account_rejected: "Account Rejected"
};

function authAuditActionLabel(action) {
  const key = String(action || "").trim();
  if (!key) return "Authentication";
  return AUTH_AUDIT_ACTION_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Audit log table: "May 2, 2026, 3:45 PM" (month day, year + time, no seconds).
 * Uses a fixed IANA timezone so the wall clock matches what you expect from stored timestamptz
 * (Node's default locale alone uses the *server's* zone, often UTC, which looks "wrong" vs Supabase UI).
 */
function formatAuditDateDisplay(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const tzRaw = process.env.AUDIT_LOG_DISPLAY_TIMEZONE;
  const tz =
    typeof tzRaw === "string" && tzRaw.trim().length ? tzRaw.trim() : "Asia/Manila";
  const opts = {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz
  };
  try {
    return d.toLocaleString("en-US", opts);
  } catch {
    return d.toLocaleString("en-US", { ...opts, timeZone: "Asia/Manila" });
  }
}

// NOTE: parseAuthAuditPayload (parsed Supabase's opaque JSON audit payload)
// and mapDbAuditOpToUiCategory (categorized Postgres record_version INSERT/
// UPDATE/DELETE ops) were removed here. Both were only needed to interpret
// Supabase-specific audit formats we no longer read from — see the
// AuthAuditEvent model and the comment above the removed record_version
// block for what replaced/dropped each.

/** Keys must match `system-admin/audit-logs.html` action filter values exactly. */
const PORTAL_AUDIT_FILTER_TO_BADGE = new Map([
  ["Status Update", "badge-status-update"],
  ["Completed Request", "badge-completed-request"],
  ["Rejected Request", "badge-rejected-request"],
  ["Updated Slots", "badge-updated-slots"],
  ["Printed Document", "badge-printed-document"],
  ["Updated Record", "badge-updated-record"],
  ["Archived Record", "badge-archived-record"],
  ["Deleted Record", "badge-deleted-record"]
]);

function portalAuditBadgeForFilterAction(filterAction) {
  const k = String(filterAction || "").trim();
  return PORTAL_AUDIT_FILTER_TO_BADGE.get(k) || "badge-updated-record";
}

function portalAuditCategoryForServiceRequestStatus(status) {
  const s = String(status || "").trim();
  if (s === "Completed") return "Completed Request";
  if (s === "Rejected") return "Rejected Request";
  return "Status Update";
}

function portalAuditCategoryForAppointmentStatus(status) {
  const s = String(status || "").trim();
  if (s === "Completed") return "Completed Request";
  if (s === "Rejected") return "Rejected Request";
  return "Status Update";
}

/** Remove legacy trailing `[{...}]` metadata suffix from stored descriptions. */
function stripTrailingBracketMetadataSuffix(text) {
  const s = String(text || "");
  const idx = s.lastIndexOf(" [{");
  if (idx < 8) return s.trim();
  return s.slice(0, idx).trim() || s.trim();
}

/**
 * One-line audit description for portal events (matches UI expectations).
 * Example service request status: Service request REQ-7450 (Certificate of Indigency) status: Pending, changed to Processing
 */
function formatPortalAuditDisplayDescription(action, metadata, storedDescription) {
  const m = metadata && typeof metadata === "object" ? metadata : {};
  const entity = String(m.entity || "");
  const act = String(action || "").trim();

  if (entity === "service_request" && m.referenceNo != null && m.previousStatus != null && m.newStatus != null) {
    const ref = String(m.referenceNo).trim();
    const svc = String(m.serviceType || m.title || "—").trim() || "—";
    const prev = String(m.previousStatus).trim();
    const next = String(m.newStatus).trim();
    let line = `Service request ${ref} (${svc}) status: ${prev}, changed to ${next}`;
    const note = m.staffNote != null ? String(m.staffNote).trim() : "";
    if (note) line += `. Note: ${note.slice(0, 220)}`;
    return line.slice(0, 2000);
  }

  if (entity === "service_request" && m.referenceNo != null && act === "Deleted Record") {
    const ref = String(m.referenceNo).trim();
    const svc = String(m.serviceType || m.title || "—").trim() || "—";
    const st = String(m.status ?? "—").trim();
    return `Service request ${ref} (${svc}) deleted (prior status: ${st}).`.slice(0, 2000);
  }

  if (entity === "appointment" && m.referenceNo != null && m.previousStatus != null && m.newStatus != null) {
    const ref = String(m.referenceNo).trim();
    const label = String(m.timeLabel || m.purpose || `slot ${m.slotId ?? "—"}`).trim() || "—";
    const prev = String(m.previousStatus).trim();
    const next = String(m.newStatus).trim();
    let line = `Appointment ${ref} (${label}) status: ${prev}, changed to ${next}`;
    const note = m.staffNote != null ? String(m.staffNote).trim() : "";
    if (note) line += `. Note: ${note.slice(0, 220)}`;
    return line.slice(0, 2000);
  }

  if (
    entity === "appointment" &&
    m.referenceNo != null &&
    m.appointmentDate &&
    m.purpose != null &&
    m.previousStatus == null &&
    m.newStatus == null
  ) {
    const ref = String(m.referenceNo).trim();
    const date = String(m.appointmentDate).trim();
    const when = String(m.timeLabel || `slot ${m.slotId ?? "—"}`).trim();
    const pur = String(m.purpose).trim() || "—";
    return `Appointment ${ref} booked for ${date} (${when}): ${pur}.`.slice(0, 2000);
  }

  if (entity === "appointment" && m.referenceNo != null && act === "Deleted Record") {
    const ref = String(m.referenceNo).trim();
    const st = String(m.status ?? "—").trim();
    return `Appointment ${ref} deleted (prior status: ${st}).`.slice(0, 2000);
  }

  if (entity === "appointment_slot_override" && m.slotId != null && m.date && m.capacityLimit != null) {
    const lbl = m.slotLabel ? String(m.slotLabel).trim() : `ID ${m.slotId}`;
    return `Appointment slot ${lbl} on ${String(m.date).trim()}: capacity set to ${m.capacityLimit}.`.slice(0, 2000);
  }

  if (entity === "community_announcement" && m.title != null && act === "Deleted Record") {
    return `Announcement deleted: "${String(m.title).trim()}" (${String(m.category || "—").trim()}).`.slice(0, 2000);
  }

  if (entity === "community_announcement" && m.title != null && m.announcementId != null) {
    return `Announcement posted: "${String(m.title).trim()}" (${String(m.category || "—").trim()}).`.slice(0, 2000);
  }

  if (entity === "staff_account" && m.staffEmail) {
    return `Barangay Secretary account created: ${String(m.staffEmail).trim()} (${String(m.fullName || "—").trim()}).`.slice(0, 2000);
  }

  if (entity === "staff_permissions" && m.staffEmail) {
    return `Barangay Secretary permissions updated for ${String(m.staffEmail).trim()}.`.slice(0, 2000);
  }

  if (entity === "profile" && m.deletedEmail) {
    return `User account deleted: ${String(m.deletedEmail).trim()} (role: ${String(m.deletedRole || "—").trim()}).`.slice(
      0,
      2000
    );
  }

  if (entity === "service_catalog" && m.name && act === "Archived Record") {
    return `Service catalog archived: "${String(m.name).trim()}".`.slice(0, 2000);
  }

  if (entity === "service_catalog" && m.name && Array.isArray(m.fieldsChanged) && m.fieldsChanged.length) {
    return `Service catalog updated: "${String(m.name).trim()}" (${m.fieldsChanged.join(", ")}).`.slice(0, 2000);
  }

  if (entity === "service_catalog" && m.name != null && m.serviceId != null) {
    return `Service catalog added: "${String(m.name).trim()}" (${String(m.status || "—").trim()}).`.slice(0, 2000);
  }

  if (entity === "appointment_purpose_catalog" && m.label && act === "Archived Record") {
    return `Appointment purpose archived: "${String(m.label).trim()}" (${String(m.purposeCode || "").trim()}).`.slice(0, 2000);
  }

  if (entity === "appointment_purpose_catalog" && m.label && m.purposeCode) {
    return `Appointment purpose added: "${String(m.label).trim()}" (${String(m.purposeCode).trim()}).`.slice(0, 2000);
  }

  return stripTrailingBracketMetadataSuffix(String(storedDescription || "")).slice(0, 2000);
}

/** Best-effort application audit row (does not fail the calling request). `action` = UI filter label. */
async function insertPortalAuditEvent({
  action,
  description,
  profile,
  performedByEmail,
  performedByName,
  performedByRole,
  metadata
}) {
  const email = performedByEmail ?? profile?.email ?? null;
  const name = performedByName ?? profile?.full_name ?? null;
  const role = performedByRole ?? profile?.role ?? null;
  try {
    await PortalAuditEvent.create({
      action: String(action || "Updated Record").slice(0, 200),
      description: String(description || "").slice(0, 2000),
      performedByEmail: email || null,
      performedByName: name || null,
      performedByRole: role || null,
      metadata: metadata && typeof metadata === "object" ? metadata : {}
    });
  } catch (e) {
    console.warn("[portal_audit_events] insert failed:", e?.message || e);
  }
}

/** Records a real auth event (login/register/password change) — the write side of the audit-logs feature. Fire-and-forget, mirrors insertPortalAuditEvent above. */
async function insertAuthAuditEvent({ action, email, role, req }) {
  try {
    await AuthAuditEvent.create({
      action,
      email: String(email || "").toLowerCase().trim(),
      role: role || null,
      ip: req?.ip || req?.headers?.["x-forwarded-for"] || null
    });
  } catch (e) {
    console.warn("[auth_audit_events] insert failed:", e?.message || e);
  }
}

/** Load auth audit rows from our own AuthAuditEvent collection — replaces the old Supabase RPC/legacy-schema lookup, since Supabase Auth's internal log no longer exists. Only has data from the point this migration went live onward. */
async function fetchAuthAuditRowsForSystemAdmin(limit, query = {}) {
  const lim = Math.min(500, Math.max(1, limit));
  try {
    const rows = await AuthAuditEvent.find(query).sort({ createdAt: -1 }).limit(lim).lean();
    return { rows, error: null, via: "postgres" };
  } catch (error) {
    return { rows: [], error: error.message || "Could not load auth audit log.", via: null };
  }
}

/** UTC instant for 00:00 of a YYYY-MM-DD calendar day in an IANA time zone (so date filters match what the page displays). */
function auditDayStartUtc(ymd, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const g = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const localAsUtc = Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day), Number(g.hour) % 24, Number(g.minute), Number(g.second));
    guess -= localAsUtc - target;
  }
  return new Date(guess);
}

/** Reads ?action=&q=&from=&to= for the audit-log list. Dates are inclusive calendar days in the display time zone. */
function parseAuditLogFilters(query) {
  const tzRaw = process.env.AUDIT_LOG_DISPLAY_TIMEZONE;
  const tz = typeof tzRaw === "string" && tzRaw.trim().length ? tzRaw.trim() : "Asia/Manila";
  const action = String(query?.action || "").trim().slice(0, 80);
  const q = String(query?.q || "").trim().toLowerCase().slice(0, 120);
  let fromDate = null;
  let toDateExclusive = null;
  try {
    const from = String(query?.from || "").trim();
    const to = String(query?.to || "").trim();
    if (from) fromDate = auditDayStartUtc(from, tz);
    if (to) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to);
      if (m) {
        const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
        toDateExclusive = auditDayStartUtc(next.toISOString().slice(0, 10), tz);
      }
    }
  } catch (_e) {
    fromDate = null;
    toDateExclusive = null;
  }
  const createdAt = {};
  if (fromDate) createdAt.$gte = fromDate;
  if (toDateExclusive) createdAt.$lt = toDateExclusive;
  return { action, q, createdAtRange: Object.keys(createdAt).length ? createdAt : null };
}

// ---------------------------------------------------------------------------
// System admin: SMS log (one row per text handed to the gateway — see db/migrations/002_sms_log.sql).
// "sent" means the TextBee gateway accepted the message; it is not a handset delivery receipt.
// ---------------------------------------------------------------------------
const SMS_LOG_PURPOSE_LABELS = {
  request_status: "Request Update",
  announcement: "Announcement",
  password_reset: "Password Reset Code",
  password_changed: "Password Changed Alert"
};

app.get("/system-admin/sms-logs", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "system-admin") {
    return res.status(403).json({ ok: false, message: "System admin role is required to view the SMS log." });
  }
  try {
    const offRaw = Number.parseInt(String(req.query?.offset ?? "0"), 10);
    const offset = Number.isFinite(offRaw) && offRaw >= 0 ? Math.min(offRaw, 1_000_000) : 0;
    const limRaw = Number.parseInt(String(req.query?.limit ?? "15"), 10);
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(100, limRaw) : 15;

    const filters = parseAuditLogFilters(req.query); // reuses from= / to= / q=
    const status = ["sent", "failed"].includes(String(req.query?.status || "")) ? String(req.query.status) : null;
    const purpose = Object.keys(SMS_LOG_PURPOSE_LABELS).includes(String(req.query?.purpose || ""))
      ? String(req.query.purpose)
      : null;

    // Everything except `status`, so the Sent / Failed totals always describe the same filtered set.
    const base = {};
    if (filters.createdAtRange) base.createdAt = filters.createdAtRange;
    if (purpose) base.purpose = purpose;
    if (filters.q) {
      const rx = new RegExp(escapeRegexLiteral(filters.q), "i");
      base.$or = [{ recipient: rx }, { message: rx }, { error: rx }, { relatedId: rx }, { createdByEmail: rx }];
    }
    const listFilter = status ? { ...base, status } : base;

    const [rows, total, sentCount, failedCount] = await Promise.all([
      SmsLog.find(listFilter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      SmsLog.countDocuments(listFilter),
      SmsLog.countDocuments({ ...base, status: "sent" }),
      SmsLog.countDocuments({ ...base, status: "failed" })
    ]);

    const userIds = [...new Set(rows.map((r) => r.residentUserId).filter(Boolean).map(String))];
    const people = userIds.length ? await User.find({ _id: { $in: userIds } }).select("fullName").lean() : [];
    const nameById = new Map(people.map((p) => [String(p._id), p.fullName]));

    return res.json({
      ok: true,
      total,
      offset,
      limit,
      summary: { sent: sentCount, failed: failedCount },
      logs: rows.map((r) => ({
        id: String(r._id),
        purpose: r.purpose,
        purposeLabel: SMS_LOG_PURPOSE_LABELS[r.purpose] || r.purpose,
        recipient: r.recipient,
        residentName: r.residentUserId ? nameById.get(String(r.residentUserId)) || null : null,
        message: r.message,
        status: r.status,
        error: r.error || null,
        relatedType: r.relatedType || null,
        relatedId: r.relatedId || null,
        sentBy: r.createdByEmail || null,
        createdAt: r.createdAt,
        dateDisplay: formatAuditDateDisplay(r.createdAt)
      }))
    });
  } catch (err) {
    if (err?.code === "42P01") {
      // undefined_table: the database has not had db/migrations/002_sms_log.sql applied yet.
      return res.status(500).json({
        ok: false,
        message: 'The SMS log table has not been created yet. Run "node scripts/migrate-db.js" against this database, then reload.'
      });
    }
    return res.status(500).json({ ok: false, message: "Unable to load the SMS log.", detail: err?.message || String(err) });
  }
});

/** Merges our own auth audit events (logins/registrations/password changes) with portal audit events for the system-admin audit UI. */
app.get("/system-admin/audit-logs", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "System admin role is required to view audit logs."
    });
  }

  const offsetRaw = req.query?.offset;
  const paginate =
    offsetRaw !== undefined && offsetRaw !== null && String(offsetRaw).trim() !== "";

  let mergeFetchLimit;
  let pageLimit;
  let responseOffset = 0;
  if (paginate) {
    const off = Number.parseInt(String(offsetRaw), 10);
    responseOffset = Number.isFinite(off) && off >= 0 ? Math.min(off, 1_000_000) : 0;
    const limitRaw = Number(req.query?.limit);
    pageLimit =
      Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(100, Math.max(1, limitRaw)) : 15;
    mergeFetchLimit = 2000;
  } else {
    const limitRaw = Number(req.query?.limit);
    const legacyLimit = Number.isInteger(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 150;
    pageLimit = legacyLimit;
    mergeFetchLimit = legacyLimit;
  }

  const filters = parseAuditLogFilters(req.query);
  const dbDateQuery = filters.createdAtRange ? { createdAt: filters.createdAtRange } : {};

  const rows = [];
  let authError = null;
  let authAuditVia = null;
  let databaseAuditAvailable = false;
  let portalAuditError = null;

  try {
    const portalQuery = { ...dbDateQuery };
    if (filters.action && filters.action !== "Authentication") portalQuery.action = filters.action;
    const portalRows =
      filters.action === "Authentication"
        ? []
        : await PortalAuditEvent.find(portalQuery).sort({ createdAt: -1 }).limit(mergeFetchLimit).lean();
    for (const row of portalRows) {
      const action = String(row.action || "Updated Record").trim();
      if (action === "New Service Request") continue;
      const badgeClass = portalAuditBadgeForFilterAction(action);
      const who = String(row.performedByName || row.performedByEmail || "").trim() || "Unknown";
      rows.push({
        id: `portal:${row._id}`,
        source: "portal",
        displayAction: action,
        filterAction: action,
        badgeClass,
        description: formatPortalAuditDisplayDescription(action, row.metadata, row.description),
        performedBy: who,
        occurredAt: row.createdAt || null,
        dateDisplay: formatAuditDateDisplay(row.createdAt)
      });
    }
  } catch (e) {
    portalAuditError = e?.message || String(e);
  }

  try {
    const skipAuth = Boolean(filters.action) && filters.action !== "Authentication";
    const { rows: authRows, error: fetchErr, via } = skipAuth
      ? { rows: [], error: null, via: "skipped" }
      : await fetchAuthAuditRowsForSystemAdmin(mergeFetchLimit, dbDateQuery);
    authAuditVia = via;
    if (fetchErr) {
      authError = fetchErr;
    } else {
      for (const row of authRows || []) {
        const displayAction = authAuditActionLabel(row.action);
        const parts = [];
        if (displayAction) parts.push(displayAction);
        if (row.email) parts.push(`(${row.email})`);
        if (row.ip) parts.push(`from ${row.ip}`);
        const description = parts.join(" ").trim() || "Authentication event";

        rows.push({
          id: `auth:${row._id}`,
          source: "auth",
          displayAction,
          filterAction: "Authentication",
          badgeClass: "badge-authentication",
          description,
          performedBy: row.email || "Unknown",
          occurredAt: row.createdAt || null,
          dateDisplay: formatAuditDateDisplay(row.createdAt)
        });
      }
    }
  } catch (e) {
    authError = e?.message || String(e);
  }

  // NOTE: this used to also merge in Postgres's `audit.record_version` table
  // — an automatic row-change log populated by Supabase's supa_audit
  // extension for every INSERT/UPDATE/DELETE across every table. MongoDB
  // has no equivalent extension. Replicating it would mean adding
  // before/after change-tracking middleware to every single Mongoose model
  // in this app, which is a meaningfully larger undertaking than the rest
  // of this migration and wasn't asked for — dropped here rather than
  // half-built. `databaseAuditAvailable` stays false, which the response
  // below already handles gracefully (the UI shows portal + auth events
  // only). If granular field-level change history ever becomes a real
  // requirement, that's a dedicated feature to scope separately, not a
  // migration afterthought.

  rows.sort((a, b) => {
    const ta = new Date(a.occurredAt || 0).getTime();
    const tb = new Date(b.occurredAt || 0).getTime();
    return tb - ta;
  });

  // Search runs over the whole (date/action-scoped) log, not just the visible page.
  const searched = filters.q
    ? rows.filter((r) =>
        `${r.displayAction} ${r.description} ${r.performedBy}`.toLowerCase().includes(filters.q)
      )
    : rows;

  const totalMerged = searched.length;
  const trimmed = paginate
    ? searched.slice(responseOffset, responseOffset + pageLimit)
    : searched.slice(0, pageLimit);

  if (rows.length === 0 && authError && !databaseAuditAvailable) {
    return res.status(503).json({
      ok: false,
      message: "Unable to read audit logs. Check the database connection and retry.",
      detail: authError
    });
  }

  let auditDescriptionSummaries = false;
  let logsForResponse = trimmed;
  try {
    const summaries = await summarizeAuditDescriptionsWithGroq(trimmed);
    if (summaries && summaries.length === trimmed.length) {
      logsForResponse = trimmed.map((log, idx) => ({
        ...log,
        description: summaries[idx] ?? log.description
      }));
      auditDescriptionSummaries = summaries.some((s, i) => String(s) !== String(trimmed[i]?.description ?? ""));
    }
  } catch (e) {
    console.warn("[audit groq] summarize failed:", e?.message || e);
  }

  let availableActions = [];
  try {
    const distinctPortal = await PortalAuditEvent.distinct("action");
    availableActions = Array.from(
      new Set(
        [...distinctPortal.map((a) => String(a || "").trim()), "Authentication"].filter(
          (a) => a && a !== "New Service Request"
        )
      )
    ).sort((a, b) => a.localeCompare(b));
  } catch (_e) {
    availableActions = [];
  }

  const meta = {
    availableActions,
    limit: pageLimit,
    authAuditLoaded: !authError,
    authAuditError: authError || null,
    authAuditVia,
    databaseAuditAvailable,
    portalAuditLoaded: !portalAuditError,
    portalAuditError: portalAuditError || null,
    auditDescriptionSummaries
  };
  if (paginate) {
    meta.paginated = true;
    meta.mergedRowCount = totalMerged;
  }

  const body = {
    ok: true,
    logs: logsForResponse,
    meta
  };
  if (paginate) {
    body.total = totalMerged;
    body.limit = pageLimit;
    body.offset = responseOffset;
  }

  return res.json(body);
});

// ---------------------------------------------------------------------------
// System admin: data backup (JSON export).
// Streams every business table as one JSON file so ids and
// dates survive a round trip. Password hashes and session counters are NEVER
// included. Uploaded files (ID photos, attachments, avatars) live in GridFS and
// are not part of this export; only their file ids are kept.
// ---------------------------------------------------------------------------
const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_COLLECTIONS = [
  { key: "users", model: User, select: "-passwordHash -tokenVersion" },
  { key: "serviceRequests", model: ServiceRequest },
  { key: "appointments", model: Appointment },
  { key: "appointmentSlots", model: AppointmentSlot },
  { key: "appointmentSlotOverrides", model: AppointmentSlotOverride },
  { key: "serviceCatalog", model: ServiceCatalog },
  { key: "appointmentPurposeCatalog", model: AppointmentPurposeCatalog },
  { key: "communityAnnouncements", model: CommunityAnnouncement },
  { key: "announcementDrafts", model: AnnouncementDraft },
  { key: "faqEntries", model: FaqEntry },
  { key: "systemSettings", model: SystemSettings },
  { key: "portalAuditEvents", model: PortalAuditEvent },
  { key: "authAuditEvents", model: AuthAuditEvent }
];

function backupFileStamp(date) {
  const tzRaw = process.env.AUDIT_LOG_DISPLAY_TIMEZONE;
  const tz = typeof tzRaw === "string" && tzRaw.trim().length ? tzRaw.trim() : "Asia/Manila";
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })
        .formatToParts(date)
        .map((x) => [x.type, x.value])
    );
    return `${parts.year}${parts.month}${parts.day}-${String(parts.hour).replace("24", "00")}${parts.minute}`;
  } catch (_e) {
    return date.toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");
  }
}

app.get("/system-admin/backup/info", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
  if (!auth) return;
  try {
    const last = await PortalAuditEvent.findOne({ action: "Data Export" }).sort({ createdAt: -1 }).lean();
    return res.json({
      ok: true,
      lastExport: last
        ? {
            at: last.createdAt,
            by: last.performedByName || last.performedByEmail || "System administrator",
            records: Number(last.metadata?.totalRecords) || null
          }
        : null
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to read backup history.", detail: error.message });
  }
});

app.get("/system-admin/backup/export", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
  if (!auth) return;

  const { once } = require("events");
  // The Backup page also reads this export to build its Excel report (?purpose=excel).
  const forExcel = String(req.query?.purpose || "") === "excel";

  let counts;
  try {
    counts = {};
    for (const c of BACKUP_COLLECTIONS) counts[c.key] = await c.model.countDocuments({});
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to prepare the backup.", detail: error.message });
  }
  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);
  const exportedAt = new Date();
  const filename = `serbisyoburgos-backup-${backupFileStamp(exportedAt)}.json`;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

  const write = async (chunk) => {
    if (!res.write(chunk)) await once(res, "drain");
  };

  try {
    const meta = {
      app: "SerbisyoBurgos",
      schemaVersion: BACKUP_SCHEMA_VERSION,
      format: "JSON (ISO-8601 dates, string ids)",
      exportedAt: exportedAt.toISOString(),
      exportedBy: auth.profile?.email || null,
      counts,
      totalRecords,
      notIncluded: ["passwordHash", "tokenVersion", "uploaded files"]
    };
    await write(`{"meta":${JSON.stringify(meta)},"collections":{`);
    let firstCollection = true;
    for (const c of BACKUP_COLLECTIONS) {
      await write(`${firstCollection ? "" : ","}${JSON.stringify(c.key)}:[`);
      firstCollection = false;
      let query = c.model.find({});
      if (c.select) query = query.select(c.select);
      let firstDoc = true;
      for await (const doc of query.lean().cursor()) {
        await write(`${firstDoc ? "" : ","}${JSON.stringify(doc)}`);
        firstDoc = false;
      }
      await write("]");
    }
    // The trailing flag lets a restore tool tell a complete file from a cut-off download.
    await write('},"complete":true}');
    res.end();
  } catch (error) {
    console.error("[backup] export failed mid-stream:", error?.message || error);
    res.destroy(error);
    return;
  }

  void insertPortalAuditEvent({
    action: "Data Export",
    description: forExcel
      ? `System data exported for an Excel report (${totalRecords} records across ${BACKUP_COLLECTIONS.length} collections).`
      : `System data export downloaded (${totalRecords} records across ${BACKUP_COLLECTIONS.length} collections).`,
    profile: auth.profile,
    metadata: { entity: "backup", totalRecords, counts, filename, purpose: forExcel ? "excel" : "json" }
  });
});

// Start the API server on the configured port (explicit http.Server for error + diagnostics).
// ---------------------------------------------------------------------------
// Animal Vaccine Tracker (staff portal): one record per pet, linked to its owner (a resident),
// with a simple vaccinated / not vaccinated flag.
// Open to every staff-portal role (staff, admin, system-admin).
// Records are archived, not deleted.
// ---------------------------------------------------------------------------

/** Today's date (YYYY-MM-DD) in Philippine time. */
function todayPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeAnimalRow(row) {
  const vaccinated = Boolean(row.vaccinated);
  return {
    id: String(row._id),
    animalCode: row.animalCode,
    ownerUserId: row.ownerUserId ? String(row.ownerUserId) : null,
    ownerResidentId: row.ownerResidentId || "",
    ownerName: row.ownerName || "",
    ownerContact: row.ownerContact || "",
    ownerAddress: row.ownerAddress || "",
    name: row.name || "",
    species: row.species,
    speciesOther: row.speciesOther || "",
    vaccinated,
    status: vaccinated ? "Vaccinated" : "Not Vaccinated",
    archivedAt: row.archivedAt || null,
    createdAt: row.createdAt
  };
}

/** Accepts true/false, "true"/"false", "yes"/"no", 1/0. Returns null when the value is not a clear yes/no. */
function parseVaccinatedFlag(raw) {
  if (typeof raw === "boolean") return raw;
  const v = String(raw ?? "").trim().toLowerCase();
  if (["true", "yes", "1", "vaccinated"].includes(v)) return true;
  if (["false", "no", "0", "not vaccinated"].includes(v)) return false;
  return null;
}

async function parseAnimalBody(body, { partial = false } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  if (!partial || has("ownerName")) {
    const v = sanitizePlainTextField(b.ownerName, 120);
    if (!v) return { error: "Owner name is required." };
    out.ownerName = v;
  }
  if (!partial || has("name")) {
    const v = sanitizePlainTextField(b.name, 80);
    if (!v) return { error: "Pet name is required." };
    out.name = v;
  }
  if (!partial || has("species")) {
    const v = String(b.species || "").trim();
    if (!ANIMAL_SPECIES.includes(v)) return { error: "Species must be Dog, Cat or Other." };
    out.species = v;
  }
  if (!partial || has("speciesOther") || out.species) {
    const v = sanitizePlainTextField(b.speciesOther, 60);
    if (out.species === "Other" && !v) return { error: "Please say what kind of pet it is." };
    if (out.species) out.speciesOther = out.species === "Other" ? v : "";
    else if (has("speciesOther")) out.speciesOther = v;
  }
  if (has("ownerContact")) out.ownerContact = sanitizePlainTextField(b.ownerContact, 30);
  if (has("ownerAddress")) out.ownerAddress = sanitizePlainTextField(b.ownerAddress, 250);

  if (has("vaccinated")) {
    const flag = parseVaccinatedFlag(b.vaccinated);
    if (flag === null) return { error: "Vaccinated must be Yes or No." };
    out.vaccinated = flag;
  } else if (!partial) {
    out.vaccinated = false;
  }

  // Owner link to a confirmed resident (optional).
  if (has("ownerUserId")) {
    const idStr = String(b.ownerUserId || "").trim();
    if (!idStr) {
      out.ownerUserId = null;
      out.ownerResidentId = "";
    } else {
      if (!isValidId(idStr)) return { error: "Invalid resident selected as owner." };
      let owner = null;
      try {
        owner = await User.findOne(confirmedResidentQuery({ _id: idStr })).select("residentId").lean();
      } catch (_e) {
        owner = null;
      }
      if (!owner) return { error: "The selected resident was not found." };
      out.ownerUserId = owner._id;
      out.ownerResidentId = owner.residentId || "";
    }
  }
  return { value: out };
}

async function generateAnimalCode() {
  for (let i = 0; i < 8; i += 1) {
    const code = `ANM-${Math.floor(1000 + Math.random() * 9000)}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await AnimalRecord.exists({ animalCode: code }))) return code;
  }
  return `ANM-${Date.now().toString().slice(-7)}`;
}

function animalAuditDescription(verb, animal) {
  return `${verb} pet record ${animal.animalCode} (${animal.name}, ${animal.species}) owned by ${animal.ownerName} - ${animal.status}.`;
}

// Owner lookup for the "Add animal" form (confirmed residents only, minimal fields).
app.get("/staff/animals/owners", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const q = String(req.query?.q || "").trim().slice(0, 80);
  if (q.length < 2) return res.json({ ok: true, owners: [] });
  const rx = new RegExp(escapeRegexLiteral(q), "i");
  try {
    const rows = await User.find(
      confirmedResidentQuery({ $or: [{ fullName: rx }, { residentId: rx }, { contactNumber: rx }] })
    )
      .select("residentId fullName contactNumber residentProfile.address residentProfile.purok")
      .sort({ fullName: 1 })
      .limit(8)
      .lean();
    return res.json({
      ok: true,
      owners: rows.map((r) => ({
        id: String(r._id),
        residentId: r.residentId || "",
        fullName: r.fullName || "",
        contactNumber: r.contactNumber || "",
        address: [r.residentProfile?.purok, r.residentProfile?.address].filter(Boolean).join(", ")
      }))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to search residents.", detail: error.message });
  }
});

// NOTE: must be declared before "/staff/animals/:id".
app.get("/staff/animals/export", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  try {
    const includeArchived = String(req.query?.archived || "") === "1";
    const rows = await AnimalRecord.find(includeArchived ? { archivedAt: { $ne: null } } : { archivedAt: null })
      .sort({ ownerName: 1, name: 1 })
      .limit(5000)
      .lean();
    const today = todayPH();
    const header = ["PET CODE", "PET NAME", "SPECIES", "OWNER", "OWNER CONTACT", "OWNER ADDRESS", "VACCINATED"];
    const lines = [header.map(csvCell).join(",")];
    for (const row of rows) {
      const a = normalizeAnimalRow(row);
      lines.push([
        a.animalCode, a.name, a.species === "Other" ? a.speciesOther || "Other" : a.species,
        a.ownerName, a.ownerContact, a.ownerAddress, a.vaccinated ? "Yes" : "No"
      ].map(csvCell).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="Pet-Vaccine-Tracker-${today}.csv"`);
    void insertPortalAuditEvent({
      action: "Data Export",
      description: `Exported ${rows.length} pet vaccination record(s) to CSV.`,
      profile: auth.profile,
      metadata: { entity: "animal_record", count: rows.length }
    });
    return res.send(`\uFEFF${lines.join("\r\n")}\r\n`);
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to export animal records.", detail: error.message });
  }
});

app.get("/staff/animals", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const archived = String(req.query?.archived || "") === "1";
  try {
    const rows = await AnimalRecord.find(archived ? { archivedAt: { $ne: null } } : { archivedAt: null })
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean();
    const animals = rows.map((r) => normalizeAnimalRow(r));
    const vaccinated = animals.filter((a) => a.vaccinated).length;
    const stats = { total: animals.length, vaccinated, notVaccinated: animals.length - vaccinated };
    return res.json({ ok: true, animals, stats, today: todayPH() });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to load animal records.", detail: error.message });
  }
});

app.post("/staff/animals", adminStaffCreateLimiter, async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const parsed = await parseAnimalBody(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, message: parsed.error });

  try {
    const created = await AnimalRecord.create({
      ...parsed.value,
      animalCode: await generateAnimalCode(),
      createdByEmail: auth.profile.email || ""
    });
    const animal = normalizeAnimalRow(created.toObject());
    void insertPortalAuditEvent({
      action: "Updated Record",
      description: animalAuditDescription("Added", animal),
      profile: auth.profile,
      metadata: { entity: "animal_record", animalId: animal.id, animalCode: animal.animalCode }
    });
    return res.status(201).json({ ok: true, animal });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to save the animal record.", detail: error.message });
  }
});

app.get("/staff/animals/:id", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const id = String(req.params.id || "");
  if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid animal id." });
  try {
    const row = await AnimalRecord.findById(id).lean();
    if (!row) return res.status(404).json({ ok: false, message: "Animal record not found." });
    return res.json({ ok: true, animal: normalizeAnimalRow(row) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to load the animal record.", detail: error.message });
  }
});

app.patch("/staff/animals/:id", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const id = String(req.params.id || "");
  if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid animal id." });

  const parsed = await parseAnimalBody(req.body, { partial: true });
  if (parsed.error) return res.status(400).json({ ok: false, message: parsed.error });
  if (!Object.keys(parsed.value).length) return res.status(400).json({ ok: false, message: "Nothing to update." });

  try {
    const row = await AnimalRecord.findOneAndUpdate({ _id: id, archivedAt: null }, { $set: parsed.value }, { new: true }).lean();
    if (!row) return res.status(404).json({ ok: false, message: "Animal record not found (or archived)." });
    const animal = normalizeAnimalRow(row);
    void insertPortalAuditEvent({
      action: "Updated Record",
      description: animalAuditDescription("Updated", animal),
      profile: auth.profile,
      metadata: { entity: "animal_record", animalId: animal.id, animalCode: animal.animalCode }
    });
    return res.json({ ok: true, animal });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to update the animal record.", detail: error.message });
  }
});

app.post("/staff/animals/:id/archive", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const id = String(req.params.id || "");
  if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid animal id." });
  try {
    const row = await AnimalRecord.findOneAndUpdate({ _id: id, archivedAt: null }, { $set: { archivedAt: new Date() } }, { new: true }).lean();
    if (!row) return res.status(404).json({ ok: false, message: "Animal record not found or already archived." });
    const animal = normalizeAnimalRow(row);
    void insertPortalAuditEvent({
      action: "Archived Record",
      description: animalAuditDescription("Archived", animal),
      profile: auth.profile,
      metadata: { entity: "animal_record", animalId: animal.id, animalCode: animal.animalCode }
    });
    return res.json({ ok: true, animal });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to archive the animal record.", detail: error.message });
  }
});

app.post("/staff/animals/:id/restore", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const id = String(req.params.id || "");
  if (!isValidId(id)) return res.status(400).json({ ok: false, message: "Invalid animal id." });
  try {
    const row = await AnimalRecord.findOneAndUpdate({ _id: id, archivedAt: { $ne: null } }, { $set: { archivedAt: null } }, { new: true }).lean();
    if (!row) return res.status(404).json({ ok: false, message: "Archived animal record not found." });
    const animal = normalizeAnimalRow(row);
    void insertPortalAuditEvent({
      action: "Updated Record",
      description: animalAuditDescription("Restored", animal),
      profile: auth.profile,
      metadata: { entity: "animal_record", animalId: animal.id, animalCode: animal.animalCode }
    });
    return res.json({ ok: true, animal });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Unable to restore the animal record.", detail: error.message });
  }
});

// ---------------------------------------------------------------------------
// Last-resort handlers: always answer with short JSON, never an HTML error page or a stack trace.
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ ok: false, message: "Not found." });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 500) console.error(`[api-error] ${req.method} ${req.path}:`, err?.stack || err);
  if (res.headersSent) return next(err);
  let message = "Something went wrong. Please try again.";
  if (status === 400) message = "The request could not be understood.";
  else if (status === 413) message = "The request is too large.";
  else if (status === 429) message = "Too many requests. Please try again later.";
  res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, message });
});

const server = http.createServer(app);

server.on("error", (err) => {
  console.error("[backend] Server failed to start:", err.message);
  if (err.code === "EADDRINUSE") {
    console.error(`[backend] Port ${port} is already in use. Stop the other process or set PORT in .env.`);
  }
  process.exit(1);
});

// Connect to PostgreSQL before accepting any requests — fail fast and loud
// rather than letting every route error out individually on a dead connection.
connectPg()
  .then(() =>
    // "Head of the family" mark used for announcement SMS (same as db/migrations/003_household_head.sql).
    pool.query("ALTER TABLE resident_profiles ADD COLUMN IF NOT EXISTS is_household_head boolean NOT NULL DEFAULT false")
      .then(() => pool.query("ALTER TABLE resident_profiles ADD COLUMN IF NOT EXISTS household_no text NOT NULL DEFAULT ''"))
      .then(() => pool.query("CREATE INDEX IF NOT EXISTS resident_profiles_household_no_idx ON resident_profiles (household_no)"))
      .catch((err) => console.error("[backend] Could not add household columns on resident_profiles:", err.message))
  )
  .then(() => ensureServiceHourSlots())
  .then(() => {
    server.listen(port, "0.0.0.0", () => {
      const addr = server.address();
      const where =
        typeof addr === "object" && addr
          ? `http://127.0.0.1:${addr.port} (bound ${addr.address})`
          : `http://localhost:${port}`;
      console.log(`Backend running on ${where}`);
      console.log("[backend] Leave this terminal open while developing. Press Ctrl+C to stop.");
    });
  })
  .catch((err) => {
    console.error("[backend] Failed to connect to PostgreSQL:", err.message);
    process.exit(1);
  });

function gracefulShutdown(signal) {
  intentionalShutdown = true;
  console.log(`[backend] ${signal} received — closing HTTP server...`);
  server.close(() => {
    console.log("[backend] HTTP server closed.");
    process.exit(0);
  });
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));