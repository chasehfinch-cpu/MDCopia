// MDCopia static lookup tables — embedded at build time.
//
// Every value here is intended to be moved to a Google Sheet eventually
// (see js/tables.js for the migration seam). The shapes below mirror flat
// spreadsheet layouts so a copy-paste round-trip works:
//   1-D:  { key: number }
//   2-D:  { rowKey: { colKey: number, _default: number } }
//   Anchors: [[x, y], ...]
//
// All 18 specialties + 51 jurisdictions (50 states + DC) are populated for
// completeness on first commit. Founders refine values in-place or migrate to
// the Sheet without touching engine code.

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
  'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
  'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY'
];

const SPECIALTIES = [
  'Primary Care','Internal Medicine','Family Medicine','Pediatrics','OB/GYN',
  'Cardiology','Orthopedics','Dermatology','Ophthalmology','Gastroenterology',
  'Urology','Neurology','Psychiatry','Radiology','Anesthesiology',
  'Emergency Medicine','General Surgery','Other'
];

// State-level market adjustment (1.0 = national baseline).
// Coastal/metro-heavy states above 1.0; rural states below; Sun Belt ~1.0–1.10.
const STATE_MARKET_FACTOR = {
  AL: 0.92, AK: 1.10, AZ: 1.05, AR: 0.90, CA: 1.25, CO: 1.10, CT: 1.15,
  DE: 1.05, DC: 1.22, FL: 1.05, GA: 1.00, HI: 1.20, ID: 0.95, IL: 1.10,
  IN: 0.95, IA: 0.92, KS: 0.93, KY: 0.92, LA: 0.95, ME: 1.00, MD: 1.12,
  MA: 1.18, MI: 0.98, MN: 1.05, MS: 0.88, MO: 0.95, MT: 0.95, NE: 0.94,
  NV: 1.05, NH: 1.05, NJ: 1.15, NM: 0.95, NY: 1.20, NC: 1.00, ND: 0.95,
  OH: 0.95, OK: 0.92, OR: 1.08, PA: 1.05, RI: 1.08, SC: 0.97, SD: 0.93,
  TN: 0.98, TX: 1.08, UT: 1.02, VT: 1.00, VA: 1.05, WA: 1.15, WV: 0.88,
  WI: 0.97, WY: 0.95,
  _default: 1.00
};

// National median annual physician compensation by specialty (BLS OEWS, May 2024).
const SPECIALTY_NATIONAL_COMP = {
  'Primary Care':         255000,
  'Internal Medicine':    265000,
  'Family Medicine':      250000,
  'Pediatrics':           220000,
  'OB/GYN':               320000,
  'Cardiology':           440000,
  'Orthopedics':          550000,
  'Dermatology':          400000,
  'Ophthalmology':        380000,
  'Gastroenterology':     450000,
  'Urology':              430000,
  'Neurology':            310000,
  'Psychiatry':           275000,
  'Radiology':            450000,
  'Anesthesiology':       430000,
  'Emergency Medicine':   350000,
  'General Surgery':      410000,
  'Other':                300000,
  _default:               280000
};

// BLS_COMPENSATION = specialty -> state -> median compensation.
// Built programmatically from the national figure × state market factor.
// Founders can override any cell post-migration in the Sheet.
const BLS_COMPENSATION = (() => {
  const t = {};
  for (const sp of SPECIALTIES) {
    const nat = SPECIALTY_NATIONAL_COMP[sp] ?? SPECIALTY_NATIONAL_COMP._default;
    t[sp] = { _default: nat };
    for (const st of STATES) {
      const mf = STATE_MARKET_FACTOR[st] ?? 1.0;
      // Compensation tracks cost of living more tightly than full market factor.
      // Compress the spread: f' = 1 + (f - 1) * 0.7
      const compFactor = 1 + (mf - 1) * 0.7;
      t[sp][st] = Math.round((nat * compFactor) / 1000) * 1000;
    }
  }
  t._default = { _default: SPECIALTY_NATIONAL_COMP._default };
  return t;
})();

// Specialty multiplier (Stage 3b in CLAUDE.md).
const SPECIALTY_MULTIPLIER = {
  'Primary Care':         0.85,
  'Internal Medicine':    0.88,
  'Family Medicine':      0.85,
  'Pediatrics':           0.82,
  'OB/GYN':               0.90,
  'Cardiology':           1.10,
  'Orthopedics':          1.15,
  'Dermatology':          1.20,
  'Ophthalmology':        1.18,
  'Gastroenterology':     1.12,
  'Urology':              1.08,
  'Neurology':            0.95,
  'Psychiatry':           0.90,
  'Radiology':            1.05,
  'Anesthesiology':       0.88,
  'Emergency Medicine':   0.92,
  'General Surgery':      1.00,
  'Other':                1.00,
  _default:               1.00
};

// Default payer mix by specialty (national averages, MGMA / AMA summaries).
const SPECIALTY_PAYER_DEFAULTS = {
  'Primary Care':         { medicare: 35, medicaid: 12, commercial: 43, selfPay: 10 },
  'Internal Medicine':    { medicare: 40, medicaid: 10, commercial: 40, selfPay: 10 },
  'Family Medicine':      { medicare: 32, medicaid: 14, commercial: 44, selfPay: 10 },
  'Pediatrics':           { medicare: 5,  medicaid: 35, commercial: 50, selfPay: 10 },
  'OB/GYN':               { medicare: 10, medicaid: 25, commercial: 55, selfPay: 10 },
  'Cardiology':           { medicare: 50, medicaid: 5,  commercial: 38, selfPay: 7  },
  'Orthopedics':          { medicare: 35, medicaid: 5,  commercial: 50, selfPay: 10 },
  'Dermatology':          { medicare: 30, medicaid: 5,  commercial: 50, selfPay: 15 },
  'Ophthalmology':        { medicare: 50, medicaid: 5,  commercial: 35, selfPay: 10 },
  'Gastroenterology':     { medicare: 40, medicaid: 5,  commercial: 45, selfPay: 10 },
  'Urology':              { medicare: 45, medicaid: 5,  commercial: 40, selfPay: 10 },
  'Neurology':            { medicare: 40, medicaid: 10, commercial: 42, selfPay: 8  },
  'Psychiatry':           { medicare: 20, medicaid: 20, commercial: 45, selfPay: 15 },
  'Radiology':            { medicare: 40, medicaid: 8,  commercial: 47, selfPay: 5  },
  'Anesthesiology':       { medicare: 35, medicaid: 10, commercial: 50, selfPay: 5  },
  'Emergency Medicine':   { medicare: 35, medicaid: 20, commercial: 30, selfPay: 15 },
  'General Surgery':      { medicare: 38, medicaid: 10, commercial: 45, selfPay: 7  },
  'Other':                { medicare: 35, medicaid: 10, commercial: 45, selfPay: 10 },
  _default:               { medicare: 35, medicaid: 10, commercial: 45, selfPay: 10 }
};

// Base multiplier curve (Stage 3a). Continuous via interpolate().
const BASE_MULTIPLIER_ANCHORS = [
  [250000,    0.40],
  [500000,    0.50],
  [1000000,   0.60],
  [2000000,   0.70],
  [5000000,   0.80],
  [10000000,  0.90],
  [25000000,  1.00],
  [50000000,  1.05]
];

// Real estate (Stage 3e).
const REAL_ESTATE_FACTOR = {
  'Own (included in sale)': 1.15,
  'Own (not included)':     1.00,
  'Lease':                  0.97,
  _default:                 1.00
};

// Timeline (Stage 3f).
const TIMELINE_FACTOR = {
  'Exploring options (no timeline)': 1.02,
  'Within 6 months':                 0.95,
  '6-12 months':                     0.98,
  '1-2 years':                       1.00,
  '2+ years':                        1.02,
  _default:                          1.00
};

// Transaction multiple bands (ENGINE.md §2E) — used for internal calibration check.
const TRANSACTION_MULTIPLES = {
  'Primary Care':       { revLow: 0.5, revHigh: 1.0 },
  'Internal Medicine':  { revLow: 0.5, revHigh: 0.9 },
  'Family Medicine':    { revLow: 0.5, revHigh: 0.9 },
  'Pediatrics':         { revLow: 0.4, revHigh: 0.8 },
  'OB/GYN':             { revLow: 0.5, revHigh: 1.0 },
  'Cardiology':         { revLow: 0.8, revHigh: 1.5 },
  'Orthopedics':        { revLow: 0.7, revHigh: 1.3 },
  'Dermatology':        { revLow: 0.7, revHigh: 1.2 },
  'Ophthalmology':      { revLow: 0.8, revHigh: 1.5 },
  'Gastroenterology':   { revLow: 0.8, revHigh: 1.4 },
  'Urology':            { revLow: 0.7, revHigh: 1.2 },
  'Neurology':          { revLow: 0.6, revHigh: 1.0 },
  'Psychiatry':         { revLow: 0.6, revHigh: 1.1 },
  'Radiology':          { revLow: 0.6, revHigh: 1.0 },
  'Anesthesiology':     { revLow: 0.5, revHigh: 0.9 },
  'Emergency Medicine': { revLow: 0.5, revHigh: 0.9 },
  'General Surgery':    { revLow: 0.6, revHigh: 1.1 },
  'Other':              { revLow: 0.5, revHigh: 1.1 },
  _default:             { revLow: 0.5, revHigh: 1.1 }
};

export const STATIC_TABLES = {
  STATE_MARKET_FACTOR,
  BLS_COMPENSATION,
  SPECIALTY_MULTIPLIER,
  SPECIALTY_PAYER_DEFAULTS,
  BASE_MULTIPLIER_ANCHORS,
  REAL_ESTATE_FACTOR,
  TIMELINE_FACTOR,
  TRANSACTION_MULTIPLES
};

export const META = { STATES, SPECIALTIES };
