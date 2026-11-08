// TextBee SMS gateway client (https://textbee.dev) — sends SMS through your own Android phone.
// Env: TEXTBEE_API_KEY, TEXTBEE_DEVICE_ID, optional TEXTBEE_BASE_URL.

const BASE_URL = (process.env.TEXTBEE_BASE_URL || "https://api.textbee.dev/api/v1").replace(/\/$/, "");
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1500;

function isSmsConfigured() {
  return Boolean(process.env.TEXTBEE_API_KEY && process.env.TEXTBEE_DEVICE_ID);
}

/** Normalizes Philippine mobile numbers to +639XXXXXXXXX. Returns null if not a valid PH mobile. */
function normalizePhNumber(raw) {
  let d = String(raw || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (/^09\d{9}$/.test(d)) d = "63" + d.slice(1);
  else if (/^9\d{9}$/.test(d)) d = "63" + d;
  return /^639\d{9}$/.test(d) ? "+" + d : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendOneBatch(recipients, message) {
  const url = `${BASE_URL}/gateway/devices/${encodeURIComponent(process.env.TEXTBEE_DEVICE_ID)}/send-sms`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.TEXTBEE_API_KEY },
    body: JSON.stringify({ recipients, message })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TextBee ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** Sends the same message to many numbers in small batches. Never throws. */
async function sendSmsBatch(numbers, message) {
  const result = { sent: 0, failed: 0, errors: [] };
  if (!isSmsConfigured()) {
    result.failed = numbers.length;
    result.errors.push("TextBee is not configured (TEXTBEE_API_KEY / TEXTBEE_DEVICE_ID).");
    return result;
  }
  for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
    const chunk = numbers.slice(i, i + BATCH_SIZE);
    try {
      await sendOneBatch(chunk, message);
      result.sent += chunk.length;
    } catch (err) {
      result.failed += chunk.length;
      if (result.errors.length < 3) result.errors.push(err.message);
    }
    if (i + BATCH_SIZE < numbers.length) await sleep(BATCH_DELAY_MS);
  }
  return result;
}

module.exports = { isSmsConfigured, normalizePhNumber, sendSmsBatch };