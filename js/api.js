// Shared fetch wrapper for all browser → Apps Script POST calls.
// Apps Script web apps don't accept JSON content types from anonymous origins
// without an OPTIONS preflight; using application/x-www-form-urlencoded keeps
// the request "simple" so the browser skips preflight entirely.

export const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzIlnc3M9zF7qUuQshh6ECuMLBCF_j22nsg9sjHBM1f9X8i3E5QxYKsmR0IgqIg-8F5-g/exec';

const TIMEOUT_MS = 15000;

export async function postAction(action, payload = {}) {
  if (!APPS_SCRIPT_URL) {
    throw new Error('APPS_SCRIPT_URL not configured in js/api.js');
  }
  const body = new URLSearchParams();
  body.append('action', action);
  body.append('payload', JSON.stringify(payload));

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      body,
      signal: ctl.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Backend error: HTTP ${res.status}`);
  }
  let json;
  try { json = await res.json(); }
  catch (e) { throw new Error('Backend returned non-JSON response'); }
  if (json && json.success === false) {
    throw new Error(json.error || 'Backend rejected the request');
  }
  return json;
}
