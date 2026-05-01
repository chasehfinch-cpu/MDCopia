// Email verification helpers used by verify.html.

import { postAction } from './api.js';

export async function requestCode(email) {
  return postAction('send_verification', { email });
}

export async function submitCode(email, code) {
  return postAction('verify_code', { email, code: String(code).trim() });
}

export async function recordConsent(email) {
  return postAction('seller_consent', { email });
}
