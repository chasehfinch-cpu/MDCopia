// MDCopia engine — thin client.
//
// The valuation logic, multiplier curves, lookup tables, and NPPES/CMS
// enrichment all run server-side in apps-script/Code.gs (action=compute_valuation).
// This file just collects inputs, posts them, and returns the result.
//
// Why server-side: the multipliers ARE the IP. Browser-side code is
// unavoidably visible to anyone who views the page source. Moving the
// engine into Apps Script keeps the formulas private while still serving
// a static site at zero hosting cost.

import { postAction, APPS_SCRIPT_URL } from './api.js';

export async function computeValuation(inputs) {
  if (!APPS_SCRIPT_URL) {
    throw new Error('APPS_SCRIPT_URL not configured in js/api.js — engine cannot run.');
  }
  const res = await postAction('compute_valuation', inputs);
  if (!res || !res.result) {
    throw new Error('Backend returned no valuation result.');
  }
  return res.result;
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
  for (let i = 0; i < 5; i++) results.push(await computeValuation(test));
  const ok = results.every(r =>
    r.low === results[0].low && r.high === results[0].high
  );
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  console.log('Determinism check: ' + (ok ? 'PASS' : 'FAIL'));
  console.log('Range: ' + fmt.format(results[0].low) + ' – ' + fmt.format(results[0].high));
  return { pass: ok, sample: results[0] };
}

export async function verifyContinuity() {
  const base = {
    specialty: 'Family Medicine', city: 'Pensacola', state: 'FL', npi: null,
    visits: 25000, sites: 2, realEstate: 'Lease', timeline: '1-2 years'
  };
  const revenues = [250000, 500000, 1000000, 2000000, 3500000, 5000000, 7500000, 10000000, 25000000];
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows = [];
  console.log('Revenue continuity test:');
  let prev = null;
  let ok = true;
  for (const rev of revenues) {
    const r = await computeValuation({ ...base, revenue: rev });
    rows.push({ revenue: rev, low: r.low, high: r.high });
    console.log('  ' + fmt.format(rev).padEnd(16) + ' → ' + fmt.format(r.low) + ' – ' + fmt.format(r.high));
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
