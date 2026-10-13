require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { connectMongo } = require("./config/mongoClient");
const {
  verifyAccessToken,
  verifyRefreshToken,
  signAccessToken,
  signRefreshToken,
  hashPassword,
  verifyPassword
} = require("./config/auth");
const { User } = require("./models/User");
const { CATEGORY, storeFile, deleteFile, streamFile } = require("./config/upload");
const { ServiceCatalog } = require("./models/ServiceCatalog");
const CommunityAnnouncement = require("./models/CommunityAnnouncement");
const { FaqEntry } = require("./models/FaqEntry");
const AppointmentPurposeCatalog = require("./models/AppointmentPurposeCatalog");
const PortalAuditEvent = require("./models/PortalAuditEvent");
const { AuthAuditEvent } = require("./models/AuthAuditEvent");
const AppointmentSlot = require("./models/AppointmentSlot");
const AppointmentSlotOverride = require("./models/AppointmentSlotOverride");
const { Appointment, APPOINTMENT_STATUSES } = require("./models/Appointment");
const { ServiceRequest, SERVICE_REQUEST_STATUSES } = require("./models/ServiceRequest");
const { SystemSettings, SINGLETON_ID } = require("./models/SystemSettings");

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

const residentChangePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many password change attempts. Please try again later." }
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

const adminStaffCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many staff creation attempts. Please try again later." }
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
// every route now runs on MongoDB/JWT (see src/config/mongoClient.js,
// src/config/auth.js, src/models/). Removed rather than left as unused
// dead code.

const requestEventClients = new Set();
const appointmentEventClients = new Set();
const announcementEventClients = new Set();

const MAX_EMAIL_LEN = 254;
const MAX_FULL_NAME_LEN = 120;
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
 * DB value: active | suspended | deactivated.
 * - active: resident may log in and use the resident portal normally.
 * - suspended | deactivated: login and resident portal APIs are blocked (see residentPortalAccountBlockMessage).
 */
function normalizeAccountStatusFromInput(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "active" || s === "suspended" || s === "deactivated") return s;
  return null;
}

function mapAccountStatusToUiLabel(dbValue) {
  const s = String(dbValue ?? "active")
    .trim()
    .toLowerCase();
  if (s === "suspended") return "Suspended";
  if (s === "deactivated") return "Deactivated";
  return "Active";
}

/** If resident is not active, return login/API error message; active residents get null (full portal access). */
function residentPortalAccountBlockMessage(accountStatusRaw) {
  const s = String(accountStatusRaw ?? "active")
    .trim()
    .toLowerCase();
  if (s === "suspended") return "Your account is suspended.";
  if (s === "deactivated") {
    return "Your account is deactivated. Please visit the barangay hall if you wish to activate your account.";
  }
  return null;
}

const STAFF_PERMISSION_KEYS = ["dashboard", "appointmentScheduling", "requestProcessing", "documentGenerator"];

function defaultStaffPermissionsAllTrue() {
  return {
    dashboard: true,
    appointmentScheduling: true,
    requestProcessing: true,
    documentGenerator: true
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
    documentGenerator: false
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

  if (userDoc.role === "resident") {
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
  };

  return { profile, authUserId: String(userDoc._id) };
}

const STAFF_PORTAL_ROLES = new Set(["admin", "staff", "system-admin"]);

async function requireResidentPortalUser(req, res) {
  const { profile, authUserId, error } = await resolveProfileFromToken(req);
  if (error) {
    res.status(error.status).json({ ok: false, message: error.message });
    return null;
  }
  if (profile.role !== "resident") {
    res.status(403).json({ ok: false, message: "Resident portal access required." });
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
  if (userDoc.role === "resident") {
    const blockMsg = residentPortalAccountBlockMessage(userDoc.accountStatus);
    if (blockMsg) {
      return { ok: false, status: 403, message: blockMsg };
    }
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
const GROQ_CHAT_DEFAULT_MODEL = "llama-3.3-70b-versatile";
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
  if (!mongoose.Types.ObjectId.isValid(slotIdStr)) return null;
  const safeDate = parseLocalDateString(dateISO);
  if (!safeDate) return null;

  const [slot, override] = await Promise.all([
    AppointmentSlot.findById(slotIdStr).select("defaultCapacity isActive").lean(),
    AppointmentSlotOverride.findOne({ slotId: slotIdStr, overrideDate: safeDate })
      .select("capacityLimit")
      .lean()
  ]);

  if (!slot) return null;
  if (slot.isActive === false) return null;

  const overrideCap = Number(override?.capacityLimit);
  if (Number.isInteger(overrideCap) && overrideCap > 0) return overrideCap;

  const defaultCap = Number(slot.defaultCapacity);
  if (!Number.isInteger(defaultCap) || defaultCap <= 0) return null;
  return defaultCap;
}

async function countBookedAppointmentsForSlot(slotId, dateISO) {
  const slotIdStr = String(slotId || "");
  if (!mongoose.Types.ObjectId.isValid(slotIdStr)) return null;
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
    return { ok: true, environment: env };
  } catch (error) {
    return { ok: false, detail: error.message };
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

async function rewriteFaqWithGroq(userQuestion, matches) {
  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, reason: "no_api_key" };
  }

  const model = String(process.env.GROQ_MODEL || "").trim() || GROQ_CHAT_DEFAULT_MODEL;
  const excerpts = buildFaqContextBlock(matches);

  const systemPrompt = [
    "You are a Philippine barangay resident assistant answering questions using ONLY the FAQ excerpts provided by the user message.",
    "Understand the user's question whether it is in English, Tagalog, Taglish, or mixed—then reply in CLEAR, EASY-TO-READ English suited for non-technical residents.",
    "Rewrite faithfully: simplify wording and sentence length, prefer short bullets when helpful, but do NOT remove required steps, conditions, statuses, dashboard names, or fees that appear in the excerpts.",
    "Keep these exact phrases when referring to portals (capitalization as in excerpts): \"Service Requests\", \"Recent Service Requests\", and \"Request History\"—these may become clickable links in the app.",
    "Do not invent requirements, deadlines, contacts, URLs, offices, amounts, fees, portal names, or processes that are not in the excerpts.",
    "If excerpts do not cover part of the question, say clearly in simple English what is unknown and advise visiting/contacting the barangay.",
    "Do not prefix answers like \"FAQ 1\". No markdown/HTML."
  ].join("\n");

  const userPayload = [
    "Do this:",
    "1) Read the RESIDENT QUESTION below (English/Tagalog/Taglish acceptable). Understand intent.",
    "2) Decide which excerpt(s) apply.",
    "3) Answer in SIMPLE English using ONLY excerpt facts.",
    "",
    `RESIDENT QUESTION:\n${userQuestion}`,
    "",
    `OFFICIAL FAQ EXCERPTS:\n${excerpts}`
  ].join("\n");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);

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
          { role: "user", content: userPayload }
        ],
        temperature: 0.2,
        max_tokens: 700
      }),
      signal: ac.signal
    });

    const rawText = await res.text();
    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      return { ok: false, reason: "bad_response", status: res.status, detail: rawText.slice(0, 400) };
    }

    if (!res.ok) {
      const msg = json?.error?.message || rawText.slice(0, 400);
      return { ok: false, reason: "groq_http", status: res.status, detail: msg };
    }

    const text = sanitizeChatReply(json?.choices?.[0]?.message?.content);
    if (!text) {
      return { ok: false, reason: "empty_content" };
    }

    return { ok: true, text, model };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network", detail: String(err?.message || err).slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

/** Strip optional ```json fences from model output. */
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
          max_tokens: 4096
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
  const hasMongoConfig = Boolean(String(process.env.MONGODB_URI || "").trim());
  const hasJwtConfig = Boolean(
    String(process.env.JWT_ACCESS_SECRET || "").trim() && String(process.env.JWT_REFRESH_SECRET || "").trim()
  );
  const groqConfigured = Boolean(String(process.env.GROQ_API_KEY || "").trim());

  res.json({
    ok: true,
    service: "backend",
    mongoConfigured: hasMongoConfig,
    jwtConfigured: hasJwtConfig,
    groqConfigured
  });
});

// Lightweight readiness check for the MongoDB connection. Renamed from the
// old /supabase/health — confirmed via grep that nothing in the frontend
// calls this route by name, so the URL itself is free to change.
app.get("/mongodb/health", async (_req, res) => {
  const configured = Boolean(process.env.MONGODB_URI);
  const connected = mongoose.connection.readyState === 1; // 1 = connected
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

// Authenticate an admin account and return auth session details.
app.post("/auth/admin/login", async (req, res) => {
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

  const passwordOk = await verifyPassword(String(password), userDoc.passwordHash);
  if (!passwordOk) {
    return res.status(401).json({ ok: false, message: "Invalid email or password." });
  }

  const allowedAdminRoles = new Set(["admin", "staff", "system-admin"]);
  if (!allowedAdminRoles.has(userDoc.role)) {
    return res.status(403).json({
      ok: false,
      message: "Access denied. Admin portal account required."
    });
  }

  if (!userDoc.isActive) {
    return res.status(403).json({ ok: false, message: "This account has been deactivated." });
  }

  const userPayload = {
    email: userDoc.email,
    fullName: userDoc.fullName,
    role: userDoc.role
  };
  if (userDoc.role === "staff") {
    userPayload.staffPermissions = normalizeStaffPermissionsFromDb(userDoc.staffPermissions);
  }

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
    admin: ["admin"],
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

function normalizeRequestRow(row) {
  return {
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

async function upsertResidentProfile({ email, fullName, residentSelfRegistered = false, identityVerificationFileId = null, passwordHash = null }) {
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

  try {
    const created = await User.findOneAndUpdate(
      { email: normalizedEmail },
      { $set: upsertPayload },
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
  return mongoose.Types.ObjectId.isValid(str) ? str : null;
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

app.post(
  "/auth/resident/register",
  authResidentRegisterLimiter,
  residentRegisterUploadMiddleware,
  async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { fullName, email, password } = body;
    const normalizedEmail = normalizeEmail(email);
    const safeFullName = sanitizeFullNameForStorage(fullName);
    const safePassword = String(password || "");
    const idFile = req.file;

    if (!safeFullName || !normalizedEmail || !safePassword) {
      return res.status(400).json({
        ok: false,
        message: "fullName, email, password, and identityVerification file are required."
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
      passwordHash
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
      message: "Resident account created.",
      stored: true,
      user: {
        email: normalizedEmail,
        fullName: safeFullName,
        role: "resident",
        residentUserId: profileResult.userId
      }
    });
  }
);

app.post("/auth/resident/login", authResidentLoginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const safePassword = String(password || "");

  if (!normalizedEmail || !safePassword) {
    return res.status(400).json({
      ok: false,
      message: "Email and password are required."
    });
  }

  if (!isValidEmailFormat(normalizedEmail) || safePassword.length > MAX_PASSWORD_LEN) {
    return res.status(400).json({
      ok: false,
      message: "Invalid email or password."
    });
  }

  const userDoc = await User.findOne({ email: normalizedEmail }).select("+passwordHash");
  if (!userDoc) {
    return res.status(401).json({ ok: false, message: "Invalid email or password." });
  }

  const passwordOk = await verifyPassword(safePassword, userDoc.passwordHash);
  if (!passwordOk) {
    return res.status(401).json({ ok: false, message: "Invalid email or password." });
  }

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
      avatarUrl: userDoc.avatarFileId ? `/files/${userDoc.avatarFileId}` : null
    },
    session: {
      accessToken,
      refreshToken,
      expiresAt
    }
  });
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
      avatarUrl: profile.avatar_url ?? null
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
  if (!hasContact && !hasEmail) {
    return res.status(400).json({
      ok: false,
      message: "Provide contactNumber and/or email to update."
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

  if (Object.keys(profilePatch).length === 0) {
    const p = auth.profile;
    return res.json({
      ok: true,
      email: p.email,
      fullName: p.full_name || "",
      contactNumber: p.contact_number ?? null,
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
  if (!mongoose.Types.ObjectId.isValid(id)) {
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
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;
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

  const userDoc = await User.findById(auth.authUserId).select("+passwordHash");
  if (!userDoc) {
    return res.status(500).json({ ok: false, message: "Unable to resolve user for password update." });
  }

  if (currentPassword) {
    const currentOk = await verifyPassword(currentPassword, userDoc.passwordHash);
    if (!currentOk) {
      return res.status(401).json({ ok: false, message: "Current password is incorrect." });
    }
  }

  userDoc.passwordHash = await hashPassword(newPassword);
  // Invalidates every previously issued refresh token at once — the
  // MongoDB replacement for Supabase Auth's automatic session revocation
  // on password change.
  userDoc.tokenVersion = (userDoc.tokenVersion || 0) + 1;
  await userDoc.save();

  void insertAuthAuditEvent({ action: "password_change", email: userDoc.email, role: userDoc.role, req });

  return res.json({ ok: true, message: "Password updated successfully." });
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
    slots = await AppointmentSlot.find({ isActive: true }).sort({ _id: 1 }).lean();
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
    return {
      id: slotId,
      code: slot.slotCode,
      label: slot.label,
      phaseLabel: slot.phaseLabel || null,
      isMorningPickupOnly: Boolean(slot.isMorningPickupOnly),
      capacity,
      booked,
      remaining,
      isFull: capacity > 0 ? booked >= capacity : true
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

  if (!mongoose.Types.ObjectId.isValid(String(slotId || ""))) {
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

  return res.json({
    ok: true,
    requests: data.map(normalizeRequestRow)
  });
});

app.get("/requests/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!mongoose.Types.ObjectId.isValid(id)) {
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

app.patch("/requests/:id/status", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;

  const id = String(req.params.id || "");
  const { status, note } = req.body || {};
  const safeNote =
    typeof note === "string" && note.trim() ? sanitizePlainTextField(note, MAX_STATUS_NOTE_LEN) : null;
  if (!mongoose.Types.ObjectId.isValid(id)) {
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

  return res.json({
    ok: true,
    request: requestRow
  });
});

app.post("/requests", async (req, res) => {
  const auth = await requireResidentPortalUser(req, res);
  if (!auth) return;

  const { title, serviceType, preferredDate, preferredTimeSlot } = req.body || {};

  const safeTitle = sanitizePlainTextField(title, MAX_REQUEST_TITLE_LEN);
  const safeServiceType = sanitizePlainTextField(serviceType, MAX_SERVICE_TYPE_LEN);
  const safePreferredDate = parseLocalDateString(preferredDate);
  const safeTimeSlot = sanitizePlainTextField(preferredTimeSlot, MAX_TIME_SLOT_LEN);

  if (!safeTitle || !safeServiceType || !safePreferredDate || !safeTimeSlot) {
    return res.status(400).json({
      ok: false,
      message: "title, serviceType, preferredDate, and preferredTimeSlot are required. Use YYYY-MM-DD for dates."
    });
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

app.delete("/requests/:id", async (req, res) => {
  const actor = await requireStaffOrAuthenticatedResident(req, res);
  if (!actor) return;

  const id = String(req.params.id || "");
  if (!mongoose.Types.ObjectId.isValid(id)) {
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
      message: "Unable to delete request.",
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

  let data;
  try {
    data = await ServiceRequest.findByIdAndDelete(id).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to delete request.",
      detail: error.message
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Request not found."
    });
  }

  const requestRow = normalizeRequestRow(data);
  broadcastRequestEvent({ type: "deleted", request: requestRow });

  void insertPortalAuditEvent({
    action: "Deleted Record",
    description: `Deleted service request ${existing.referenceNo || id} (${String(existing.serviceType || "").trim() || "—"}). Prior status: "${String(existing.status || "").trim() || "—"}". Title: "${String(existing.title || "").trim() || "—"}". Request ID: ${id}.`,
    profile: actor.profile,
    metadata: {
      entity: "service_request",
      requestId: id,
      referenceNo: existing.referenceNo,
      serviceType: existing.serviceType,
      title: existing.title,
      status: existing.status,
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

  return res.json({
    ok: true,
    appointments: data.map(normalizeAppointmentRow)
  });
});

app.get("/appointments/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!mongoose.Types.ObjectId.isValid(id)) {
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
  if (!mongoose.Types.ObjectId.isValid(parsedSlotId)) {
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
  if (!mongoose.Types.ObjectId.isValid(id)) {
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
  const apNoteLine = safeNote ? ` Staff note: ${safeNote}` : "";
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
  if (!mongoose.Types.ObjectId.isValid(id)) {
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
      message: "Unable to delete appointment.",
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

  let data;
  try {
    data = await Appointment.findByIdAndDelete(id).lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to delete appointment.",
      detail: error.message
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      message: "Appointment not found."
    });
  }

  const appointmentRow = normalizeAppointmentRow(data);
  broadcastAppointmentEvent({ type: "deleted", appointment: appointmentRow });

  void insertPortalAuditEvent({
    action: "Deleted Record",
    description: `Deleted appointment ${existing.referenceNo || id}. Prior status: "${String(existing.status || "").trim() || "—"}". Date: ${String(existing.appointmentDate || "").trim() || "—"}. Purpose: "${String(existing.purpose || "").trim() || "—"}". Slot ID: ${existing.slotId ? String(existing.slotId) : "—"}. Appointment ID: ${id}.`,
    profile: actor.profile,
    metadata: {
      entity: "appointment",
      appointmentId: id,
      referenceNo: existing.referenceNo,
      status: existing.status,
      appointmentDate: existing.appointmentDate,
      purpose: existing.purpose,
      slotId: existing.slotId ? String(existing.slotId) : null,
      portal: actor.portal
    }
  });

  return res.json({
    ok: true,
    appointment: appointmentRow
  });
});

// --- FAQ retrieval + Groq rewrite (resident chatbot) ---

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

  const retrieved = await retrieveFaqMatchesInternal(query, limit);
  if (!retrieved.ok) {
    return res.status(500).json({
      ok: false,
      message: retrieved.message,
      detail: retrieved.detail
    });
  }

  const noMatchMessage =
    "I don't have the right answer to your question. Visit the barangay hall during office hours or contact the barangay for accurate information.";

  if (!retrieved.matches.length) {
    return res.json({
      ok: true,
      reply: noMatchMessage,
      mode: "no_match",
      confidence: retrieved.confidence,
      sources: []
    });
  }

  const groq = await rewriteFaqWithGroq(query, retrieved.matches);
  const sources = retrieved.matches.map((m) => ({ id: m.id, question: m.question, category: m.category }));

  if (groq.ok) {
    return res.json({
      ok: true,
      reply: groq.text,
      mode: "groq",
      model: groq.model,
      confidence: retrieved.confidence,
      sources
    });
  }

  const topAnswer = retrieved.matches[0].answer;
  const fallbackReply = sanitizeChatReply(topAnswer);
  return res.json({
    ok: true,
    reply: fallbackReply,
    mode: "verbatim_fallback",
    groqUnavailable: groq.reason,
    confidence: retrieved.confidence,
    sources
  });
});

// --- Community announcements (resident bulletin; admin creates) ---

app.get("/announcements", async (_req, res) => {
  let announcements;
  try {
    announcements = await CommunityAnnouncement.find({ isActive: true })
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

  const filter = { isActive: true };
  const filterRole = String(req.query?.postedByRole ?? "").trim();
  if (filterRole === "admin") filter.postedByRole = "admin";

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
    announcement: createdRow
  });
});

/** List all announcements (including inactive) for admin reporting table. */
app.get("/admin/announcements", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "admin") {
    return res.status(403).json({ ok: false, message: "Admin role required to list announcements." });
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

/** Permanently remove an announcement (admin only). */
app.delete("/admin/announcements/:id", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "admin") {
    return res.status(403).json({
      ok: false,
      message: "Admin role required to delete announcements."
    });
  }

  const id = String(req.params.id || "");
  if (!mongoose.Types.ObjectId.isValid(id)) {
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

  try {
    await CommunityAnnouncement.findByIdAndDelete(id);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to delete announcement.",
      detail: error.message
    });
  }

  broadcastAnnouncementEvent({ type: "deleted", id });

  void insertPortalAuditEvent({
    action: "Deleted Record",
    description: `Deleted community announcement ID ${id}. Title: "${String(existing.title || "").trim() || "—"}". Category: "${String(existing.category || "").trim() || "—"}". Was active: ${Boolean(existing.isActive)}. Original posted-by role: ${existing.postedByRole ?? "—"}.`,
    profile: auth.profile,
    metadata: {
      entity: "community_announcement",
      announcementId: id,
      title: existing.title,
      category: existing.category,
      postedByRole: existing.postedByRole,
      isActive: existing.isActive,
      createdAt: existing.createdAt
    }
  });

  return res.json({ ok: true, message: "Announcement deleted." });
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
const ANALYTICS_HOURLY_CHART_START_HOUR = 9;
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

/** Bar chart order: 9 AM first, then forward through the day; hours before 9 (e.g. 8 AM) trail at the end. */
function analyticsSlotBarOrderKey(hour24) {
  if (!Number.isInteger(hour24) || hour24 < 0 || hour24 > 23) return 1000;
  return (hour24 + 15) % 24;
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
  if (auth.profile.role !== "admin") {
    return res.status(403).json({
      ok: false,
      message: "Admin role required to view hourly demand analytics."
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
  if (auth.profile.role !== "admin") {
    return res.status(403).json({
      ok: false,
      message: "Admin role required to view analytics."
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
    activeResidents = await User.countDocuments({ role: "resident", isActive: true });
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
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
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
      max_tokens: 500
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
    if (auth.profile.role !== "admin") {
      return res.status(403).json({
        ok: false,
        message: "Admin role required to generate decision insights."
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

app.get("/admin/profiles", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const actorRole = auth.profile.role;
  if (actorRole !== "admin" && actorRole !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "Barangay admin or system administrator role is required to list users."
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
    actorRole === "system-admin" ? { role: { $ne: "system-admin" } } : { role: { $nin: ["admin", "system-admin"] } };

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
  if (actorRole !== "admin" && actorRole !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "Barangay admin or system administrator role is required to load profiles."
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

  if (actorRole === "admin" && (data.role === "admin" || data.role === "system-admin")) {
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
  if (actorRole !== "admin" && actorRole !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "Barangay admin or system administrator role is required."
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
  if (actorRole === "admin" && (target.role === "admin" || target.role === "system-admin")) {
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

/** Set account status (Active / Suspended / Deactivated). Active = full resident portal access; other values block login and APIs. */
app.patch("/admin/profiles/account-status", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  const actorRole = auth.profile.role;
  if (actorRole !== "admin" && actorRole !== "system-admin") {
    return res.status(403).json({
      ok: false,
      message: "Barangay admin or system administrator role is required."
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
      message: "accountStatus must be Active, Suspended, or Deactivated."
    });
  }

  if (normalizeEmail(auth.profile.email) === targetEmail) {
    return res.status(400).json({ ok: false, message: "You cannot change your own account status here." });
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
  if (target.role === "admin" || target.role === "system-admin") {
    return res.status(403).json({ ok: false, message: "Administrator account status cannot be changed from this action." });
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

  return res.json({
    ok: true,
    email: updated?.email || targetEmail,
    accountStatus: mapAccountStatusToUiLabel(updated?.accountStatus)
  });
});

/** Barangay admin creates a staff account (email/password + page permissions) in MongoDB. */
app.post("/admin/staff", adminStaffCreateLimiter, async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "admin") {
    return res.status(403).json({
      ok: false,
      message: "Only barangay administrators can create staff accounts."
    });
  }

  const body = req.body || {};
  const { fullName, email, password } = body;
  const normalizedEmail = normalizeEmail(email);
  const safeFullName = sanitizeFullNameForStorage(fullName);
  const safePassword = String(password || "");
  const perms = normalizeStaffPermissionsFromBody(body.permissions ?? body);

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
      message: "Unable to create staff account.",
      detail: error.message
    });
  }

  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Created staff account for ${normalizedEmail}. Name: "${safeFullName}". Permissions JSON keys: ${Object.keys(perms || {}).join(", ") || "—"}.`,
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
    message: "Staff account created.",
    user: {
      email: normalizedEmail,
      fullName: safeFullName,
      role: "staff",
      staffPermissions: perms
    }
  });
});

/** Update saved page permissions for an existing staff profile (admin only). */
app.patch("/admin/staff/permissions", async (req, res) => {
  const auth = await requireStaffPortalUser(req, res);
  if (!auth) return;
  if (auth.profile.role !== "admin") {
    return res.status(403).json({
      ok: false,
      message: "Only barangay administrators can update staff permissions."
    });
  }

  const normalizedEmail = normalizeEmail(req.body?.email ?? "");
  if (!normalizedEmail || !isValidEmailFormat(normalizedEmail)) {
    return res.status(400).json({
      ok: false,
      message: "A valid staff email is required."
    });
  }

  const perms = normalizeStaffPermissionsFromBody(req.body?.permissions ?? req.body);

  let profile;
  try {
    profile = await User.findOne({ email: normalizedEmail }).select("email role").lean();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to load profile.",
      detail: error.message
    });
  }

  if (!profile || profile.role !== "staff") {
    return res.status(404).json({
      ok: false,
      message: "No staff account found for that email."
    });
  }

  try {
    await User.updateOne({ email: normalizedEmail, role: "staff" }, { $set: { staffPermissions: perms } });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Unable to update staff permissions.",
      detail: error.message
    });
  }

  void insertPortalAuditEvent({
    action: "Updated Record",
    description: `Updated staff page permissions for ${normalizedEmail}. Permission keys: ${Object.keys(perms || {}).join(", ") || "—"}.`,
    profile: auth.profile,
    metadata: {
      entity: "staff_permissions",
      staffEmail: normalizedEmail,
      staffPermissions: perms
    }
  });

  return res.json({
    ok: true,
    message: "Staff permissions updated.",
    staffPermissions: perms
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
  if (actorRole !== "admin" && actorRole !== "system-admin") {
    return res.status(403).json({ ok: false, message: "Barangay admin or system administrator role is required." });
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

  if (actorRole === "admin" && profile.role === "admin") {
    return res.status(403).json({ ok: false, message: "Deleting admin accounts is not allowed." });
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
  if (auth.profile.role !== "admin") {
    return res.status(403).json({ ok: false, message: "Admin role required to view this summary." });
  }

  const { monthStartIso, monthEndIso } = getLocalCalendarMonthStartEndIso();
  const { monthStartDate, monthEndDate } = getLocalCalendarMonthDateStrings();

  let totalServices, staffCount, residentCount, monthRequestsCount, monthAppointmentsCount, totalAnnouncementsPosted;
  try {
    [totalServices, staffCount, residentCount, monthRequestsCount, monthAppointmentsCount, totalAnnouncementsPosted] =
      await Promise.all([
        ServiceCatalog.countDocuments({ archivedAt: null }),
        User.countDocuments({ role: "staff" }),
        User.countDocuments({ role: "resident" }),
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
  if (!mongoose.Types.ObjectId.isValid(id)) {
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
  if (!mongoose.Types.ObjectId.isValid(id)) {
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

  let admins, staff, residents, serviceRequestsTotal, appointmentsTotal, latestAuditEvent, auditEventsLast7Days;
  try {
    [admins, staff, residents, serviceRequestsTotal, appointmentsTotal, latestAuditEvent, auditEventsLast7Days] =
      await Promise.all([
        User.countDocuments({ role: "admin" }),
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

  const portalUserTotal = admins + staff + residents;
  const environment = await getPortalEnvironmentFromDb();
  const lastAuditAt = latestAuditEvent?.createdAt ? String(latestAuditEvent.createdAt) : null;

  return res.json({
    ok: true,
    portalUsers: {
      total: portalUserTotal,
      admins,
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
  if (!mongoose.Types.ObjectId.isValid(id)) {
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

app.get("/system-admin/appointment-purpose-types", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
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

app.post("/system-admin/appointment-purpose-types", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
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
      // E11000 = MongoDB's duplicate key error, matching the old Postgres
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

app.delete("/system-admin/appointment-purpose-types/:id", async (req, res) => {
  const auth = await requireSystemAdminUser(req, res);
  if (!auth) return;

  const id = String(req.params.id || "");
  if (!mongoose.Types.ObjectId.isValid(id)) {
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
  password_change: "Password Changed"
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
    return `Staff account created: ${String(m.staffEmail).trim()} (${String(m.fullName || "—").trim()}).`.slice(0, 2000);
  }

  if (entity === "staff_permissions" && m.staffEmail) {
    return `Staff permissions updated for ${String(m.staffEmail).trim()}.`.slice(0, 2000);
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
async function fetchAuthAuditRowsForSystemAdmin(limit) {
  const lim = Math.min(500, Math.max(1, limit));
  try {
    const rows = await AuthAuditEvent.find({}).sort({ createdAt: -1 }).limit(lim).lean();
    return { rows, error: null, via: "mongodb" };
  } catch (error) {
    return { rows: [], error: error.message || "Could not load auth audit log.", via: null };
  }
}

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

  const rows = [];
  let authError = null;
  let authAuditVia = null;
  let databaseAuditAvailable = false;
  let portalAuditError = null;

  try {
    const portalRows = await PortalAuditEvent.find({}).sort({ createdAt: -1 }).limit(mergeFetchLimit).lean();
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
    const { rows: authRows, error: fetchErr, via } = await fetchAuthAuditRowsForSystemAdmin(mergeFetchLimit);
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

  const totalMerged = rows.length;
  const trimmed = paginate
    ? rows.slice(responseOffset, responseOffset + pageLimit)
    : rows.slice(0, pageLimit);

  if (rows.length === 0 && authError && !databaseAuditAvailable) {
    return res.status(503).json({
      ok: false,
      message: "Unable to read audit logs. Check the MongoDB connection and retry.",
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

  const meta = {
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

// Start the API server on the configured port (explicit http.Server for error + diagnostics).
const server = http.createServer(app);

server.on("error", (err) => {
  console.error("[backend] Server failed to start:", err.message);
  if (err.code === "EADDRINUSE") {
    console.error(`[backend] Port ${port} is already in use. Stop the other process or set PORT in .env.`);
  }
  process.exit(1);
});

// Connect to MongoDB before accepting any requests — fail fast and loud
// rather than letting every route error out individually on a dead
// connection (mirrors how the old Supabase client was expected to just
// be ready by the time requests came in).
connectMongo()
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
    console.error("[backend] Failed to connect to MongoDB:", err.message);
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