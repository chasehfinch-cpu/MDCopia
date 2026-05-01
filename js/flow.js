// Seller flow controller. Stores form data in sessionStorage and guards
// mid-flow pages — if the user lands on verify/submit/success without the
// required state, redirect them back to valuation.html.

const KEYS = {
  FORM:       'mdcopia_form',
  VALUATION:  'mdcopia_valuation',
  EMAIL:      'mdcopia_email',
  VERIFIED:   'mdcopia_verified',
  CONSENTED:  'mdcopia_consented'
};

export const flow = {
  saveForm(data)        { sessionStorage.setItem(KEYS.FORM, JSON.stringify(data)); },
  loadForm()            { return safeJson(sessionStorage.getItem(KEYS.FORM)); },
  saveValuation(v)      { sessionStorage.setItem(KEYS.VALUATION, JSON.stringify(v)); },
  loadValuation()       { return safeJson(sessionStorage.getItem(KEYS.VALUATION)); },
  saveEmail(e)          { sessionStorage.setItem(KEYS.EMAIL, e); },
  loadEmail()           { return sessionStorage.getItem(KEYS.EMAIL); },
  markVerified()        { sessionStorage.setItem(KEYS.VERIFIED, '1'); },
  isVerified()          { return sessionStorage.getItem(KEYS.VERIFIED) === '1'; },
  markConsented()       { sessionStorage.setItem(KEYS.CONSENTED, '1'); },
  isConsented()         { return sessionStorage.getItem(KEYS.CONSENTED) === '1'; },
  clear() {
    Object.values(KEYS).forEach(k => sessionStorage.removeItem(k));
  }
};

export function guard(requirements) {
  // requirements: { form?, valuation?, email?, verified?, consented? }
  if (requirements.form && !flow.loadForm())             return redirect('valuation.html');
  if (requirements.valuation && !flow.loadValuation())   return redirect('valuation.html');
  if (requirements.email && !flow.loadEmail())           return redirect('valuation.html');
  if (requirements.verified && !flow.isVerified())       return redirect('verify.html');
  if (requirements.consented && !flow.isConsented())     return redirect('submit.html');
  return false;
}

function redirect(page) {
  if (location.pathname.endsWith(page)) return false;
  location.replace(page);
  return true;
}

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}
