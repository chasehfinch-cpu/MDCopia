// Email verification helpers used by verify.html.
// Consent is now collected inline on valuation.html and recorded as part of
// the seller_submit payload (consentAcknowledged: true), so there's no
// separate recordConsent step in the seller flow.

import { postAction } from './api.js';

export async function requestCode(email) {
  return postAction('send_verification', { email });
}

export async function submitCode(email, code) {
  return postAction('verify_code', { email, code: String(code).trim() });
}
