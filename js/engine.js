// MDCopia valuation engine.
//
// Single export: computeValuation(inputs) -> Promise<ValuationResult>.
// Four stages per CLAUDE.md:
//   1. Input normalization
//   2. Public data enrichment (NPPES + CMS Medicare, both with fallbacks)
//   3. Multiplier computation (deterministic, continuous)
//   4. Range assembly (±15% spread, $5K rounding)
// Plus an internal calibration check vs TRANSACTION_MULTIPLES (ENGINE.md §5).
//
// Determinism: no Math.random / no Date.now in any multiplier path. The only
// time-derived value is enumerationDate → practiceAge (monotonic, stable).
//
// Network: every fetch is wrapped with AbortController (5s) and try/catch.
// If both APIs fail, the engine still produces a valid range using static
// tables. Never throws on network error.

import { tables } from './tables.js';
import { interpolate } from './interpolate.js';
import { APPS_SCRIPT_URL } from './api.js';

const NPPES_URL = 'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=';
const CMS_URL = 'https://data.cms.gov/data-api/v1/dataset/' +
  '92396110-2aed-4d63-a6a2-5d6207d46a29/data?filter[Rndrng_NPI]=';
const FETCH_TIMEOUT_MS = 8000;
const SESSION_PREFIX = 'mdcopia_api_';

// NPPES doesn't send CORS headers, so browser fetch is blocked. When
// APPS_SCRIPT_URL is configured we route through the Apps Script proxy
// (stateless, host-whitelisted to NPPES + CMS only — see Code.gs).
// In Node (smoke tests) and any environment with a permissive fetch we
// still go direct, since the proxy is only needed to escape CORS.
const HAS_PROXY = !!APPS_SCRIPT_URL;
const IS_BROWSER = typeof window !== 'undefined';
function shouldProxy() { return HAS_PROXY && IS_BROWSER; }
function proxiedUrl(target) {
  return APPS_SCRIPT_URL +
    (APPS_SCRIPT_URL.indexOf('?') >= 0 ? '&' : '?') +
    'action=api_proxy&url=' + encodeURIComponent(target);
}

const fmtUSD = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

// ---------- Public API ----------

export async function computeValuation(rawInputs) {
  // STAGE 1: normalize
  const inputs = normalizeInputs(rawInputs);

  // STAGE 2: enrich (parallel API calls, both swallow errors)
  const [npi, cms] = await Promise.all([
    inputs.npi ? lookupNppes(inputs.npi) : Promise.resolve(null),
    inputs.npi ? lookupCmsUtilization(inputs.npi) : Promise.resolve(null)
  ]);

  const dataSources = ['MDCopia static benchmark tables'];
  if (npi)  dataSources.push('NPPES NPI Registry');
  if (cms)  dataSources.push('CMS Medicare Physician & Other Practitioners');

  // Derived enrichment
  const practiceAge = npi?.enumerationYear
    ? new Date().getUTCFullYear() - npi.enumerationYear
    : 10;
  const providerCount = Math.max(npi?.providerCount ?? 1, 1);

  // Discrepancies (informational only)
  const npiDiscrepancies = [];
  if (npi?.taxonomy && npi.specialty && inputs.specialty &&
      !specialtyMatches(npi.specialty, inputs.specialty)) {
    npiDiscrepancies.push(
      `NPPES specialty "${npi.specialty}" differs from selected "${inputs.specialty}". Using your selection.`
    );
  }
  if (npi?.state && inputs.state && npi.state !== inputs.state) {
    npiDiscrepancies.push(
      `NPPES state "${npi.state}" differs from selected "${inputs.state}". Using your selection.`
    );
  }

  // Collections + payer mix
  let collections = inputs.revenue * 0.95;
  let payer = await tables.get('SPECIALTY_PAYER_DEFAULTS', inputs.specialty);
  let payerMixDescription = 'National specialty defaults';

  if (cms && cms.medicareAllowedAmount > 0 && inputs.revenue > 0) {
    const medicareShare = clamp((cms.medicareAllowedAmount / inputs.revenue) * 100, 0, 100);
    const remainder = 100 - medicareShare;
    const baseline = payer;
    const baselineNonMedicare = baseline.medicaid + baseline.commercial + baseline.selfPay;
    if (baselineNonMedicare > 0) {
      payer = {
        medicare:   medicareShare,
        medicaid:   remainder * (baseline.medicaid   / baselineNonMedicare),
        commercial: remainder * (baseline.commercial / baselineNonMedicare),
        selfPay:    remainder * (baseline.selfPay    / baselineNonMedicare)
      };
      payerMixDescription = 'Derived from CMS Medicare allowed-amount data';
    }
    if (cms.collectionRate > 0 && cms.collectionRate < 1.5) {
      collections = inputs.revenue * cms.collectionRate;
    }
  }

  // STAGE 3: multipliers
  const [
    specMult, realEstateMult, timelineMult, marketMult, anchors
  ] = await Promise.all([
    tables.get('SPECIALTY_MULTIPLIER', inputs.specialty),
    tables.get('REAL_ESTATE_FACTOR', inputs.realEstate),
    tables.get('TIMELINE_FACTOR', inputs.timeline),
    tables.get('STATE_MARKET_FACTOR', inputs.state),
    tables.raw('BASE_MULTIPLIER_ANCHORS')
  ]);

  const baseMult = interpolate(anchors, collections);
  const payerAdj = payerMixAdjustment(payer);
  const scaleAdj = scaleFactor(providerCount, inputs.sites);

  const pointEstimate = collections
    * baseMult
    * specMult
    * payerAdj
    * scaleAdj
    * realEstateMult
    * timelineMult
    * marketMult;

  // STAGE 4: range assembly
  const spread = 0.15;
  const low  = roundTo(pointEstimate * (1 - spread), 5000);
  const high = roundTo(pointEstimate * (1 + spread), 5000);

  // STAGE 5: calibration check (internal)
  const txnBand = await tables.get('TRANSACTION_MULTIPLES', inputs.specialty);
  const impliedMultiple = inputs.revenue > 0 ? pointEstimate / inputs.revenue : 0;
  const calibrationFlag = !!(txnBand && (
    impliedMultiple < txnBand.revLow * 0.85 ||
    impliedMultiple > txnBand.revHigh * 1.15
  ));

  const methodology =
    `Valued using ${fmtUSD.format(collections)} in estimated annual collections ` +
    `for a ${inputs.specialty} practice in ${inputs.city || 'your city'}, ${inputs.state}. ` +
    `Multipliers reflect specialty benchmarks, payer composition, practice scale, ` +
    `and local market conditions.`;

  return {
    low: round2(low),
    high: round2(high),
    pointEstimate: round2(pointEstimate),
    methodology,
    factors: {
      baseMultiple:        `${baseMult.toFixed(2)}x collections`,
      specialtyAdjustment: `${pct(specMult - 1)} (${inputs.specialty})`,
      payerMixEffect:      `${payerMixDescription} (${pct(payerAdj - 1)})`,
      scaleEffect:         `${providerCount} provider${providerCount > 1 ? 's' : ''}, ${inputs.sites} site${inputs.sites > 1 ? 's' : ''} (${pct(scaleAdj - 1)})`,
      marketFactor:        `${marketMult.toFixed(2)}x (${inputs.state})`,
      realEstate:          `${inputs.realEstate} (${pct(realEstateMult - 1)})`,
      timeline:            `${inputs.timeline} (${pct(timelineMult - 1)})`
    },
    dataSources,
    enrichment: {
      npiValidated:          !!npi,
      cmsDataUsed:           !!cms,
      npiDiscrepancies,
      practiceAge,
      providerCount,
      medicareAllowedAmount: cms?.medicareAllowedAmount ?? null,
      calibrationFlag,
      impliedRevenueMultiple: round4(impliedMultiple)
    }
  };
}

// ---------- Stage 1: Input Normalization ----------

function normalizeInputs(raw) {
  return {
    practiceName: String(raw.practiceName ?? '').trim(),
    specialty:    String(raw.specialty ?? raw.practiceType ?? 'Other').trim(),
    city:         String(raw.city ?? '').trim(),
    state:        String(raw.state ?? '').trim().toUpperCase(),
    npi:          normalizeNpi(raw.npi),
    revenue:      parseRevenue(raw.revenue),
    visits:       parseVisits(raw.visits),
    sites:        Math.max(parseInt(String(raw.sites ?? '1').replace(/[^0-9]/g, ''), 10) || 1, 1),
    realEstate:   String(raw.realEstate ?? 'Lease').trim(),
    timeline:     String(raw.timeline ?? '1-2 years').trim()
  };
}

function parseRevenue(raw) {
  if (typeof raw === 'number' && isFinite(raw)) return Math.max(raw, 0);
  return Math.max(parseFloat(String(raw ?? '').replace(/[$,\s]/g, '')) || 0, 0);
}

function parseVisits(raw) {
  if (typeof raw === 'number' && isFinite(raw)) return Math.max(Math.round(raw), 0);
  return Math.max(parseInt(String(raw ?? '').replace(/[,\s]/g, ''), 10) || 0, 0);
}

function normalizeNpi(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

// ---------- Stage 2: Enrichment ----------

async function lookupNppes(npi) {
  const cacheKey = SESSION_PREFIX + 'nppes_' + npi;
  const cached = readCache(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const data = await fetchJson(NPPES_URL + npi);
    const r = data?.results?.[0];
    if (!r) { writeCache(cacheKey, null); return null; }

    const taxonomy = (r.taxonomies || []).find(t => t.primary) || r.taxonomies?.[0];
    const addr = (r.addresses || []).find(a => a.address_purpose === 'LOCATION') || r.addresses?.[0];
    const enrolledYear = r.basic?.enumeration_date
      ? new Date(r.basic.enumeration_date).getUTCFullYear()
      : null;

    const out = {
      entityType:      r.enumeration_type === 'NPI-2' ? 2 : 1,
      organizationName: r.basic?.organization_name || null,
      providerName:    r.basic?.first_name
        ? `${r.basic.first_name} ${r.basic.last_name}`
        : r.basic?.organization_name || null,
      taxonomy:        taxonomy?.code || null,
      specialty:       taxonomy?.desc || null,
      city:            addr?.city || null,
      state:           addr?.state || null,
      enumerationYear: enrolledYear,
      providerCount:   r.enumeration_type === 'NPI-2' ? 2 : 1
    };
    writeCache(cacheKey, out);
    return out;
  } catch (_) {
    writeCache(cacheKey, null);
    return null;
  }
}

async function lookupCmsUtilization(npi) {
  const cacheKey = SESSION_PREFIX + 'cms_' + npi;
  const cached = readCache(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const arr = await fetchJson(CMS_URL + npi);
    if (!Array.isArray(arr) || arr.length === 0) {
      writeCache(cacheKey, null);
      return null;
    }
    // Use the most recent year's row.
    const row = arr.reduce((a, b) =>
      Number(a.Rndrng_Prvdr_Last_Org_Name ? a.Year : 0) >= Number(b.Year ?? 0) ? a : b
    );
    const allowed = Number(row.Tot_Mdcr_Alowd_Amt) || 0;
    const paid = Number(row.Tot_Mdcr_Pymt_Amt) || 0;
    const out = {
      year:                  Number(row.Year) || null,
      totalServices:         Number(row.Tot_Srvcs) || 0,
      totalBeneficiaries:    Number(row.Tot_Benes) || 0,
      medicareAllowedAmount: allowed,
      medicarePaymentAmount: paid,
      collectionRate:        allowed > 0 ? paid / allowed : 0
    };
    writeCache(cacheKey, out);
    return out;
  } catch (_) {
    writeCache(cacheKey, null);
    return null;
  }
}

// Single helper that:
//   * In a browser with APPS_SCRIPT_URL set: routes through the proxy
//     (`{success, status, data}` envelope) and unwraps the inner JSON.
//   * Anywhere else: direct fetch + JSON.
// 8s timeout via AbortController. Throws on failure so callers can fall back.
async function fetchJson(targetUrl) {
  const url = shouldProxy() ? proxiedUrl(targetUrl) : targetUrl;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ctl.signal, method: 'GET' });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('http ' + res.status);
  const body = await res.json();
  if (shouldProxy()) {
    if (!body || body.success === false) throw new Error(body && body.error || 'proxy error');
    return body.data;
  }
  return body;
}

function readCache(key) {
  if (typeof sessionStorage === 'undefined') return undefined;
  const v = sessionStorage.getItem(key);
  if (v === null) return undefined;
  try { return JSON.parse(v); } catch (_) { return undefined; }
}

function writeCache(key, value) {
  if (typeof sessionStorage === 'undefined') return;
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

// ---------- Stage 3: Multiplier helpers ----------

function payerMixAdjustment({ medicare, medicaid, commercial, selfPay }) {
  const m = medicare ?? 35;
  const d = medicaid ?? 10;
  const c = commercial ?? 45;
  const s = selfPay ?? 10;
  const total = m + d + c + s || 1;
  const mN = (m / total) * 100;
  const dN = (d / total) * 100;
  const cN = (c / total) * 100;
  const sN = (s / total) * 100;
  return 1.0
    + (cN - 45) * 0.003
    + (dN - 10) * -0.004
    + (mN - 35) * -0.001
    + (sN - 10) * -0.002;
}

function scaleFactor(providers, sites) {
  const providerFactor = 1.0 + Math.log2(Math.max(providers, 1)) * 0.05;
  const siteFactor = 1.0 + Math.min((sites - 1) * 0.02, 0.10);
  return Math.min(providerFactor * siteFactor, 1.35);
}

// ---------- Misc ----------

function roundTo(n, step) { return Math.round(n / step) * step; }
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }
function pct(x) {
  const v = Math.round(x * 100);
  return (v >= 0 ? '+' : '') + v + '%';
}

function specialtyMatches(taxonomyDesc, selected) {
  const a = String(taxonomyDesc).toLowerCase();
  const b = String(selected).toLowerCase();
  if (a.includes(b) || b.includes(a)) return true;
  const tokens = b.split(/[\s/]+/).filter(Boolean);
  return tokens.some(t => t.length >= 4 && a.includes(t));
}

// ---------- Verification helpers (used by engine.test.html) ----------

export async function verifyDeterminism() {
  const test = {
    specialty: 'Family Medicine',
    city: 'Pensacola',
    state: 'FL',
    npi: null,
    revenue: 3200000,
    visits: 25000,
    sites: 2,
    realEstate: 'Lease',
    timeline: '1-2 years'
  };
  const results = [];
  for (let i = 0; i < 10; i++) results.push(await computeValuation(test));
  const ok = results.every(r =>
    r.low === results[0].low && r.high === results[0].high
  );
  console.log('Determinism check: ' + (ok ? 'PASS' : 'FAIL'));
  console.log('Range: ' + fmtUSD.format(results[0].low) + ' – ' + fmtUSD.format(results[0].high));
  return { pass: ok, sample: results[0] };
}

export async function verifyContinuity() {
  const base = {
    specialty: 'Family Medicine', city: 'Pensacola', state: 'FL', npi: null,
    visits: 25000, sites: 2, realEstate: 'Lease', timeline: '1-2 years'
  };
  const revenues = [250000, 500000, 1000000, 2000000, 3500000, 5000000, 7500000, 10000000, 25000000];
  const rows = [];
  console.log('Revenue continuity test:');
  let prev = null;
  let ok = true;
  for (const rev of revenues) {
    const r = await computeValuation({ ...base, revenue: rev });
    rows.push({ revenue: rev, low: r.low, high: r.high });
    console.log('  ' + fmtUSD.format(rev).padEnd(16) + ' → ' +
      fmtUSD.format(r.low) + ' – ' + fmtUSD.format(r.high));
    if (prev !== null) {
      if (r.low < prev.low) ok = false;
      const jump = (r.low - prev.low) / Math.max(prev.low, 1);
      if (jump > 4) ok = false;
    }
    prev = r;
  }
  console.log('Continuity check: ' + (ok ? 'PASS' : 'FAIL'));
  return { pass: ok, rows };
}
