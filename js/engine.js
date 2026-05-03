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

export async function verifyMultiSpecialty() {
  // Sanity check: a 50/50 mix of two specialties should land between the
  // pure single-specialty valuations. Picks Family Medicine (low specMult)
  // and Cardiology (high specMult) to make the band wide and the assertion
  // unambiguous.
  const base = {
    city: 'Pensacola', state: 'FL', npi: null,
    revenue: 3200000, visits: 25000, sites: 2,
    realEstate: 'Lease', timeline: '1-2 years'
  };
  const fam = await computeValuation({ ...base, specialty: 'Family Medicine' });
  const card = await computeValuation({ ...base, specialty: 'Cardiology' });
  const mix = await computeValuation({
    ...base,
    specialty: 'Family Medicine',
    specialties: [
      { name: 'Family Medicine', visitPct: 50 },
      { name: 'Cardiology',      visitPct: 50 }
    ]
  });
  const lo = Math.min(fam.low, card.low);
  const hi = Math.max(fam.high, card.high);
  const inBand = mix.low >= lo && mix.high <= hi;
  // Mix point estimate should be roughly halfway between the two
  const expected = (fam.pointEstimate + card.pointEstimate) / 2;
  const drift = Math.abs(mix.pointEstimate - expected) / Math.max(expected, 1);
  const closeEnough = drift < 0.05; // <5% drift from naive midpoint
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  console.log('Multi-specialty check:');
  console.log('  Family Medicine:  ' + fmt.format(fam.low) + ' – ' + fmt.format(fam.high));
  console.log('  Cardiology:       ' + fmt.format(card.low) + ' – ' + fmt.format(card.high));
  console.log('  50/50 mix:        ' + fmt.format(mix.low) + ' – ' + fmt.format(mix.high));
  console.log('  Mix midpoint drift from naive avg: ' + (drift * 100).toFixed(2) + '%');
  const ok = inBand && closeEnough;
  console.log('Multi-specialty check: ' + (ok ? 'PASS' : 'FAIL'));
  return { pass: ok, fam, card, mix };
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
