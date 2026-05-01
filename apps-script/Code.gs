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
      api_proxy:         handleApiProxy
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
    'Status': 'New',
    'Email Verified': false,
    'Consent Given': false,
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

  sendResend({
    to: p.email,
    subject: "MDCopia: We've Received Your Practice Information",
    html:
      '<p>Thank you for submitting <strong>' + esc(p.practiceName || 'your practice') + '</strong> to MDCopia.</p>' +
      '<p>Your preliminary valuation range is <strong>' + fmt(p.valuationLow) + ' – ' + fmt(p.valuationHigh) + '</strong>.</p>' +
      '<p>Next step: please verify your email address using the 6-digit code we sent in a separate message. ' +
      'A member of our team will follow up within 5 business days with your full valuation memo.</p>' +
      '<p>— The MDCopia Team</p>'
  });

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
