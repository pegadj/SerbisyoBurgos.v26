-- 002_sms_log.sql — one row per text message handed (or failed to hand) to the SMS gateway.
--
-- status 'sent'   = the TextBee gateway ACCEPTED the message (it is now queued on the Android phone).
--                   Actual delivery to the handset depends on the phone and the mobile network and is not
--                   reported back, so "sent" is not a delivery receipt.
-- status 'failed' = the gateway rejected it or could not be reached (see `error`), or SMS is not configured.
--
-- Safe to run more than once. Password-reset codes are NEVER stored: the app writes a redacted message.
BEGIN;

CREATE TABLE IF NOT EXISTS sms_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose           text        NOT NULL,   -- request_status | announcement | password_reset | password_changed
  recipient         text        NOT NULL,   -- +639XXXXXXXXX
  resident_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
  message           text        NOT NULL,
  status            text        NOT NULL CHECK (status IN ('sent','failed')),
  error             text,
  related_type      text,                   -- service_request | announcement | ...
  related_id        text,
  created_by_email  text,                   -- staff member who triggered it (NULL for automatic ones)
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_log_created ON sms_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_log_status  ON sms_log (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_log_purpose ON sms_log (purpose);
CREATE INDEX IF NOT EXISTS idx_sms_log_user    ON sms_log (resident_user_id);

COMMIT;

-- Optional housekeeping (Render Cron Job, e.g. weekly) to keep the table small:
--   DELETE FROM sms_log WHERE created_at < now() - interval '180 days';
