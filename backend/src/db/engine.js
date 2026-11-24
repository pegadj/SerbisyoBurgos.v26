'use strict';
/**
 * Minimal query layer over `pg` that keeps the call style server.js already uses
 * (Model.find(filter).select().sort().skip().limit().lean(), findOneAndUpdate, $set/$inc/$push/$pull,
 * hydrated docs with .save()/.toObject()) while generating plain, parameterised SQL.
 *
 * It deliberately supports ONLY what the portal uses. Anything else throws or warns loudly instead of
 * guessing. Behaviour deliberately preserved from MongoDB:
 *   - NULLs sort lowest (ASC => NULLS FIRST, DESC => NULLS LAST)
 *   - text sorts are bytewise (COLLATE "C") like Mongo's default, so ordering does not change
 *   - {field: null} matches NULL; $ne / $nin also match NULL rows
 *   - sort by _id == creation order (created_at, then id)
 *   - legacy 24-hex ObjectIds (e.g. inside still-valid JWTs) are mapped to the migrated UUIDs
 *   - unique violations surface as err.code === 11000 with err.keyPattern, as server.js expects
 *   - unknown fields in filters behave like "missing field" (as in Mongo); unknown fields in writes are
 *     dropped with a one-time warning (as Mongoose strict mode did)
 */
const { pool } = require('../config/pgClient');

// ------------------------------------------------------------------ ids
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OID_RE = /^[0-9a-f]{24}$/i;

/** uuid | legacy 24-hex ObjectId (or anything with a matching toString) -> uuid string, else null. */
function normalizeId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (UUID_RE.test(s)) return s.toLowerCase();
  if (OID_RE.test(s)) {
    const h = ('00000000' + s).toLowerCase(); // same mapping as scripts/migrate-mongo-to-postgres.js
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null;
}
const isValidId = (v) => normalizeId(v) !== null;

// ---------------------------------------------------------------- helpers
const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const PG_TYPE = { uuid: 'uuid', text: 'text', bool: 'boolean', int: 'integer', ts: 'timestamptz', date: 'date', jsonb: 'jsonb', texts: 'text[]' };
const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[db] ${msg}`);
}
const isPlain = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const isOpObject = (v) => isPlain(v) && Object.keys(v).some((k) => k.startsWith('$'));
const stripNul = (s) => s.replace(/\u0000/g, '');
const DEBUG = process.env.DB_DEBUG === '1';

function mapPgError(e) {
  if (e && e.code === '23505') { // unique_violation -> Mongo duplicate-key shape
    e.pgCode = '23505';
    e.code = 11000;
    const m = /Key \(([^)]+)\)=\(([^)]*)\)/.exec(e.detail || '');
    e.keyPattern = {};
    e.keyValue = {};
    if (m) m[1].split(',').map((c) => c.trim().replace(/^lower\((.*)\)$/, '$1')).forEach((c, i) => {
      e.keyPattern[camel(c)] = 1;
      e.keyValue[camel(c)] = m[2].split(',')[i];
    });
  }
  return e;
}

async function runQuery(client, text, params) {
  if (DEBUG) console.log('[sql]', text.replace(/\s+/g, ' '), params); // eslint-disable-line no-console
  try {
    return await (client || pool).query(text, params);
  } catch (e) {
    throw mapPgError(e);
  }
}

async function withTx(fn, existing) {
  if (existing) return fn(existing);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw mapPgError(e);
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------- model def
function normFields(spec, extra = {}) {
  const out = {};
  for (const [name, d] of Object.entries(spec)) {
    const o = typeof d === 'string' ? { t: d } : { ...d };
    o.name = name;
    o.col = o.col || snake(name);
    out[name] = o;
  }
  return Object.assign(out, extra);
}

/**
 * def = {
 *   name, table, idType: 'uuid'|'text',
 *   fields:   { camelName: 'type' | { t, col?, lower?, trim?, hidden?, nullAs?, emptyAsNull?, out? } },
 *   embedded: { name: { table, fk, alias, fields } }       // 1:1 sub-document living in its own table
 *   children: { name: { table, fk, fields } }               // 1:N array of sub-documents
 * }
 */
function defineModel(def) {
  const model = {
    name: def.name,
    table: def.table,
    idCol: 'id',
    idType: def.idType || 'uuid',
    fields: normFields(def.fields),
    embedded: {},
    children: {},
  };
  model.idField = { name: '_id', col: 'id', t: model.idType };
  for (const [n, e] of Object.entries(def.embedded || {})) model.embedded[n] = { ...e, name: n, fields: normFields(e.fields) };
  for (const [n, c] of Object.entries(def.children || {})) model.children[n] = { ...c, name: n, fields: normFields(c.fields) };
  model.createdCol = model.fields.createdAt ? model.fields.createdAt.col : null;
  model.hasEmbedded = Object.keys(model.embedded).length > 0;

  const api = {
    modelName: model.name,
    find: (filter) => new Query(model, 'find', { filter }),
    findOne: (filter) => new Query(model, 'findOne', { filter }),
    findById: (id) => new Query(model, 'findOne', { filter: { _id: id } }),
    findOneAndUpdate: (filter, update, opts) => new Query(model, 'findOneAndUpdate', { filter, update, opts: opts || {} }),
    findByIdAndUpdate: (id, update, opts) => new Query(model, 'findOneAndUpdate', { filter: { _id: id }, update, opts: opts || {} }),
    findByIdAndDelete: (id) => new Query(model, 'findOneAndDelete', { filter: { _id: id } }),
    updateOne: (filter, update, opts) => new Query(model, 'updateOne', { filter, update, opts: opts || {} }),
    deleteOne: (filter) => new Query(model, 'deleteOne', { filter }),
    deleteMany: (filter) => new Query(model, 'deleteMany', { filter }),
    countDocuments: (filter) => new Query(model, 'count', { filter }),
    exists: (filter) => new Query(model, 'exists', { filter }),
    distinct: (field, filter) => new Query(model, 'distinct', { field, filter }),
    create: (doc) => new Query(model, 'create', { doc }),
    insertMany: (docs) => new Query(model, 'insertMany', { docs }),
    _model: model,
  };
  return api;
}

// --------------------------------------------------------- value coercion
function coerceIn(f, v) {
  if (v === null || v === undefined) return null;
  switch (f.t) {
    case 'uuid': return normalizeId(v);
    case 'text': {
      let s = stripNul(String(v));
      if (f.trim) s = s.trim();
      if (f.lower) s = s.toLowerCase();
      if (f.emptyAsNull && s === '') return null;
      return s;
    }
    case 'bool': return Boolean(v);
    case 'int': { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : null; }
    case 'ts': { const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
    case 'date': {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
      return String(v).slice(0, 10);
    }
    case 'jsonb': return stripNul(JSON.stringify(v)).replace(/\\u0000/g, '');
    case 'texts': return (Array.isArray(v) ? v : [v]).map((x) => stripNul(String(x)));
    default: return v;
  }
}
/** Value for a write: honours nullAs (NOT NULL text columns that Mongoose allowed to be null). */
function coerceWrite(f, v) {
  const out = coerceIn(f, v);
  if (out === null && f.nullAs !== undefined) return f.nullAs;
  if (f.max && typeof out === 'string' && out.length > f.max) {
    // Same contract as Mongoose's maxlength validator: reject, never silently truncate.
    const e = new Error(`${f.name} is longer than the maximum allowed length (${f.max}).`);
    e.name = 'ValidationError';
    throw e;
  }
  return out;
}

// --------------------------------------------------------------- resolving
const MISSING = { sql: 'NULL::text', f: { t: 'text' }, missing: true };

function resolve(model, key) {
  if (key === '_id' || key === 'id') return { sql: `t."${model.idCol}"`, f: model.idField };
  const f = model.fields[key];
  if (f) return { sql: `t."${f.col}"`, f };
  const dot = key.indexOf('.');
  if (dot > 0) {
    const emb = model.embedded[key.slice(0, dot)];
    const ef = emb && emb.fields[key.slice(dot + 1)];
    if (ef) return { sql: `${emb.alias}."${ef.col}"`, f: ef, embedded: emb.name };
  }
  warnOnce(`${model.name}.${key}`, `${model.name}: "${key}" is not a column; treated as a missing field.`);
  return MISSING;
}

// ------------------------------------------------------------ filter => SQL
function compileCond(r, raw, params) {
  const { sql, f } = r;
  const p = (v) => { params.push(coerceIn(f, v)); return `$${params.length}::${PG_TYPE[f.t] || 'text'}`; };
  const arr = (vals) => { params.push(vals.map((x) => coerceIn(f, x))); return `$${params.length}::${PG_TYPE[f.t] || 'text'}[]`; };
  const eq = (v) => (f.t === 'texts' ? `${p(v)} = ANY(${sql})` : `${sql} = ${p(v)}`);

  if (raw === undefined || raw === null) return `${sql} IS NULL`;
  if (raw instanceof RegExp) {
    params.push(raw.source);
    const op = raw.flags.includes('i') ? '~*' : '~';
    if (f.t === 'texts') return `EXISTS (SELECT 1 FROM unnest(${sql}) AS e WHERE e ${op} $${params.length})`;
    return `${sql} ${op} $${params.length}`;
  }
  if (!isOpObject(raw)) return eq(raw);

  const conds = [];
  for (const [op, v] of Object.entries(raw)) {
    switch (op) {
      case '$eq': conds.push(v == null ? `${sql} IS NULL` : eq(v)); break;
      case '$ne': conds.push(v == null ? `${sql} IS NOT NULL` : `${sql} IS DISTINCT FROM ${p(v)}`); break;
      case '$gt': conds.push(`${sql} > ${p(v)}`); break;
      case '$gte': conds.push(`${sql} >= ${p(v)}`); break;
      case '$lt': conds.push(`${sql} < ${p(v)}`); break;
      case '$lte': conds.push(`${sql} <= ${p(v)}`); break;
      case '$exists': conds.push(v ? `${sql} IS NOT NULL` : `${sql} IS NULL`); break;
      case '$in':
      case '$nin': {
        const list = Array.isArray(v) ? v : [];
        const hasNull = list.some((x) => x === null || x === undefined);
        const vals = list.filter((x) => x !== null && x !== undefined).map((x) => coerceIn(f, x)).filter((x) => x !== null);
        if (op === '$in') {
          if (!vals.length && !hasNull) conds.push('FALSE');
          else conds.push(`(${[vals.length ? `${sql} = ANY(${arr(vals)})` : null, hasNull ? `${sql} IS NULL` : null].filter(Boolean).join(' OR ')})`);
        } else if (hasNull) {
          conds.push(vals.length ? `(${sql} IS NOT NULL AND ${sql} <> ALL(${arr(vals)}))` : `${sql} IS NOT NULL`);
        } else {
          conds.push(vals.length ? `(${sql} IS NULL OR ${sql} <> ALL(${arr(vals)}))` : 'TRUE');
        }
        break;
      }
      default: throw new Error(`Unsupported filter operator ${op}`);
    }
  }
  return conds.length ? conds.join(' AND ') : 'TRUE';
}

function compileFilter(model, filter, params, ctx) {
  const parts = [];
  for (const [key, raw] of Object.entries(filter || {})) {
    if (key === '$or' || key === '$and') {
      const subs = (raw || []).map((s) => compileFilter(model, s, params, ctx));
      if (!subs.length) parts.push(key === '$or' ? 'FALSE' : 'TRUE');
      else parts.push('(' + subs.map((s) => `(${s})`).join(key === '$or' ? ' OR ' : ' AND ') + ')');
      continue;
    }
    const dot = key.indexOf('.');
    const child = dot > 0 ? model.children[key.slice(0, dot)] : null;
    if (child) {
      if (key.slice(dot + 1) !== '_id') throw new Error(`Unsupported child filter ${key}`);
      const id = normalizeId(isPlain(raw) && '$eq' in raw ? raw.$eq : raw);
      if (!id) { parts.push('FALSE'); continue; }
      ctx.childIds = ctx.childIds || {};
      ctx.childIds[child.name] = id;
      params.push(id);
      parts.push(`EXISTS (SELECT 1 FROM "${child.table}" c WHERE c."${child.fk}" = t."${model.idCol}" AND c."id" = $${params.length}::uuid)`);
      continue;
    }
    parts.push(compileCond(resolve(model, key), raw, params));
  }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

function joinSql(model) {
  return Object.values(model.embedded)
    .map((e) => ` LEFT JOIN "${e.table}" ${e.alias} ON ${e.alias}."${e.fk}" = t."${model.idCol}"`)
    .join('');
}

function compileSort(model, sort) {
  let entries = [];
  if (typeof sort === 'string') entries = sort.split(/\s+/).filter(Boolean).map((s) => (s[0] === '-' ? [s.slice(1), -1] : [s, 1]));
  else if (sort) entries = Object.entries(sort);
  const out = [];
  let hasId = false;
  for (const [k, d] of entries) {
    const dir = d === -1 || d === 'desc' || d === 'descending' ? 'DESC' : 'ASC';
    if (k === '_id' || k === 'id') {
      hasId = true;
      if (model.createdCol) out.push(`t."${model.createdCol}" ${dir}`);
      out.push(`t."${model.idCol}" ${dir}`);
      continue;
    }
    const r = resolve(model, k);
    if (r.missing) continue;
    out.push(`${r.sql}${r.f.t === 'text' ? ' COLLATE "C"' : ''} ${dir} NULLS ${dir === 'ASC' ? 'FIRST' : 'LAST'}`);
  }
  if (!hasId) out.push(`t."${model.idCol}" ASC`); // stable pagination
  return out;
}

// -------------------------------------------------------------- selection
function parseSelect(model, str) {
  const tokens = String(str || '').split(/\s+/).filter(Boolean);
  const inc = tokens.filter((t) => t[0] !== '-' && t[0] !== '+');
  const plus = tokens.filter((t) => t[0] === '+').map((t) => t.slice(1));
  const exc = tokens.filter((t) => t[0] === '-').map((t) => t.slice(1));
  const sel = { base: new Set(), emb: {}, kids: new Set() };
  const allEmb = (e) => new Set(Object.keys(e.fields));
  if (!inc.length) {
    for (const [n, f] of Object.entries(model.fields)) if (!f.hidden) sel.base.add(n);
    for (const [n, e] of Object.entries(model.embedded)) sel.emb[n] = allEmb(e);
    for (const n of Object.keys(model.children)) sel.kids.add(n);
  } else {
    for (const t of inc) {
      if (model.fields[t]) sel.base.add(t);
      else if (model.embedded[t]) sel.emb[t] = allEmb(model.embedded[t]);
      else if (model.children[t]) sel.kids.add(t);
      else if (t.includes('.') && model.embedded[t.split('.')[0]]) {
        const [en, fn] = t.split('.');
        if (model.embedded[en].fields[fn]) (sel.emb[en] = sel.emb[en] || new Set()).add(fn);
      } else if (t !== '_id') warnOnce(`${model.name}.sel.${t}`, `${model.name}: select("${t}") is not a column; ignored.`);
    }
  }
  for (const t of plus) if (model.fields[t]) sel.base.add(t);
  for (const t of exc) {
    sel.base.delete(t); sel.kids.delete(t); delete sel.emb[t];
    if (t.includes('.')) { const [en, fn] = t.split('.'); if (sel.emb[en]) sel.emb[en].delete(fn); }
  }
  return sel;
}

function selectSql(model, sel) {
  const cols = [`t."${model.idCol}"::text AS "_id"`];
  for (const n of sel.base) cols.push(`t."${model.fields[n].col}" AS "${n}"`);
  for (const [en, set] of Object.entries(sel.emb)) {
    const e = model.embedded[en];
    cols.push(`${e.alias}."${e.fk}" AS "${en}.__x"`);
    for (const fn of set) cols.push(`${e.alias}."${e.fields[fn].col}" AS "${en}.${fn}"`);
  }
  return cols.join(', ');
}

function outValue(f, v) {
  if (v === null || v === undefined) return v;
  if (f.out) return f.out(v);
  return v;
}

function hydrateRow(model, row, sel, kidsByParent) {
  const o = { _id: row._id };
  for (const n of sel.base) o[n] = outValue(model.fields[n], row[n]);
  for (const [en, set] of Object.entries(sel.emb)) {
    if (row[`${en}.__x`] === null || row[`${en}.__x`] === undefined) continue; // no sub-document
    const sub = {};
    for (const fn of set) sub[fn] = outValue(model.embedded[en].fields[fn], row[`${en}.${fn}`]);
    o[en] = sub;
  }
  for (const kn of sel.kids) o[kn] = (kidsByParent[kn] && kidsByParent[kn].get(row._id)) || [];
  return o;
}

async function loadChildren(model, sel, ids, client) {
  const out = {};
  for (const kn of sel.kids) {
    const c = model.children[kn];
    const map = new Map();
    out[kn] = map;
    if (!ids.length) continue;
    const order = c.fields.createdAt ? `"${c.fields.createdAt.col}", "id"` : '"id"';
    const res = await runQuery(client, `SELECT * FROM "${c.table}" WHERE "${c.fk}" = ANY($1::uuid[]) ORDER BY ${order}`, [ids]);
    for (const r of res.rows) {
      const o = { _id: r.id };
      for (const [n, f] of Object.entries(c.fields)) o[n] = outValue(f, r[f.col]);
      const key = String(r[c.fk]);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(o);
    }
  }
  return out;
}

// ------------------------------------------------------------ hydrated doc
function toPlain(doc) {
  const o = {};
  for (const k of Object.keys(doc)) o[k] = doc[k];
  return o;
}
const snapshotOf = (o) => JSON.stringify(o, (k, v) => (v === undefined ? null : v));

function makeDoc(model, obj) {
  const snap = {};
  const take = () => {
    for (const k of Object.keys(obj)) snap[k] = snapshotOf(obj[k]);
  };
  take();
  Object.defineProperties(obj, {
    id: { value: obj._id, enumerable: false, writable: true },
    toObject: { value: () => toPlain(obj), enumerable: false },
    toJSON: { value: () => toPlain(obj), enumerable: false },
    save: {
      enumerable: false,
      value: async function save() {
        const changes = {};
        for (const k of Object.keys(obj)) {
          if (k === '_id') continue;
          if (model.fields[k]) {
            if (snap[k] !== snapshotOf(obj[k])) changes[k] = obj[k];
          } else if (model.embedded[k] && isPlain(obj[k])) {
            const before = snap[k] ? JSON.parse(snap[k]) : {};
            for (const [sk, sv] of Object.entries(obj[k])) {
              if (JSON.stringify(before[sk] ?? null) !== snapshotOf(sv)) changes[`${k}.${sk}`] = sv;
            }
          }
        }
        if (Object.keys(changes).length) {
          await new Query(model, 'updateOne', { filter: { _id: obj._id }, update: { $set: changes }, opts: {} }).exec();
        }
        take();
        return obj;
      },
    },
  });
  return obj;
}

// ------------------------------------------------------------- update parse
function parseUpdate(model, update) {
  const u = { sets: [], incs: [], jsonb: [], embedded: {}, push: [], pull: [], positional: [], setOnInsert: {} };
  const ops = {};
  for (const [k, v] of Object.entries(update || {})) {
    if (k.startsWith('$')) Object.assign((ops[k] = ops[k] || {}), v);
    else (ops.$set = ops.$set || {})[k] = v;
  }
  for (const [k, v] of Object.entries(ops.$set || {})) {
    if (v === undefined) continue;
    const dot = k.indexOf('.');
    const head = dot > 0 ? k.slice(0, dot) : k;
    const rest = dot > 0 ? k.slice(dot + 1) : null;
    if (model.fields[k]) { u.sets.push({ f: model.fields[k], v }); continue; }
    if (model.embedded[head]) {
      const e = model.embedded[head];
      const slot = (u.embedded[head] = u.embedded[head] || { replace: false, vals: {} });
      if (!rest) {
        slot.replace = true;
        for (const [fn, fv] of Object.entries(v || {})) if (e.fields[fn]) slot.vals[fn] = fv;
      } else if (e.fields[rest]) slot.vals[rest] = v;
      else warnOnce(`${model.name}.${k}`, `${model.name}: "${k}" is not a column; write ignored.`);
      continue;
    }
    if (model.fields[head] && model.fields[head].t === 'jsonb' && rest) { u.jsonb.push({ f: model.fields[head], path: rest.split('.'), v }); continue; }
    if (model.children[head] && rest && rest.startsWith('$.')) {
      u.positional.push({ child: model.children[head], field: rest.slice(2), v });
      continue;
    }
    warnOnce(`${model.name}.${k}`, `${model.name}: "${k}" is not a column; write ignored.`);
  }
  for (const [k, v] of Object.entries(ops.$inc || {})) {
    if (model.fields[k]) u.incs.push({ f: model.fields[k], v });
    else warnOnce(`${model.name}.${k}`, `${model.name}: $inc "${k}" is not a column; ignored.`);
  }
  for (const [k, v] of Object.entries(ops.$push || {})) if (model.children[k]) u.push.push({ child: model.children[k], v });
  for (const [k, v] of Object.entries(ops.$pull || {})) if (model.children[k]) u.pull.push({ child: model.children[k], id: normalizeId(v && v._id) });
  u.setOnInsert = ops.$setOnInsert || {};
  for (const op of Object.keys(ops)) {
    if (!['$set', '$inc', '$push', '$pull', '$setOnInsert'].includes(op)) throw new Error(`Unsupported update operator ${op}`);
  }
  return u;
}

async function insertChild(client, child, parentId, doc) {
  const cols = [child.fk];
  const vals = [parentId];
  for (const [n, f] of Object.entries(child.fields)) {
    if (doc[n] === undefined) continue;
    cols.push(f.col);
    vals.push(coerceWrite(f, doc[n]));
  }
  const ph = vals.map((_, i) => `$${i + 1}`);
  await runQuery(client, `INSERT INTO "${child.table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph.join(',')})`, vals);
}

async function upsertEmbedded(client, model, parentId, name, slot) {
  const e = model.embedded[name];
  const all = Object.keys(e.fields);
  const given = Object.keys(slot.vals);
  if (!slot.replace && !given.length) return;
  const cols = [e.fk];
  const ph = ['$1'];
  const vals = [parentId];
  const listed = slot.replace ? all : given; // replace => every column, unspecified ones take DEFAULT
  for (const n of listed) {
    cols.push(e.fields[n].col);
    if (slot.vals[n] === undefined) ph.push('DEFAULT');
    else { vals.push(coerceWrite(e.fields[n], slot.vals[n])); ph.push(`$${vals.length}`); }
  }
  const setList = cols.slice(1).map((c) => `"${c}" = EXCLUDED."${c}"`);
  await runQuery(
    client,
    `INSERT INTO "${e.table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph.join(',')}) ` +
      (setList.length ? `ON CONFLICT ("${e.fk}") DO UPDATE SET ${setList.join(', ')}` : `ON CONFLICT ("${e.fk}") DO NOTHING`),
    vals,
  );
}

async function applyUpdate(client, model, id, u, ctx) {
  // 1) base columns (always runs so the updated_at trigger fires, like Mongoose timestamps)
  const params = [];
  const sets = [];
  const P = (f, v) => { params.push(coerceWrite(f, v)); return `$${params.length}::${PG_TYPE[f.t] || 'text'}`; };
  for (const { f, v } of u.sets) sets.push(`"${f.col}" = ${P(f, v)}`);
  for (const { f, v } of u.incs) sets.push(`"${f.col}" = COALESCE("${f.col}", 0) + ${P(f, v)}`);
  const jsonbByCol = {};
  for (const j of u.jsonb) (jsonbByCol[j.f.col] = jsonbByCol[j.f.col] || []).push(j);
  for (const [col, list] of Object.entries(jsonbByCol)) {
    let expr = `COALESCE("${col}", '{}'::jsonb)`;
    for (const j of list) {
      params.push(JSON.stringify(j.v === undefined ? null : j.v));
      params.push(j.path);
      expr = `jsonb_set(${expr}, $${params.length}::text[], $${params.length - 1}::jsonb, true)`;
    }
    sets.push(`"${col}" = ${expr}`);
  }
  if (!sets.length) sets.push(`"${model.idCol}" = "${model.idCol}"`);
  params.push(id);
  await runQuery(client, `UPDATE "${model.table}" SET ${sets.join(', ')} WHERE "${model.idCol}" = $${params.length}::${PG_TYPE[model.idType]}`, params);

  // 2) embedded 1:1 sub-documents
  for (const [name, slot] of Object.entries(u.embedded)) await upsertEmbedded(client, model, id, name, slot);

  // 3) child arrays
  for (const { child, v } of u.push) await insertChild(client, child, id, v);
  for (const { child, id: cid } of u.pull) {
    if (cid) await runQuery(client, `DELETE FROM "${child.table}" WHERE "${child.fk}" = $1::uuid AND "id" = $2::uuid`, [id, cid]);
  }
  if (u.positional.length) {
    const byChild = new Map();
    for (const p of u.positional) {
      const matched = ctx.childIds && ctx.childIds[p.child.name];
      if (!matched) throw new Error('Positional update ($) needs a matching "<child>._id" filter');
      if (!p.child.fields[p.field]) continue;
      if (!byChild.has(p.child)) byChild.set(p.child, { matched, sets: [] });
      byChild.get(p.child).sets.push(p);
    }
    for (const [child, { matched, sets: ps }] of byChild) {
      const prm = [];
      const cols = ps.map((p) => { prm.push(coerceWrite(p.child.fields[p.field], p.v)); return `"${p.child.fields[p.field].col}" = $${prm.length}`; });
      prm.push(id, matched);
      await runQuery(client, `UPDATE "${child.table}" SET ${cols.join(', ')} WHERE "${child.fk}" = $${prm.length - 1}::uuid AND "id" = $${prm.length}::uuid`, prm);
    }
  }
}

async function insertRow(client, model, doc) {
  const cols = [];
  const vals = [];
  const embeddeds = {};
  const kids = [];
  for (const [k, v] of Object.entries(doc || {})) {
    if (v === undefined || k === '__v') continue;
    if (k === '_id' || k === 'id') {
      const idv = model.idType === 'uuid' ? normalizeId(v) : String(v);
      if (idv) { cols.push(model.idCol); vals.push(idv); }
    } else if (model.fields[k]) {
      cols.push(model.fields[k].col);
      vals.push(coerceWrite(model.fields[k], v));
    } else if (model.embedded[k] && isPlain(v)) {
      embeddeds[k] = { replace: true, vals: Object.fromEntries(Object.entries(v).filter(([fn]) => model.embedded[k].fields[fn])) };
    } else if (model.children[k] && Array.isArray(v)) {
      kids.push([model.children[k], v]);
    } else {
      warnOnce(`${model.name}.${k}`, `${model.name}: "${k}" is not a column; write ignored.`);
    }
  }
  const ph = vals.map((_, i) => `$${i + 1}`);
  const sql = cols.length
    ? `INSERT INTO "${model.table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph.join(',')}) RETURNING "${model.idCol}"::text AS id`
    : `INSERT INTO "${model.table}" DEFAULT VALUES RETURNING "${model.idCol}"::text AS id`;
  const id = (await runQuery(client, sql, vals)).rows[0].id;
  for (const [name, slot] of Object.entries(embeddeds)) await upsertEmbedded(client, model, id, name, slot);
  for (const [child, list] of kids) for (const item of list) await insertChild(client, child, id, item);
  return id;
}

// ------------------------------------------------------------------- Query
class Query {
  constructor(model, kind, args) {
    this.model = model;
    this.kind = kind;
    this.args = args;
    this._select = null;
    this._sort = null;
    this._skip = 0;
    this._limit = null;
    this._lean = false;
  }

  select(s) { this._select = this._select ? `${this._select} ${s}` : s; return this; }
  sort(s) { this._sort = s; return this; }
  skip(n) { this._skip = Number(n) || 0; return this; }
  limit(n) { this._limit = n == null ? null : Number(n); return this; }
  lean(v = true) { this._lean = v !== false; return this; }
  then(ok, err) { return this.exec().then(ok, err); }
  catch(err) { return this.exec().catch(err); }
  finally(fn) { return this.exec().finally(fn); }

  // Streams rows in pages (used by the backup export). Usage: for await (const doc of q.lean().cursor())
  cursor() {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const page = 500;
        for (let off = 0; ; off += page) {
          const rows = await new Query(self.model, 'find', { filter: self.args.filter })
            .select(self._select || undefined).sort(self._sort || { _id: 1 }).skip(off).limit(page).lean(self._lean).exec();
          for (const r of rows) yield r;
          if (rows.length < page) return;
        }
      },
    };
  }

  async _find(client, filter, { one = false, forUpdate = false } = {}) {
    const { model } = this;
    const params = [];
    const ctx = {};
    const where = compileFilter(model, filter, params, ctx);
    const sel = parseSelect(model, this._select);
    const order = compileSort(model, this._sort);
    let sql = `SELECT ${selectSql(model, sel)} FROM "${model.table}" t${joinSql(model)} WHERE ${where} ORDER BY ${order.join(', ')}`;
    const limit = one ? 1 : this._limit;
    if (limit != null) sql += ` LIMIT ${Math.max(0, Math.trunc(limit))}`;
    if (this._skip) sql += ` OFFSET ${Math.max(0, Math.trunc(this._skip))}`;
    if (forUpdate) sql += ` FOR UPDATE OF t`;
    const res = await runQuery(client, sql, params);
    const kids = await loadChildren(model, sel, res.rows.map((r) => r._id), client);
    const objs = res.rows.map((r) => hydrateRow(model, r, sel, kids));
    return { objs: this._lean ? objs : objs.map((o) => makeDoc(model, o)), ctx };
  }

  async _fetchById(client, id) {
    const q = new Query(this.model, 'find', {});
    q._select = this._select; q._lean = this._lean;
    return (await q._find(client, { _id: id }, { one: true })).objs[0] || null;
  }

  async exec() {
    const { model, kind, args } = this;
    switch (kind) {
      case 'find': return (await this._find(null, args.filter)).objs;
      case 'findOne': {
        // findById with an unusable id must resolve to null, not throw
        return (await this._find(null, args.filter, { one: true })).objs[0] || null;
      }
      case 'count': {
        const params = [];
        const where = compileFilter(model, args.filter, params, {});
        const r = await runQuery(null, `SELECT count(*)::int AS n FROM "${model.table}" t${joinSql(model)} WHERE ${where}`, params);
        return r.rows[0].n;
      }
      case 'exists': {
        const params = [];
        const where = compileFilter(model, args.filter, params, {});
        const r = await runQuery(null, `SELECT t."${model.idCol}"::text AS "_id" FROM "${model.table}" t${joinSql(model)} WHERE ${where} LIMIT 1`, params);
        return r.rows[0] ? { _id: r.rows[0]._id } : null;
      }
      case 'distinct': {
        const params = [];
        const where = compileFilter(model, args.filter, params, {});
        const r = resolve(model, args.field);
        const res = await runQuery(null, `SELECT DISTINCT ${r.sql} AS v FROM "${model.table}" t${joinSql(model)} WHERE ${where} AND ${r.sql} IS NOT NULL`, params);
        return res.rows.map((x) => outValue(r.f, x.v));
      }
      case 'deleteOne':
      case 'deleteMany': {
        const params = [];
        const where = compileFilter(model, args.filter, params, {});
        const lim = kind === 'deleteOne' ? ' LIMIT 1' : '';
        const r = await runQuery(null,
          `DELETE FROM "${model.table}" WHERE "${model.idCol}" IN (SELECT t."${model.idCol}" FROM "${model.table}" t${joinSql(model)} WHERE ${where}${lim})`, params);
        return { acknowledged: true, deletedCount: r.rowCount };
      }
      case 'findOneAndDelete': {
        const row = (await this._find(null, args.filter, { one: true })).objs[0] || null;
        if (row) await runQuery(null, `DELETE FROM "${model.table}" WHERE "${model.idCol}" = $1::${PG_TYPE[model.idType]}`, [row._id]);
        return row;
      }
      case 'create': {
        if (Array.isArray(args.doc)) throw new Error('create([]) is not supported');
        return withTx(async (client) => {
          const id = await insertRow(client, model, args.doc);
          const q = new Query(model, 'find', {});
          return (await q._find(client, { _id: id }, { one: true })).objs[0];
        });
      }
      case 'insertMany': {
        // One transaction per row on purpose: now() is frozen per transaction, and "sort by _id" is
        // implemented as (created_at, id), so a single transaction would scramble insertion order.
        const out = [];
        for (const doc of args.docs || []) out.push(await new Query(model, 'create', { doc }).exec());
        return out;
      }
      case 'updateOne':
      case 'findOneAndUpdate': return this._update();
      default: throw new Error(`Unsupported operation ${kind}`);
    }
  }

  async _update() {
    const { model, kind } = this;
    const { filter, update, opts } = this.args;
    const u = parseUpdate(model, update);
    return withTx(async (client) => {
      // Lock the target row so concurrent writers serialise (what findOneAndUpdate guaranteed in Mongo).
      const params = [];
      const ctx = {};
      const where = compileFilter(model, filter, params, ctx);
      const found = await runQuery(client,
        `SELECT t."${model.idCol}"::text AS id FROM "${model.table}" t${joinSql(model)} WHERE ${where} ORDER BY t."${model.idCol}" LIMIT 1 FOR UPDATE OF t`, params);
      let id = found.rows[0] && found.rows[0].id;
      let upserted = false;

      if (!id && opts.upsert) {
        // Insert using equality fields from the filter, $setOnInsert and plain $set fields, then run the
        // full update (embedded, $inc, jsonb paths, ...). A concurrent insert is retried once as an update.
        const seed = {};
        for (const [k, v] of Object.entries(filter || {})) {
          if (!k.startsWith('$') && !isOpObject(v) && !(v instanceof RegExp) && v !== null && v !== undefined) seed[k] = v;
        }
        Object.assign(seed, u.setOnInsert);
        for (const { f, v } of u.sets) seed[f.name] = v;
        if (u.embedded.residentProfile) { /* applied by applyUpdate below */ }
        try {
          await runQuery(client, 'SAVEPOINT upsert_ins');
          id = await insertRow(client, model, seed);
          upserted = true;
        } catch (e) {
          await runQuery(client, 'ROLLBACK TO SAVEPOINT upsert_ins');
          if (e.code !== 11000) throw e;
          const again = await runQuery(client,
            `SELECT t."${model.idCol}"::text AS id FROM "${model.table}" t${joinSql(model)} WHERE ${compileFilter(model, filter, (params.length = 0, params), ctx)} LIMIT 1 FOR UPDATE OF t`, params);
          id = again.rows[0] && again.rows[0].id;
          if (!id) throw e;
        }
      }

      if (!id) return kind === 'updateOne' ? { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 } : null;

      const wantOld = kind === 'findOneAndUpdate' && !opts.new && opts.returnDocument !== 'after' && !upserted;
      const old = wantOld ? await this._fetchById(client, id) : null;
      await applyUpdate(client, model, id, u, ctx);
      if (kind === 'updateOne') return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: upserted ? 1 : 0 };
      if (opts.new || opts.returnDocument === 'after') return this._fetchById(client, id);
      return upserted ? null : old; // Mongoose returns the pre-update doc by default (null when it upserted)
    });
  }
}

module.exports = { defineModel, normalizeId, isValidId, withTx, runQuery, pool, camel, snake };