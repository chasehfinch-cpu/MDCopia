// Table accessor seam — the migration boundary between hardcoded JS tables
// and a future Google Sheet / Excel-backed source.
//
// MVP: REMOTE_CSV_BASE = null → tables resolved from STATIC_TABLES.
// Post-migration: set REMOTE_CSV_BASE to a Sheet "Publish to web" CSV URL
// and TABLE_GIDS to the per-tab gids; tables.js will fetch + cache per session.
//
// Engine code only ever calls `await tables.get(name, key)` or
// `await tables.raw(name)`. No file outside this module imports STATIC_TABLES.

import { STATIC_TABLES } from './tables-static.js';

const REMOTE_CSV_BASE = null; // e.g. 'https://docs.google.com/spreadsheets/d/<ID>/export?format=csv'
const TABLE_GIDS = {
  // SPECIALTY_MULTIPLIER: 0,
  // STATE_MARKET_FACTOR:  123456789,
  // ...
};

const SESSION_PREFIX = 'mdcopia_table_';

export const tables = {
  async get(tableName, key) {
    const t = await loadTable(tableName);
    if (!t) return undefined;
    if (key === undefined) return t._default;
    return t[key] ?? t._default;
  },

  async raw(tableName) {
    return loadTable(tableName);
  }
};

async function loadTable(name) {
  if (!REMOTE_CSV_BASE || !TABLE_GIDS[name]) {
    return STATIC_TABLES[name];
  }

  // Session cache to avoid refetching during one valuation session.
  if (typeof sessionStorage !== 'undefined') {
    const cached = sessionStorage.getItem(SESSION_PREFIX + name);
    if (cached) {
      try { return JSON.parse(cached); } catch (_) { /* fall through */ }
    }
  }

  try {
    const url = `${REMOTE_CSV_BASE}&gid=${TABLE_GIDS[name]}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    const parsed = parseCsvTable(name, csv);

    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(SESSION_PREFIX + name, JSON.stringify(parsed));
    }
    return parsed;
  } catch (_) {
    // Remote failed — fall back to static so the engine never breaks.
    return STATIC_TABLES[name];
  }
}

// Minimal CSV → table-shape parser. Supports the three layouts described in
// tables-static.js. The header row in the Sheet determines the shape:
//   ["key","value"]                    → 1-D
//   ["row","col","value"]              → 2-D
//   ["specialty","medicare","medicaid","commercial","selfPay"] → object
//   ["x","y"]  + tableName ends in _ANCHORS → array of [x,y] pairs
function parseCsvTable(name, csv) {
  const rows = csv.trim().split(/\r?\n/).map(r => splitCsvRow(r));
  if (rows.length < 2) return STATIC_TABLES[name];
  const header = rows[0].map(h => h.trim());
  const body = rows.slice(1);

  if (name.endsWith('_ANCHORS')) {
    return body.map(r => [Number(r[0]), Number(r[1])]).filter(p => Number.isFinite(p[0]));
  }

  if (header.length === 2) {
    const t = {};
    for (const r of body) {
      if (r[0] === undefined || r[0] === '') continue;
      const v = Number(r[1]);
      t[r[0]] = Number.isFinite(v) ? v : r[1];
    }
    if (t._default === undefined) t._default = STATIC_TABLES[name]?._default;
    return t;
  }

  if (header.length === 3 && header[2].toLowerCase() === 'value') {
    const t = {};
    for (const r of body) {
      const [row, col, val] = r;
      if (!row) continue;
      if (!t[row]) t[row] = {};
      const n = Number(val);
      t[row][col] = Number.isFinite(n) ? n : val;
    }
    return t;
  }

  // Multi-column object table (e.g., payer mix).
  const t = {};
  for (const r of body) {
    const [k, ...rest] = r;
    if (!k) continue;
    const obj = {};
    for (let i = 1; i < header.length; i++) {
      const v = Number(rest[i - 1]);
      obj[header[i]] = Number.isFinite(v) ? v : rest[i - 1];
    }
    t[k] = obj;
  }
  return t;
}

function splitCsvRow(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}
