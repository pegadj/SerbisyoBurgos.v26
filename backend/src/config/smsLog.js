const { pool } = require('./pgClient');

// Writes one sms_log row per recipient. Logging must NEVER break or slow the actual sending, so every
// failure here is swallowed (and printed) instead of thrown.
//
//   meta.purpose          request_status | announcement | password_reset | password_changed
//   meta.logMessage       text to store instead of the real message (used to hide password-reset codes)
//   meta.userIds          { "+639...": "<resident user uuid>" }  (optional)
//   meta.relatedType/Id   what triggered the text, e.g. service_request + its id
//   meta.createdByEmail   staff member who triggered it
async function recordSms(recipients, message, status, error, meta = {}) {
  try {
    if (!Array.isArray(recipients) || !recipients.length) return;
    const userIds = recipients.map((r) => (meta.userIds && meta.userIds[r]) || null);
    await pool.query(
      `INSERT INTO sms_log (purpose, recipient, resident_user_id, message, status, error, related_type, related_id, created_by_email)
       SELECT $1, t.recipient, t.user_id, $4, $5, $6, $7, $8, $9
       FROM unnest($2::text[], $3::uuid[]) AS t(recipient, user_id)`,
      [
        String(meta.purpose || 'other'),
        recipients,
        userIds,
        String(meta.logMessage != null ? meta.logMessage : message).replace(/\u0000/g, ''),
        status,
        error ? String(error).slice(0, 500) : null,
        meta.relatedType || null,
        meta.relatedId != null ? String(meta.relatedId) : null,
        meta.createdByEmail || null,
      ],
    );
  } catch (err) {
    console.warn('[sms-log] could not record SMS result:', err.message);
  }
}

module.exports = { recordSms };
