/**
 * Finds the best Gemini model for your key: which ones work, which thinking level they accept, and how long
 * a realistic chatbot request takes. Use it when the chatbot is slow or logs "Gemini failed".
 *
 *   node scripts/test-gemini.js                 # tests your GEMINI_MODEL first, then the best stable Flash / Flash-Lite models
 *   node scripts/test-gemini.js gemini-3.5-flash-lite gemini-3.6-flash    # test specific models only
 *
 * The chatbot gives Gemini 8 seconds (GEMINI_TIMEOUT_MS). Pick a model that is comfortably under that.
 */
require('dotenv').config();
const KEY = String(process.env.GEMINI_API_KEY || '').trim();
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT = 20000;
if (!KEY) { console.error('GEMINI_API_KEY is not set in .env'); process.exit(1); }

// A realistic request: the real chatbot instructions plus a sample question.
let SYSTEM = 'You are a helpful assistant. Reply with JSON only.';
try { SYSTEM = require('../src/services/chatbot').buildSystemPrompt(); } catch (_e) { /* use the short prompt */ }
const USER = 'LIVE BARANGAY FACTS:\n(none)\n\nOFFICIAL FAQ EXCERPTS:\n(none)\n\nRESIDENT QUESTION (untrusted, latest message):\nPano ko malalaman kung tapos na ang request ko?';

async function http(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try { return await fetch(url, { ...opts, headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' }, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function listModels() {
  const res = await http(`${BASE}/models?pageSize=200`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('Could not list models:', res.status, json?.error?.message || ''); process.exit(1); }
  return (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-.*flash/i.test(n));
}

async function once(model, thinkingLevel, realistic) {
  const gc = { temperature: 0.2, maxOutputTokens: realistic ? 600 : 100, responseMimeType: 'application/json' };
  if (thinkingLevel) gc.thinkingConfig = { thinkingLevel };
  const body = {
    contents: [{ role: 'user', parts: [{ text: realistic ? USER : 'Reply with JSON only: {"reply":"ok"}' }] }],
    generationConfig: gc,
  };
  if (realistic) body.systemInstruction = { parts: [{ text: SYSTEM }] };
  const started = Date.now();
  try {
    const res = await http(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', body: JSON.stringify(body) });
    const ms = Date.now() - started;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, ms, why: `HTTP ${res.status}: ${String(json?.error?.message || '').slice(0, 80)}` };
    return { ok: true, ms, thoughts: json.usageMetadata?.thoughtsTokenCount || 0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, why: e.name === 'AbortError' ? `TIMEOUT (${TIMEOUT / 1000}s)` : `network error: ${e.message}` };
  }
}

async function testModel(model) {
  // Try thinking levels from fastest to slowest until one is accepted.
  for (const level of ['minimal', 'low', null]) {
    const quick = await once(model, level, false);
    if (quick.ok) {
      const real = await once(model, level, true);
      return { model, level, quick, real };
    }
    // A timeout or "not available" will not be fixed by a different thinking level.
    if (!/thinking/i.test(quick.why || '')) return { model, level, quick, real: null };
  }
  return { model, level: null, quick: { ok: false, ms: 0, why: 'no thinking level accepted' }, real: null };
}

(async () => {
  const args = process.argv.slice(2);
  let models = args;
  if (!models.length) {
    const all = await listModels();
    console.log('Flash models your key can see:\n  ' + all.join('\n  ') + '\n');
    const stable = all.filter((n) => !/preview|omni/i.test(n) && !/^gemini-2\./.test(n)); // skip previews and old 2.x models
    const rank = (n) => (/lite/i.test(n) ? 0 : 1);
    models = [...new Set([String(process.env.GEMINI_MODEL || '').trim(), ...stable.sort((a, b) => rank(a) - rank(b))].filter(Boolean))].slice(0, 7);
  }
  console.log('Testing (small request, then a realistic chatbot-sized request):\n');
  const results = [];
  for (const m of models) {
    const r = await testModel(m);
    results.push(r);
    if (!r.quick.ok) { console.log(`${m.padEnd(30)} FAILED  ${r.quick.why}`); continue; }
    const real = r.real;
    console.log(`${m.padEnd(30)} ok  thinking=${r.level || 'default'}  small=${r.quick.ms}ms  realistic=${real.ok ? real.ms + 'ms' : 'FAILED ' + real.why}${real.ok ? `  (thinking tokens: ${real.thoughts})` : ''}`);
  }
  const good = results.filter((r) => r.real && r.real.ok).sort((a, b) => a.real.ms - b.real.ms);
  console.log('');
  if (!good.length) {
    console.log('No model answered a realistic request. Check the FAILED reasons above (quota, key, or model access).');
    return;
  }
  const best = good[0];
  console.log(`Fastest: ${best.model} (${best.real.ms} ms). Put this in .env and on Render:\n`);
  console.log(`  GEMINI_MODEL=${best.model}`);
  console.log(`  GEMINI_THINKING_LEVEL=${best.level || 'off'}`);
  if (best.real.ms > 6000) console.log('\nNote: over 6 seconds is slow for a chat. The chatbot gives up on Gemini after 8 seconds and uses Groq.');
})();