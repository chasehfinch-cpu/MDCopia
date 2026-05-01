/**
 * MDCopia — Google Apps Script backend
 *
 * Five doPost routes consumed by the static site (js/api.js):
 *   action=seller_submit       Append seller lead row, send confirmation + partner notification
 *   action=send_verification   Generate 6-digit code, store + email
 *   action=verify_code         Validate code, mark Email Verified
 *   action=seller_consent      Mark Consent Given + Consent Date
 *   action=engine_error        Email both partners with error + form context
 *
 * Plus admin functions (run from the Apps Script editor):
 *   setupSheets()       — one-shot: create the four required tabs with headers
 *   sendBuyerEmail(row) — read a draft row from "Buyer Email Drafts" and send it via Resend
 *
 * Secrets live in PropertiesService.getScriptProperties():
 *   RESEND_API_KEY, PARTNER_EMAIL_1, PARTNER_EMAIL_2, SELLER_FROM_EMAIL, SHEET_ID (optional)
 */

// ---------- Constants ----------

var TAB = {
  SELLER:   'Seller Leads',
  BUYER:    'Buyer Inquiries',
  TXN:      'Transactions',
  DRAFTS:   'Buyer Email Drafts'
};

var HEADERS = {
  'Seller Leads': [
    'Timestamp','Lead ID','Practice Name','Practice Specialty','City','State',
    'NPI','NPI Type','Annual Revenue','Annual Visits','Sites','Real Estate',
    'Timeline','Email','Status','Verification Code','Code Expiry','Code Attempts',
    'Email Verified','Consent Given','Consent Date',
    'Valuation Range Low','Valuation Range High','Valuation Point',
    'Methodology','Enrichment Data','Factors','Data Sources',
    'Valuation Delivered Date','Buyer Matched','Lead Sold Date'
  ],
  'Buyer Inquiries': [
    'Timestamp','Organization','Contact Name','Email','Phone','Org Type',
    'Specialties','Geography','Revenue Range','Message','Status',
    'Vetted','Vetted Date','Agreement Signed'
  ],
  'Transactions': [
    'Lead ID','Buyer ID','Date Matched','Valuation Range Low','Valuation Range High',
    'Negotiation Started','12-Month Follow-Up Date','Outcome','Close Price','Notes'
  ],
  'Buyer Email Drafts': [
    'Buyer Email','Buyer Name','Buyer Org','Seller Practice Name','Seller State',
    'Seller City','Seller Specialty','Valuation Low','Valuation High',
    'Email Subject','Email Body','Sent','Sent Date'
  ]
};

// ---------- Web app entrypoints ----------

function doPost(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || '';
    var payload = {};
    if (e && e.parameter && e.parameter.payload) {
      payload = JSON.parse(e.parameter.payload);
    } else if (e && e.postData && e.postData.contents) {
      try { payload = JSON.parse(e.postData.contents); } catch (_) {}
    }

    var routes = {
      seller_submit:     handleSellerSubmit,
      send_verification: handleSendVerification,
      verify_code:       handleVerifyCode,
      seller_consent:    handleSellerConsent,
      engine_error:      handleEngineError,
      api_proxy:         handleApiProxy,
      compute_valuation: handleComputeValuation
    };
    var fn = routes[action];
    if (!fn) return jsonResponse({ success: false, error: 'Unknown action: ' + action });
    return jsonResponse(fn(payload));
  } catch (err) {
    return jsonResponse({ success: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  // doGet is also used by the engine's api_proxy route so that NPPES/CMS
  // lookups can be made via a "simple" GET (no preflight, no extra latency).
  if (e && e.parameter && e.parameter.action === 'api_proxy') {
    return jsonResponse(handleApiProxy({ url: e.parameter.url || '' }));
  }
  return jsonResponse({ success: true, service: 'MDCopia backend', healthy: true });
}

// ============================================================
// VALUATION ENGINE (server-side — proprietary; not exposed to browser)
// ============================================================

// ---------- Tables ----------
// These mirror the spreadsheet shapes recommended in ENGINE.md so they can
// later be loaded from a "Tables" tab on the bound Sheet without changing
// engine logic. Founders edit values here OR migrate to a Sheet tab when
// they're ready.

var ENGINE_TABLES = (function () {
  var STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  var SPECIALTIES = ['Primary Care','Internal Medicine','Family Medicine','Pediatrics','OB/GYN','Cardiology','Orthopedics','Dermatology','Ophthalmology','Gastroenterology','Urology','Neurology','Psychiatry','Radiology','Anesthesiology','Emergency Medicine','General Surgery','Other'];

  var STATE_MARKET_FACTOR = {
    AL:0.92,AK:1.10,AZ:1.05,AR:0.90,CA:1.25,CO:1.10,CT:1.15,DE:1.05,DC:1.22,FL:1.05,
    GA:1.00,HI:1.20,ID:0.95,IL:1.10,IN:0.95,IA:0.92,KS:0.93,KY:0.92,LA:0.95,ME:1.00,
    MD:1.12,MA:1.18,MI:0.98,MN:1.05,MS:0.88,MO:0.95,MT:0.95,NE:0.94,NV:1.05,NH:1.05,
    NJ:1.15,NM:0.95,NY:1.20,NC:1.00,ND:0.95,OH:0.95,OK:0.92,OR:1.08,PA:1.05,RI:1.08,
    SC:0.97,SD:0.93,TN:0.98,TX:1.08,UT:1.02,VT:1.00,VA:1.05,WA:1.15,WV:0.88,WI:0.97,WY:0.95,
    _default:1.00
  };

  var SPECIALTY_NATIONAL_COMP = {
    'Primary Care':255000,'Internal Medicine':265000,'Family Medicine':250000,
    'Pediatrics':220000,'OB/GYN':320000,'Cardiology':440000,'Orthopedics':550000,
    'Dermatology':400000,'Ophthalmology':380000,'Gastroenterology':450000,
    'Urology':430000,'Neurology':310000,'Psychiatry':275000,'Radiology':450000,
    'Anesthesiology':430000,'Emergency Medicine':350000,'General Surgery':410000,
    'Other':300000,_default:280000
  };

  var BLS_COMPENSATION = {};
  for (var i = 0; i < SPECIALTIES.length; i++) {
    var sp = SPECIALTIES[i];
    var nat = SPECIALTY_NATIONAL_COMP[sp] || SPECIALTY_NATIONAL_COMP._default;
    BLS_COMPENSATION[sp] = { _default: nat };
    for (var j = 0; j < STATES.length; j++) {
      var st = STATES[j];
      var mf = STATE_MARKET_FACTOR[st] || 1.0;
      var compFactor = 1 + (mf - 1) * 0.7;
      BLS_COMPENSATION[sp][st] = Math.round((nat * compFactor) / 1000) * 1000;
    }
  }
  BLS_COMPENSATION._default = { _default: SPECIALTY_NATIONAL_COMP._default };

  var SPECIALTY_MULTIPLIER = {
    'Primary Care':0.85,'Internal Medicine':0.88,'Family Medicine':0.85,
    'Pediatrics':0.82,'OB/GYN':0.90,'Cardiology':1.10,'Orthopedics':1.15,
    'Dermatology':1.20,'Ophthalmology':1.18,'Gastroenterology':1.12,
    'Urology':1.08,'Neurology':0.95,'Psychiatry':0.90,'Radiology':1.05,
    'Anesthesiology':0.88,'Emergency Medicine':0.92,'General Surgery':1.00,
    'Other':1.00,_default:1.00
  };

  var SPECIALTY_PAYER_DEFAULTS = {
    'Primary Care':       { medicare:35, medicaid:12, commercial:43, selfPay:10 },
    'Internal Medicine':  { medicare:40, medicaid:10, commercial:40, selfPay:10 },
    'Family Medicine':    { medicare:32, medicaid:14, commercial:44, selfPay:10 },
    'Pediatrics':         { medicare:5,  medicaid:35, commercial:50, selfPay:10 },
    'OB/GYN':             { medicare:10, medicaid:25, commercial:55, selfPay:10 },
    'Cardiology':         { medicare:50, medicaid:5,  commercial:38, selfPay:7  },
    'Orthopedics':        { medicare:35, medicaid:5,  commercial:50, selfPay:10 },
    'Dermatology':        { medicare:30, medicaid:5,  commercial:50, selfPay:15 },
    'Ophthalmology':      { medicare:50, medicaid:5,  commercial:35, selfPay:10 },
    'Gastroenterology':   { medicare:40, medicaid:5,  commercial:45, selfPay:10 },
    'Urology':            { medicare:45, medicaid:5,  commercial:40, selfPay:10 },
    'Neurology':          { medicare:40, medicaid:10, commercial:42, selfPay:8  },
    'Psychiatry':         { medicare:20, medicaid:20, commercial:45, selfPay:15 },
    'Radiology':          { medicare:40, medicaid:8,  commercial:47, selfPay:5  },
    'Anesthesiology':     { medicare:35, medicaid:10, commercial:50, selfPay:5  },
    'Emergency Medicine': { medicare:35, medicaid:20, commercial:30, selfPay:15 },
    'General Surgery':    { medicare:38, medicaid:10, commercial:45, selfPay:7  },
    'Other':              { medicare:35, medicaid:10, commercial:45, selfPay:10 },
    _default:             { medicare:35, medicaid:10, commercial:45, selfPay:10 }
  };

  var BASE_MULTIPLIER_ANCHORS = [
    [250000,0.40],[500000,0.50],[1000000,0.60],[2000000,0.70],
    [5000000,0.80],[10000000,0.90],[25000000,1.00],[50000000,1.05]
  ];

  var REAL_ESTATE_FACTOR = {
    'Own (included in sale)':1.15,'Own (not included)':1.00,'Lease':0.97,_default:1.00
  };

  var TIMELINE_FACTOR = {
    'Exploring options (no timeline)':1.02,'Within 6 months':0.95,
    '6-12 months':0.98,'1-2 years':1.00,'2+ years':1.02,_default:1.00
  };

  // National blended-payer CPV midpoints (ENGINE.md §"Cost-Per-Visit Model").
  // Used for revenue-validity check and to populate the report's CPV reference.
  var SPECIALTY_BASE_CPV = {
    'Primary Care':       175,
    'Internal Medicine':  200,
    'Family Medicine':    175,
    'Pediatrics':         150,
    'OB/GYN':             250,
    'Cardiology':         425,
    'Orthopedics':        400,
    'Dermatology':        325,
    'Ophthalmology':      375,
    'Gastroenterology':   500,
    'Urology':            325,
    'Neurology':          275,
    'Psychiatry':         225,
    'Radiology':          325,
    'Anesthesiology':     400,
    'Emergency Medicine': 325,
    'General Surgery':    450,
    'Other':              275,
    _default:             275
  };
  // Specialty CPV ranges (low/high) shown on the report's page 2.
  var SPECIALTY_CPV_RANGE = {
    'Primary Care':       [150, 200],
    'Internal Medicine':  [175, 225],
    'Family Medicine':    [150, 200],
    'Pediatrics':         [125, 175],
    'OB/GYN':             [200, 300],
    'Cardiology':         [350, 500],
    'Orthopedics':        [300, 500],
    'Dermatology':        [250, 400],
    'Ophthalmology':      [300, 450],
    'Gastroenterology':   [400, 600],
    'Urology':            [250, 400],
    'Neurology':          [200, 350],
    'Psychiatry':         [175, 275],
    'Radiology':          [250, 400],
    'Anesthesiology':     [300, 500],
    'Emergency Medicine': [250, 400],
    'General Surgery':    [350, 550],
    'Other':              [200, 400],
    _default:             [200, 400]
  };

  // U.S. Census Bureau ACS 2024 estimates, state level.
  // population, age65PlusPct, popGrowth5yrPct, medianHouseholdIncome
  var STATE_DEMOGRAPHICS = {
    AL:{p:5108468,a65:17.7,g:1.5,inc:60660}, AK:{p:733406,a65:13.8,g:-0.6,inc:89740},
    AZ:{p:7497004,a65:18.6,g:6.2,inc:73450}, AR:{p:3088354,a65:17.8,g:1.8,inc:56335},
    CA:{p:39060000,a65:15.6,g:-0.6,inc:91905}, CO:{p:5957493,a65:15.7,g:4.0,inc:87598},
    CT:{p:3617176,a65:18.3,g:1.0,inc:90213}, DE:{p:1031890,a65:20.1,g:5.6,inc:79325},
    DC:{p:687324,a65:13.0,g:0.7,inc:101027}, FL:{p:22610726,a65:21.6,g:5.5,inc:69303},
    GA:{p:11029227,a65:15.5,g:3.6,inc:71355}, HI:{p:1435138,a65:20.1,g:-1.5,inc:94814},
    ID:{p:1964726,a65:17.0,g:9.0,inc:74636}, IL:{p:12549689,a65:17.7,g:-1.7,inc:78433},
    IN:{p:6862199,a65:16.8,g:1.7,inc:67173}, IA:{p:3207004,a65:17.9,g:0.7,inc:70571},
    KS:{p:2940546,a65:17.3,g:0.4,inc:69747}, KY:{p:4526154,a65:17.7,g:0.7,inc:60183},
    LA:{p:4573749,a65:17.0,g:-1.6,inc:57650}, ME:{p:1395722,a65:22.4,g:2.7,inc:68251},
    MD:{p:6164660,a65:17.1,g:0.7,inc:98461}, MA:{p:7001399,a65:18.1,g:0.8,inc:96505},
    MI:{p:10037261,a65:18.6,g:0.0,inc:68505}, MN:{p:5737915,a65:17.0,g:1.2,inc:84313},
    MS:{p:2940057,a65:17.3,g:-1.0,inc:54915}, MO:{p:6196156,a65:17.9,g:1.0,inc:65920},
    MT:{p:1132812,a65:20.5,g:5.0,inc:69922}, NE:{p:1978379,a65:16.5,g:1.4,inc:71722},
    NV:{p:3194176,a65:17.4,g:5.0,inc:77719}, NH:{p:1402054,a65:20.1,g:2.5,inc:90845},
    NJ:{p:9290841,a65:17.7,g:0.6,inc:99781}, NM:{p:2114371,a65:19.4,g:0.2,inc:62268},
    NY:{p:19571216,a65:17.7,g:-3.0,inc:81386}, NC:{p:10835491,a65:17.4,g:4.5,inc:70804},
    ND:{p:783926,a65:16.4,g:1.3,inc:73959}, OH:{p:11785935,a65:18.5,g:0.4,inc:67769},
    OK:{p:4053824,a65:16.8,g:2.5,inc:62138}, OR:{p:4233358,a65:19.1,g:0.4,inc:80426},
    PA:{p:12972008,a65:19.6,g:0.0,inc:73824}, RI:{p:1095962,a65:19.6,g:1.8,inc:81854},
    SC:{p:5373555,a65:18.7,g:5.0,inc:67804}, SD:{p:919318,a65:17.7,g:3.7,inc:69457},
    TN:{p:7126489,a65:17.5,g:3.8,inc:67631}, TX:{p:30503301,a65:13.5,g:6.4,inc:73035},
    UT:{p:3417734,a65:12.0,g:7.5,inc:89168}, VT:{p:647464,a65:21.9,g:1.3,inc:74014},
    VA:{p:8715698,a65:16.8,g:1.6,inc:87249}, WA:{p:7812880,a65:16.9,g:2.6,inc:90325},
    WV:{p:1770071,a65:21.1,g:-1.8,inc:55217}, WI:{p:5910955,a65:18.4,g:0.7,inc:72458},
    WY:{p:584057,a65:18.1,g:0.6,inc:72495},
    _default:{p:0,a65:17.0,g:1.0,inc:75000}
  };

  var TRANSACTION_MULTIPLES = {
    'Primary Care':       { revLow:0.5, revHigh:1.0 },
    'Internal Medicine':  { revLow:0.5, revHigh:0.9 },
    'Family Medicine':    { revLow:0.5, revHigh:0.9 },
    'Pediatrics':         { revLow:0.4, revHigh:0.8 },
    'OB/GYN':             { revLow:0.5, revHigh:1.0 },
    'Cardiology':         { revLow:0.8, revHigh:1.5 },
    'Orthopedics':        { revLow:0.7, revHigh:1.3 },
    'Dermatology':        { revLow:0.7, revHigh:1.2 },
    'Ophthalmology':      { revLow:0.8, revHigh:1.5 },
    'Gastroenterology':   { revLow:0.8, revHigh:1.4 },
    'Urology':            { revLow:0.7, revHigh:1.2 },
    'Neurology':          { revLow:0.6, revHigh:1.0 },
    'Psychiatry':         { revLow:0.6, revHigh:1.1 },
    'Radiology':          { revLow:0.6, revHigh:1.0 },
    'Anesthesiology':     { revLow:0.5, revHigh:0.9 },
    'Emergency Medicine': { revLow:0.5, revHigh:0.9 },
    'General Surgery':    { revLow:0.6, revHigh:1.1 },
    'Other':              { revLow:0.5, revHigh:1.1 },
    _default:             { revLow:0.5, revHigh:1.1 }
  };

  return {
    STATE_MARKET_FACTOR: STATE_MARKET_FACTOR,
    BLS_COMPENSATION: BLS_COMPENSATION,
    SPECIALTY_MULTIPLIER: SPECIALTY_MULTIPLIER,
    SPECIALTY_PAYER_DEFAULTS: SPECIALTY_PAYER_DEFAULTS,
    BASE_MULTIPLIER_ANCHORS: BASE_MULTIPLIER_ANCHORS,
    REAL_ESTATE_FACTOR: REAL_ESTATE_FACTOR,
    TIMELINE_FACTOR: TIMELINE_FACTOR,
    TRANSACTION_MULTIPLES: TRANSACTION_MULTIPLES,
    SPECIALTY_BASE_CPV: SPECIALTY_BASE_CPV,
    SPECIALTY_CPV_RANGE: SPECIALTY_CPV_RANGE,
    STATE_DEMOGRAPHICS: STATE_DEMOGRAPHICS
  };
})();

// ---------- Live Engine-Table loading from the Sheet ----------
// On first call after cache miss, reads each Tbl_* tab in the bound Sheet and
// builds a runtime copy of ENGINE_TABLES. Cached 5 minutes. Fall back to the
// compiled-in ENGINE_TABLES when the Sheet is unavailable or a tab is missing.

var ENGINE_TAB_SCHEMA = [
  { tab: 'Tbl_SpecialtyMultiplier',   target: 'SPECIALTY_MULTIPLIER',     headers: ['specialty','multiplier'] },
  { tab: 'Tbl_StateMarketFactor',     target: 'STATE_MARKET_FACTOR',      headers: ['state','marketFactor'] },
  { tab: 'Tbl_BaseMultiplierAnchors', target: 'BASE_MULTIPLIER_ANCHORS',  headers: ['collections','multiplier'] },
  { tab: 'Tbl_RealEstateFactor',      target: 'REAL_ESTATE_FACTOR',       headers: ['realEstate','factor'] },
  { tab: 'Tbl_TimelineFactor',        target: 'TIMELINE_FACTOR',          headers: ['timeline','factor'] },
  { tab: 'Tbl_PayerDefaults',         target: 'SPECIALTY_PAYER_DEFAULTS', headers: ['specialty','medicare','medicaid','commercial','selfPay'] },
  { tab: 'Tbl_CpvBySpecialty',        target: 'SPECIALTY_BASE_CPV',       headers: ['specialty','cpvLow','cpvHigh','cpvMidpoint'] },
  { tab: 'Tbl_TransactionMultiples',  target: 'TRANSACTION_MULTIPLES',    headers: ['specialty','revLow','revHigh'] },
  { tab: 'Tbl_StateDemographics',     target: 'STATE_DEMOGRAPHICS',       headers: ['state','population','age65PlusPct','popGrowth5yrPct','medianHouseholdIncome'] }
];

var ENGINE_CACHE_KEY = 'engine_tables_v2';
var ENGINE_CACHE_SEC = 300; // 5 minutes

function getEngineTables() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(ENGINE_CACHE_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (_) {}
  }
  var live = loadEngineTablesFromSheet();
  if (live) {
    try { cache.put(ENGINE_CACHE_KEY, JSON.stringify(live), ENGINE_CACHE_SEC); } catch (_) {}
    return live;
  }
  return ENGINE_TABLES;
}

function invalidateEngineCache() {
  CacheService.getScriptCache().remove(ENGINE_CACHE_KEY);
  Logger.log('Engine table cache cleared. Next valuation will re-read the Sheet.');
}

function loadEngineTablesFromSheet() {
  try {
    var ss = book();
    var live = {};
    for (var i = 0; i < ENGINE_TAB_SCHEMA.length; i++) {
      var spec = ENGINE_TAB_SCHEMA[i];
      var sheet = ss.getSheetByName(spec.tab);
      if (!sheet) {
        // Missing tab → fall back entirely so we don't serve a half-loaded set.
        return null;
      }
      var rows = sheet.getDataRange().getValues();
      if (rows.length < 2) return null;
      live[spec.target] = parseTableRows(spec, rows);
    }
    // Augmented derived tables (kept compiled-in so founders don't have to maintain ranges twice)
    live.SPECIALTY_CPV_RANGE = deriveSpecialtyCpvRangeFrom(live.SPECIALTY_BASE_CPV);
    live.BLS_COMPENSATION = ENGINE_TABLES.BLS_COMPENSATION;
    return live;
  } catch (err) {
    Logger.log('loadEngineTablesFromSheet failed: ' + err);
    return null;
  }
}

function parseTableRows(spec, rows) {
  var headers = rows[0].map(function (h) { return String(h).trim(); });
  var body = rows.slice(1);
  var out = {};
  if (spec.target === 'BASE_MULTIPLIER_ANCHORS') {
    var pairs = [];
    for (var i = 0; i < body.length; i++) {
      var r = body[i];
      if (r[0] === '' || r[0] == null) continue;
      pairs.push([Number(r[0]), Number(r[1])]);
    }
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    return pairs;
  }
  if (spec.target === 'SPECIALTY_BASE_CPV') {
    // Returns the midpoint as the table value; range derived separately.
    var raw = {};
    for (var j = 0; j < body.length; j++) {
      var key = String(body[j][0]).trim();
      if (!key) continue;
      var lo = Number(body[j][1]);
      var hi = Number(body[j][2]);
      var mid = body[j][3] !== '' && body[j][3] != null ? Number(body[j][3]) : (lo + hi) / 2;
      raw[key] = mid;
      raw['__range__' + key] = [lo, hi];
    }
    if (raw._default == null) raw._default = ENGINE_TABLES.SPECIALTY_BASE_CPV._default;
    return raw;
  }
  for (var k = 0; k < body.length; k++) {
    var row = body[k];
    var rkey = String(row[0]).trim();
    if (!rkey) continue;
    if (headers.length === 2) {
      out[rkey] = Number(row[1]);
    } else if (spec.target === 'STATE_DEMOGRAPHICS') {
      out[rkey] = {
        p:   Number(row[1]),
        a65: Number(row[2]),
        g:   Number(row[3]),
        inc: Number(row[4])
      };
    } else if (spec.target === 'TRANSACTION_MULTIPLES') {
      out[rkey] = { revLow: Number(row[1]), revHigh: Number(row[2]) };
    } else if (spec.target === 'SPECIALTY_PAYER_DEFAULTS') {
      out[rkey] = {
        medicare:   Number(row[1]),
        medicaid:   Number(row[2]),
        commercial: Number(row[3]),
        selfPay:    Number(row[4])
      };
    }
  }
  if (out._default === undefined && ENGINE_TABLES[spec.target] && ENGINE_TABLES[spec.target]._default !== undefined) {
    out._default = ENGINE_TABLES[spec.target]._default;
  }
  return out;
}

function deriveSpecialtyCpvRangeFrom(raw) {
  // Built from the SPECIALTY_BASE_CPV tab's __range__ markers. Falls back to compiled-in.
  var out = {};
  if (raw && typeof raw === 'object') {
    for (var k in raw) {
      if (k.indexOf('__range__') === 0) out[k.substring(9)] = raw[k];
    }
  }
  if (Object.keys(out).length === 0) return ENGINE_TABLES.SPECIALTY_CPV_RANGE;
  if (!out._default) out._default = ENGINE_TABLES.SPECIALTY_CPV_RANGE._default;
  return out;
}

function tableLookup(name, key) {
  var tables = getEngineTables();
  var t = tables[name] || ENGINE_TABLES[name];
  if (!t) return null;
  if (key === undefined) return t._default;
  return (t[key] !== undefined) ? t[key] : t._default;
}

// One-shot admin: create the 9 engine-table tabs and populate them with the
// current compiled-in values. Run from the Apps Script editor.
//
// Each tab is wrapped in its own try/catch so a single Sheet-API hiccup
// doesn't black-hole the whole run. Look at the View → Logs after running.
function setupEngineTables() {
  var ss;
  try {
    ss = book();
    if (!ss) {
      throw new Error('book() returned null — script is not bound to a Sheet and SHEET_ID property is empty.');
    }
    Logger.log('Sheet: ' + ss.getName() + ' (' + ss.getId() + ')');
  } catch (err) {
    Logger.log('FATAL: cannot open Sheet — ' + err);
    throw err;
  }

  var results = [];
  for (var i = 0; i < ENGINE_TAB_SCHEMA.length; i++) {
    var spec = ENGINE_TAB_SCHEMA[i];
    try {
      var sheet = ss.getSheetByName(spec.tab);
      if (!sheet) sheet = ss.insertSheet(spec.tab);
      sheet.clear();
      var rows = [spec.headers].concat(buildTableRows(spec));
      sheet.getRange(1, 1, rows.length, spec.headers.length).setValues(rows);
      sheet.getRange(1, 1, 1, spec.headers.length).setFontWeight('bold').setBackground('#E8EEF6');
      sheet.setFrozenRows(1);
      try { sheet.autoResizeColumns(1, spec.headers.length); } catch (_) {} // cosmetic only
      results.push('OK   ' + spec.tab + ' (' + (rows.length - 1) + ' rows)');
    } catch (err) {
      results.push('FAIL ' + spec.tab + ' — ' + (err && err.message ? err.message : err));
    }
  }

  try { invalidateEngineCache(); } catch (_) {}
  Logger.log('Engine tables setup complete:\n' + results.join('\n'));
}

// Diagnostic: prints what the Sheet looks like + auth state. Run if
// setupEngineTables fails with no useful info.
function diagnoseSetup() {
  try {
    var ss = book();
    Logger.log('Spreadsheet OK: ' + (ss ? ss.getName() : 'NULL'));
    if (ss) Logger.log('Existing tabs: ' + ss.getSheets().map(function(s){return s.getName();}).join(', '));
  } catch (err) {
    Logger.log('book() error: ' + err);
  }
  try {
    Logger.log('Cache test: ' + (CacheService.getScriptCache() ? 'OK' : 'NULL'));
  } catch (err) {
    Logger.log('CacheService error: ' + err);
  }
  Logger.log('Schema length: ' + ENGINE_TAB_SCHEMA.length);
  for (var i = 0; i < ENGINE_TAB_SCHEMA.length; i++) {
    try {
      var rows = buildTableRows(ENGINE_TAB_SCHEMA[i]);
      Logger.log('  ' + ENGINE_TAB_SCHEMA[i].tab + ': ' + rows.length + ' rows ready');
    } catch (err) {
      Logger.log('  ' + ENGINE_TAB_SCHEMA[i].tab + ': BUILD ERROR ' + err);
    }
  }
}

function buildTableRows(spec) {
  var t = ENGINE_TABLES[spec.target];
  var rows = [];
  if (spec.target === 'BASE_MULTIPLIER_ANCHORS') {
    for (var i = 0; i < t.length; i++) rows.push([t[i][0], t[i][1]]);
    return rows;
  }
  if (spec.target === 'SPECIALTY_BASE_CPV') {
    var range = ENGINE_TABLES.SPECIALTY_CPV_RANGE;
    for (var k in t) {
      if (k === '_default') continue;
      var lo = range[k] ? range[k][0] : t[k];
      var hi = range[k] ? range[k][1] : t[k];
      rows.push([k, lo, hi, t[k]]);
    }
    rows.push(['_default', range._default[0], range._default[1], t._default]);
    return rows;
  }
  for (var key in t) {
    if (spec.target === 'STATE_DEMOGRAPHICS') {
      var d = t[key];
      rows.push([key, d.p, d.a65, d.g, d.inc]);
    } else if (spec.target === 'TRANSACTION_MULTIPLES') {
      rows.push([key, t[key].revLow, t[key].revHigh]);
    } else if (spec.target === 'SPECIALTY_PAYER_DEFAULTS') {
      var p = t[key];
      rows.push([key, p.medicare, p.medicaid, p.commercial, p.selfPay]);
    } else {
      rows.push([key, t[key]]);
    }
  }
  return rows;
}

// ---------- Engine route ----------

function handleComputeValuation(p) {
  try {
    var inputs = engineNormalize(p || {});

    // Stage 2: enrichment (via UrlFetchApp; cached in CacheService for 6h)
    var npi = inputs.npi ? engineNppes(inputs.npi) : null;
    var cms = inputs.npi ? engineCms(inputs.npi) : null;

    var dataSources = [
      'MDCopia Proprietary Engine',
      'BLS Occupational Employment & Wage Statistics (OEWS)',
      'BLS Consumer Price Index by Metropolitan Area',
      'CMS Geographic Practice Cost Index (GPCI)',
      'MGMA DataDive (published summaries)',
      'AMA Physician Practice Benchmark Survey',
      'KFF State Health Facts',
      'U.S. Census Bureau American Community Survey',
      'FOCUS Investment Banking — Physician Practice M&A reports',
      'Scope Research — specialty-level transaction analyses',
      'First Page Sage — Healthcare EBITDA & Valuation Multiples',
      'Levin Associates — deal volume data',
      'HealthValue Group — transaction trend analyses',
      'SovDoc — specialty-level multiple analyses'
    ];
    if (npi) dataSources.push('NPPES NPI Registry (HHS / CMS)');
    if (cms) dataSources.push('CMS Medicare Physician & Other Practitioners');

    var practiceAge = npi && npi.enumerationYear
      ? new Date().getUTCFullYear() - npi.enumerationYear
      : 10;
    var providerCount = Math.max((npi && npi.providerCount) || 1, 1);

    var npiDiscrepancies = [];
    if (npi && npi.specialty && inputs.specialty &&
        !engineSpecialtyMatches(npi.specialty, inputs.specialty)) {
      npiDiscrepancies.push('NPPES specialty "' + npi.specialty + '" differs from selected "' + inputs.specialty + '". Using your selection.');
    }
    if (npi && npi.state && inputs.state && npi.state !== inputs.state) {
      npiDiscrepancies.push('NPPES state "' + npi.state + '" differs from selected "' + inputs.state + '". Using your selection.');
    }

    var collections = inputs.revenue * 0.95;
    var payer = tableLookup('SPECIALTY_PAYER_DEFAULTS', inputs.specialty);
    var payerMixDescription = 'National specialty defaults';

    if (cms && cms.medicareAllowedAmount > 0 && inputs.revenue > 0) {
      var medicareShare = Math.max(0, Math.min(100, (cms.medicareAllowedAmount / inputs.revenue) * 100));
      var remainder = 100 - medicareShare;
      var baselineNonMedicare = payer.medicaid + payer.commercial + payer.selfPay;
      if (baselineNonMedicare > 0) {
        payer = {
          medicare:   medicareShare,
          medicaid:   remainder * (payer.medicaid   / baselineNonMedicare),
          commercial: remainder * (payer.commercial / baselineNonMedicare),
          selfPay:    remainder * (payer.selfPay    / baselineNonMedicare)
        };
        payerMixDescription = 'Derived from CMS Medicare allowed-amount data';
      }
      if (cms.collectionRate > 0 && cms.collectionRate < 1.5) {
        collections = inputs.revenue * cms.collectionRate;
      }
    }

    // Stage 3: multipliers
    var baseMult = engineInterpolate(getEngineTables().BASE_MULTIPLIER_ANCHORS || ENGINE_TABLES.BASE_MULTIPLIER_ANCHORS, collections);
    var specMult = tableLookup('SPECIALTY_MULTIPLIER', inputs.specialty);
    var realEstateMult = tableLookup('REAL_ESTATE_FACTOR', inputs.realEstate);
    var timelineMult = tableLookup('TIMELINE_FACTOR', inputs.timeline);
    var marketMult = tableLookup('STATE_MARKET_FACTOR', inputs.state);
    var payerAdj = enginePayerMixAdj(payer);
    var scaleAdj = engineScaleFactor(providerCount, inputs.sites);

    var pointEstimate = collections * baseMult * specMult * payerAdj * scaleAdj
      * realEstateMult * timelineMult * marketMult;

    // Stage 4
    var spread = 0.15;
    var low  = Math.round((pointEstimate * (1 - spread)) / 5000) * 5000;
    var high = Math.round((pointEstimate * (1 + spread)) / 5000) * 5000;

    // Stage 5: calibration
    var txnBand = tableLookup('TRANSACTION_MULTIPLES', inputs.specialty);
    var impliedMultiple = inputs.revenue > 0 ? pointEstimate / inputs.revenue : 0;
    var calibrationFlag = !!(txnBand && (
      impliedMultiple < txnBand.revLow * 0.85 ||
      impliedMultiple > txnBand.revHigh * 1.15
    ));

    var methodology =
      'Valued using ' + engineFmtUSD(collections) + ' in estimated annual collections ' +
      'for a ' + inputs.specialty + ' practice in ' + (inputs.city || 'your city') + ', ' +
      inputs.state + '. Multipliers reflect specialty benchmarks, payer composition, ' +
      'practice scale, and local market conditions.';

    // CPV reference data for the report's page 2
    var cpvBaseline = tableLookup('SPECIALTY_BASE_CPV', inputs.specialty);
    var cpvRange = tableLookup('SPECIALTY_CPV_RANGE', inputs.specialty);
    var marketCpvFactor = (marketMult + 1) / 2; // damp the market factor for CPV
    var userCpv = inputs.visits > 0 ? inputs.revenue / inputs.visits : 0;
    var expectedCpv = cpvBaseline * marketCpvFactor;

    // Demographics snapshot
    var demo = tableLookup('STATE_DEMOGRAPHICS', inputs.state);

    // Detailed multipliers (so the report can reproduce the math line by line)
    var calc = {
      reportedRevenue:   round2(inputs.revenue),
      collectionsRate:   round4(collections / Math.max(inputs.revenue, 1)),
      collections:       round2(collections),
      baseMultiplier:    round4(baseMult),
      specialtyMult:     round4(specMult),
      payerMixMult:      round4(payerAdj),
      scaleMult:         round4(scaleAdj),
      realEstateMult:    round4(realEstateMult),
      timelineMult:      round4(timelineMult),
      marketMult:        round4(marketMult),
      pointEstimate:     round2(pointEstimate),
      spread:            spread,
      lowRounded:        round2(low),
      highRounded:       round2(high)
    };

    return {
      success: true,
      result: {
        low: round2(low),
        high: round2(high),
        pointEstimate: round2(pointEstimate),
        methodology: methodology,
        factors: {
          baseMultiple:        baseMult.toFixed(2) + 'x collections',
          specialtyAdjustment: enginePct(specMult - 1) + ' (' + inputs.specialty + ')',
          payerMixEffect:      payerMixDescription + ' (' + enginePct(payerAdj - 1) + ')',
          scaleEffect:         providerCount + ' provider' + (providerCount > 1 ? 's' : '') + ', ' +
                               inputs.sites + ' site' + (inputs.sites > 1 ? 's' : '') + ' (' + enginePct(scaleAdj - 1) + ')',
          marketFactor:        marketMult.toFixed(2) + 'x (' + inputs.state + ')',
          realEstate:          inputs.realEstate + ' (' + enginePct(realEstateMult - 1) + ')',
          timeline:            inputs.timeline + ' (' + enginePct(timelineMult - 1) + ')'
        },
        dataSources: dataSources,
        enrichment: {
          npiValidated:           !!npi,
          cmsDataUsed:            !!cms,
          npiDiscrepancies:       npiDiscrepancies,
          practiceAge:            practiceAge,
          providerCount:          providerCount,
          medicareAllowedAmount:  cms ? cms.medicareAllowedAmount : null,
          calibrationFlag:        calibrationFlag,
          impliedRevenueMultiple: round4(impliedMultiple)
        },
        // For the printable report (page 2)
        analysis: {
          calc: calc,
          cpv: {
            user:           round2(userCpv),
            expected:       round2(expectedCpv),
            specialtyLow:   cpvRange[0],
            specialtyHigh:  cpvRange[1],
            withinExpected: userCpv >= cpvRange[0] * 0.5 && userCpv <= cpvRange[1] * 2.0
          },
          payerMatrix: {
            medicare:   round2(payer.medicare),
            medicaid:   round2(payer.medicaid),
            commercial: round2(payer.commercial),
            selfPay:    round2(payer.selfPay),
            source:     payerMixDescription
          },
          demographics: {
            state:               inputs.state,
            population:          demo.p,
            age65PlusPct:        demo.a65,
            popGrowth5yrPct:     demo.g,
            medianHouseholdIncome: demo.inc
          }
        }
      }
    };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
}

function engineNormalize(raw) {
  return {
    practiceName: String(raw.practiceName || '').replace(/^\s+|\s+$/g, ''),
    specialty:    String(raw.specialty || raw.practiceType || 'Other').replace(/^\s+|\s+$/g, ''),
    city:         String(raw.city || '').replace(/^\s+|\s+$/g, ''),
    state:        String(raw.state || '').replace(/^\s+|\s+$/g, '').toUpperCase(),
    npi:          engineNormNpi(raw.npi),
    revenue:      Math.max(engineParseRevenue(raw.revenue), 0),
    visits:       Math.max(engineParseVisits(raw.visits), 0),
    sites:        Math.max(parseInt(String(raw.sites || '1').replace(/[^0-9]/g, ''), 10) || 1, 1),
    realEstate:   String(raw.realEstate || 'Lease').replace(/^\s+|\s+$/g, ''),
    timeline:     String(raw.timeline || '1-2 years').replace(/^\s+|\s+$/g, '')
  };
}

function engineParseRevenue(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : 0;
  return parseFloat(String(raw == null ? '' : raw).replace(/[$,\s]/g, '')) || 0;
}
function engineParseVisits(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? Math.round(raw) : 0;
  return parseInt(String(raw == null ? '' : raw).replace(/[,\s]/g, ''), 10) || 0;
}
function engineNormNpi(raw) {
  if (raw == null) return null;
  var d = String(raw).replace(/\D/g, '');
  return /^\d{10}$/.test(d) ? d : null;
}

function engineInterpolate(anchors, x) {
  if (!anchors || anchors.length === 0) return 0;
  if (anchors.length === 1) return anchors[0][1];
  if (x <= anchors[0][0]) return anchors[0][1];
  if (x >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];
  for (var i = 0; i < anchors.length - 1; i++) {
    var x0 = anchors[i][0], y0 = anchors[i][1];
    var x1 = anchors[i + 1][0], y1 = anchors[i + 1][1];
    if (x >= x0 && x <= x1) {
      var t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return anchors[anchors.length - 1][1];
}

function enginePayerMixAdj(p) {
  var m = (p.medicare == null) ? 35 : p.medicare;
  var d = (p.medicaid == null) ? 10 : p.medicaid;
  var c = (p.commercial == null) ? 45 : p.commercial;
  var s = (p.selfPay == null) ? 10 : p.selfPay;
  var total = m + d + c + s || 1;
  var mN = (m / total) * 100, dN = (d / total) * 100;
  var cN = (c / total) * 100, sN = (s / total) * 100;
  return 1.0
    + (cN - 45) * 0.003
    + (dN - 10) * -0.004
    + (mN - 35) * -0.001
    + (sN - 10) * -0.002;
}

function engineScaleFactor(providers, sites) {
  var providerFactor = 1.0 + (Math.log(Math.max(providers, 1)) / Math.log(2)) * 0.05;
  var siteFactor = 1.0 + Math.min((sites - 1) * 0.02, 0.10);
  return Math.min(providerFactor * siteFactor, 1.35);
}

function engineSpecialtyMatches(taxonomyDesc, selected) {
  var a = String(taxonomyDesc).toLowerCase();
  var b = String(selected).toLowerCase();
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
  var tokens = b.split(/[\s\/]+/);
  for (var i = 0; i < tokens.length; i++) {
    if (tokens[i].length >= 4 && a.indexOf(tokens[i]) >= 0) return true;
  }
  return false;
}

// ---------- Server-side enrichment with CacheService ----------

function engineFetchJson(url, cacheKey) {
  var cache = CacheService.getScriptCache();
  if (cacheKey) {
    var hit = cache.get(cacheKey);
    if (hit) {
      try { return JSON.parse(hit); } catch (_) {}
    }
  }
  try {
    var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) return null;
    var text = res.getContentText();
    var data = JSON.parse(text);
    if (cacheKey) cache.put(cacheKey, text, 21600);
    return data;
  } catch (_) {
    return null;
  }
}

function engineNppes(npi) {
  var data = engineFetchJson(
    'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=' + encodeURIComponent(npi),
    'nppes_' + npi
  );
  if (!data || !data.results || !data.results[0]) return null;
  var r = data.results[0];
  var taxonomy = null;
  if (r.taxonomies) {
    for (var i = 0; i < r.taxonomies.length; i++) {
      if (r.taxonomies[i].primary) { taxonomy = r.taxonomies[i]; break; }
    }
    if (!taxonomy) taxonomy = r.taxonomies[0];
  }
  var addr = null;
  if (r.addresses) {
    for (var j = 0; j < r.addresses.length; j++) {
      if (r.addresses[j].address_purpose === 'LOCATION') { addr = r.addresses[j]; break; }
    }
    if (!addr) addr = r.addresses[0];
  }
  var enrolledYear = null;
  if (r.basic && r.basic.enumeration_date) {
    enrolledYear = new Date(r.basic.enumeration_date).getUTCFullYear();
  }
  return {
    entityType:       r.enumeration_type === 'NPI-2' ? 2 : 1,
    organizationName: (r.basic && r.basic.organization_name) || null,
    providerName:     (r.basic && r.basic.first_name) ? (r.basic.first_name + ' ' + r.basic.last_name) : ((r.basic && r.basic.organization_name) || null),
    taxonomy:         taxonomy ? taxonomy.code : null,
    specialty:        taxonomy ? taxonomy.desc : null,
    city:             addr ? addr.city : null,
    state:            addr ? addr.state : null,
    enumerationYear:  enrolledYear,
    providerCount:    r.enumeration_type === 'NPI-2' ? 2 : 1
  };
}

function engineCms(npi) {
  var arr = engineFetchJson(
    'https://data.cms.gov/data-api/v1/dataset/92396110-2aed-4d63-a6a2-5d6207d46a29/data?filter[Rndrng_NPI]=' + encodeURIComponent(npi),
    'cms_' + npi
  );
  if (!Array.isArray(arr) || arr.length === 0) return null;
  // Pick the most recent year's row
  var row = arr[0];
  for (var i = 1; i < arr.length; i++) {
    if (Number(arr[i].Year || 0) > Number(row.Year || 0)) row = arr[i];
  }
  var allowed = Number(row.Tot_Mdcr_Alowd_Amt) || 0;
  var paid = Number(row.Tot_Mdcr_Pymt_Amt) || 0;
  return {
    year:                  Number(row.Year) || null,
    totalServices:         Number(row.Tot_Srvcs) || 0,
    totalBeneficiaries:    Number(row.Tot_Benes) || 0,
    medicareAllowedAmount: allowed,
    medicarePaymentAmount: paid,
    collectionRate:        allowed > 0 ? paid / allowed : 0
  };
}

// ---------- Engine helpers ----------

function engineFmtUSD(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function enginePct(x) {
  var v = Math.round(x * 100);
  return (v >= 0 ? '+' : '') + v + '%';
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ---------- API proxy ----------
// Stateless passthrough for browser-side fetches blocked by CORS.
// Whitelist enforced; no logging; no Sheet writes.
var API_PROXY_HOST_ALLOWLIST = [
  'npiregistry.cms.hhs.gov',
  'data.cms.gov'
];

function handleApiProxy(p) {
  var url = String(p && p.url || '');
  if (!url) return { success: false, error: 'url required' };
  var hostMatch = url.match(/^https:\/\/([^\/]+)/);
  if (!hostMatch) return { success: false, error: 'https URL required' };
  var host = hostMatch[1].toLowerCase();
  if (API_PROXY_HOST_ALLOWLIST.indexOf(host) === -1) {
    return { success: false, error: 'host not allowed: ' + host };
  }
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    var data = null;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    return { success: code >= 200 && code < 300, status: code, data: data, raw: data === null ? text : null };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Route handlers ----------

function handleSellerSubmit(p) {
  if (!p.email) return { success: false, error: 'email required' };
  var sheet = sellerSheet();
  var leadId = newLeadId();
  var ts = new Date();
  var npiType = (p.npi && String(p.npi).length === 10) ? 'unknown' : '';
  var enrichment = p.enrichment || {};
  if (enrichment && typeof enrichment.providerCount === 'number') {
    npiType = enrichment.providerCount > 1 ? '2' : '1';
  }

  var consented = !!p.consentAcknowledged;
  var row = headerOrderedRow(TAB.SELLER, {
    'Timestamp': ts,
    'Lead ID': leadId,
    'Practice Name': p.practiceName || '',
    'Practice Specialty': p.specialty || '',
    'City': p.city || '',
    'State': p.state || '',
    'NPI': p.npi || '',
    'NPI Type': npiType,
    'Annual Revenue': Number(p.revenue) || 0,
    'Annual Visits': Number(p.visits) || 0,
    'Sites': Number(p.sites) || 1,
    'Real Estate': p.realEstate || '',
    'Timeline': p.timeline || '',
    'Email': p.email,
    'Status': consented ? 'Consented — In Marketplace' : 'New',
    'Email Verified': false,
    'Consent Given': consented,
    'Consent Date': consented ? ts : '',
    'Code Attempts': 0,
    'Valuation Range Low': Number(p.valuationLow) || 0,
    'Valuation Range High': Number(p.valuationHigh) || 0,
    'Valuation Point': Number(p.valuationPoint) || 0,
    'Methodology': p.methodology || '',
    'Enrichment Data': JSON.stringify(p.enrichment || {}),
    'Factors': JSON.stringify(p.factors || {}),
    'Data Sources': (p.dataSources || []).join('; '),
    'Valuation Delivered Date': ts
  });
  sheet.appendRow(row);

  var fmt = function(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  // Note: seller confirmation email intentionally omitted — seller has just
  // seen the range on screen, and the verification code email follows in <1s.
  // Two emails to the same inbox in the same minute felt like noise.

  notifyPartners({
    subject: 'New MDCopia Lead: ' + (p.practiceName || 'Unnamed') + ', ' + (p.city || '') + ', ' + (p.state || ''),
    html:
      '<p><strong>Lead ID:</strong> ' + leadId + '</p>' +
      '<p><strong>Specialty:</strong> ' + esc(p.specialty || '') + '<br>' +
      '<strong>Revenue:</strong> ' + fmt(p.revenue || 0) + '<br>' +
      '<strong>Range:</strong> ' + fmt(p.valuationLow) + ' – ' + fmt(p.valuationHigh) + '</p>' +
      '<p><strong>Email:</strong> ' + esc(p.email) + '</p>' +
      '<pre>' + esc(JSON.stringify(p, null, 2)) + '</pre>'
  });

  return { success: true, leadId: leadId };
}

function handleSendVerification(p) {
  if (!p.email) return { success: false, error: 'email required' };
  var rowInfo = findSellerRowByEmail(p.email);
  if (!rowInfo) return { success: false, error: 'Lead not found. Please submit the valuation form first.' };

  var code = generateCode();
  var expiry = new Date(new Date().getTime() + 30 * 60 * 1000);
  setSellerCells(rowInfo.row, {
    'Verification Code': code,
    'Code Expiry': expiry,
    'Code Attempts': 0
  });

  sendResend({
    to: p.email,
    subject: 'MDCopia: Your Verification Code',
    html:
      '<p>Your MDCopia verification code is:</p>' +
      '<p style="font-size:28px;letter-spacing:6px;font-family:monospace;"><strong>' + code + '</strong></p>' +
      '<p>This code expires in 30 minutes. If you did not request it, you can safely ignore this email.</p>'
  });

  return { success: true };
}

function handleVerifyCode(p) {
  if (!p.email || !p.code) return { success: false, error: 'email and code required' };
  var rowInfo = findSellerRowByEmail(p.email);
  if (!rowInfo) return { success: false, error: 'Lead not found.' };

  var attempts = Number(rowInfo.values['Code Attempts'] || 0);
  if (attempts >= 3) {
    return { success: true, verified: false, reason: 'Too many attempts. Please request a new code.' };
  }
  var stored = String(rowInfo.values['Verification Code'] || '');
  var expiry = rowInfo.values['Code Expiry'] ? new Date(rowInfo.values['Code Expiry']) : null;
  var now = new Date();

  if (!stored || !expiry) {
    return { success: true, verified: false, reason: 'No code on file. Please request one.' };
  }
  if (now > expiry) {
    return { success: true, verified: false, reason: 'Code expired. Please request a new code.' };
  }
  if (String(p.code).trim() !== stored) {
    setSellerCells(rowInfo.row, { 'Code Attempts': attempts + 1 });
    return { success: true, verified: false, reason: 'Invalid code. Please try again.' };
  }

  setSellerCells(rowInfo.row, {
    'Email Verified': true,
    'Verification Code': '',
    'Code Expiry': '',
    'Status': 'Email Verified'
  });
  return { success: true, verified: true };
}

function handleSellerConsent(p) {
  if (!p.email) return { success: false, error: 'email required' };
  var rowInfo = findSellerRowByEmail(p.email);
  if (!rowInfo) return { success: false, error: 'Lead not found.' };
  if (!rowInfo.values['Email Verified']) {
    return { success: false, error: 'Email must be verified before consent.' };
  }
  setSellerCells(rowInfo.row, {
    'Consent Given': true,
    'Consent Date': new Date(),
    'Status': 'Consented — In Marketplace'
  });
  return { success: true };
}

function handleEngineError(p) {
  notifyPartners({
    subject: 'MDCopia ENGINE ERROR',
    html:
      '<p><strong>Message:</strong> ' + esc((p.error && p.error.message) || 'unknown') + '</p>' +
      '<pre>' + esc((p.error && p.error.stack) || '') + '</pre>' +
      '<hr><p><strong>Form data:</strong></p>' +
      '<pre>' + esc(JSON.stringify(p.formData || {}, null, 2)) + '</pre>'
  });
  return { success: true };
}

// ---------- Sheet helpers ----------

function bookId() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id || null;
}

function book() {
  var id = bookId();
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sellerSheet() {
  var s = book().getSheetByName(TAB.SELLER);
  if (!s) throw new Error('Tab "' + TAB.SELLER + '" missing. Run setupSheets() once.');
  return s;
}

function findSellerRowByEmail(email) {
  var sheet = sellerSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  var headers = data[0];
  var emailCol = headers.indexOf('Email');
  if (emailCol < 0) return null;
  // Most recent first.
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][emailCol]).trim().toLowerCase() === String(email).trim().toLowerCase()) {
      var values = {};
      for (var j = 0; j < headers.length; j++) values[headers[j]] = data[i][j];
      return { row: i + 1, values: values };
    }
  }
  return null;
}

function setSellerCells(row, updates) {
  var sheet = sellerSheet();
  var headers = HEADERS[TAB.SELLER];
  for (var key in updates) {
    var col = headers.indexOf(key);
    if (col >= 0) sheet.getRange(row, col + 1).setValue(updates[key]);
  }
}

function headerOrderedRow(tabName, obj) {
  var headers = HEADERS[tabName];
  var row = [];
  for (var i = 0; i < headers.length; i++) {
    var v = obj[headers[i]];
    row.push(v === undefined ? '' : v);
  }
  return row;
}

// ---------- Email (Resend) ----------

function sendResend(opts) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('RESEND_API_KEY');
  var from = props.getProperty('SELLER_FROM_EMAIL') || 'noreply@mdcopia.com';
  if (!key) { Logger.log('Resend not configured; skipping email to ' + opts.to); return; }
  var payload = {
    from: 'MDCopia <' + from + '>',
    to: Array.isArray(opts.to) ? opts.to : [opts.to],
    subject: opts.subject,
    html: opts.html
  };
  UrlFetchApp.fetch('https://api.resend.com/emails', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

function notifyPartners(opts) {
  var props = PropertiesService.getScriptProperties();
  var p1 = props.getProperty('PARTNER_EMAIL_1');
  var p2 = props.getProperty('PARTNER_EMAIL_2');
  var to = [p1, p2].filter(function(x) { return !!x; });
  if (to.length === 0) { Logger.log('No partner emails configured'); return; }
  sendResend({ to: to, subject: opts.subject, html: opts.html });
}

// ---------- Admin: setup + buyer email ----------

function setupSheets() {
  var ss = book();
  Object.keys(HEADERS).forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var headers = HEADERS[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });
  Logger.log('Sheets initialized: ' + Object.keys(HEADERS).join(', '));
}

function sendBuyerEmail(rowNumber) {
  var ss = book();
  var sheet = ss.getSheetByName(TAB.DRAFTS);
  if (!sheet) throw new Error('Tab "' + TAB.DRAFTS + '" missing.');
  var headers = HEADERS[TAB.DRAFTS];
  var row = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  var rec = {};
  for (var i = 0; i < headers.length; i++) rec[headers[i]] = row[i];

  if (!rec['Buyer Email'])   throw new Error('Buyer Email is empty on row ' + rowNumber);
  if (!rec['Email Subject']) throw new Error('Email Subject is empty on row ' + rowNumber);
  if (!rec['Email Body'])    throw new Error('Email Body is empty on row ' + rowNumber);
  if (rec['Sent'] === true || rec['Sent'] === 'TRUE') {
    throw new Error('Row ' + rowNumber + ' already marked Sent.');
  }

  sendResend({
    to: rec['Buyer Email'],
    subject: rec['Email Subject'],
    html: String(rec['Email Body']).replace(/\n/g, '<br>')
  });

  var sentCol  = headers.indexOf('Sent') + 1;
  var dateCol  = headers.indexOf('Sent Date') + 1;
  sheet.getRange(rowNumber, sentCol).setValue(true);
  sheet.getRange(rowNumber, dateCol).setValue(new Date());

  // Log a transaction row.
  var txn = ss.getSheetByName(TAB.TXN);
  if (txn) {
    txn.appendRow([
      '', '', new Date(), rec['Valuation Low'] || '', rec['Valuation High'] || '',
      false, '', 'Lead Sent', '',
      'Buyer ' + (rec['Buyer Name'] || rec['Buyer Email']) +
        ' contacted re: ' + (rec['Seller Practice Name'] || '')
    ]);
  }

  Logger.log('Sent to ' + rec['Buyer Email']);
}

// ---------- Misc ----------

function newLeadId() {
  var d = new Date();
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  var stamp = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
              '-' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  var rand = Math.floor(Math.random() * 9000 + 1000);
  return 'L-' + stamp + '-' + rand;
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
