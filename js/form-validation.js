// Client-side validation + field helper triggers for valuation.html.
// All helpers are informational (never block submission) per CLAUDE.md spec.

const REQUIRED = ['practiceName','specialty','city','state','revenue','visits','sites','realEstate','timeline'];

export function validateValuationForm(data) {
  const errors = {};
  for (const key of REQUIRED) {
    const v = data[key];
    if (v === undefined || v === null || String(v).trim() === '') {
      errors[key] = 'Required';
    }
  }
  if (data.revenue !== '' && Number(parseRevenue(data.revenue)) <= 0) {
    errors.revenue = 'Enter a positive dollar amount';
  }
  if (data.visits !== '' && Number(parseVisits(data.visits)) <= 0) {
    errors.visits = 'Enter a positive number of visits';
  }
  if (data.sites && Number(data.sites) < 1) {
    errors.sites = 'At least 1';
  }
  if (data.npi && !/^\d{10}$/.test(String(data.npi).replace(/\D/g, ''))) {
    errors.npi = 'NPI must be 10 digits';
  }
  return errors;
}

export function fieldHelpers(data) {
  const helpers = {};
  const rev = parseRevenue(data.revenue);
  const vis = parseVisits(data.visits);

  if (rev > 0 && rev < 100000) {
    helpers.revenue = 'This seems low for a physician practice. If this is monthly revenue, please enter your annual total.';
  } else if (rev > 50000000) {
    helpers.revenue = 'This is above typical physician practice revenue. Please confirm this is the correct annual figure.';
  }

  if (vis > 0 && vis < 500) {
    helpers.visits = 'This is below typical annual visit volume. If this is monthly, please enter your annual total.';
  } else if (vis > 200000) {
    helpers.visits = 'This is above typical annual visit volume for the number of sites entered. Please confirm.';
  }

  if (rev > 0 && vis > 0) {
    const ratio = rev / vis;
    if (ratio < 50 || ratio > 2000) {
      helpers.revenue = (helpers.revenue ? helpers.revenue + ' ' : '') +
        'The ratio of revenue to visits seems unusual — please double-check both values.';
    }
  }

  return helpers;
}

export function parseRevenue(raw) {
  if (typeof raw === 'number') return raw;
  return parseFloat(String(raw ?? '').replace(/[$,\s]/g, '')) || 0;
}

export function parseVisits(raw) {
  if (typeof raw === 'number') return raw;
  return parseInt(String(raw ?? '').replace(/[,\s]/g, ''), 10) || 0;
}

export function formatCurrencyOnBlur(input) {
  const n = parseRevenue(input.value);
  if (!n) { input.value = ''; return; }
  input.value = '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

export function formatIntegerOnBlur(input) {
  const n = parseVisits(input.value);
  if (!n) { input.value = ''; return; }
  input.value = n.toLocaleString('en-US');
}

export function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

// Normalize a user-typed string to Title Case ("gulf COAST family medicine"
// → "Gulf Coast Family Medicine"). Preserves apostrophes (St. Mary's) and
// capitalizes after spaces and hyphens. Leaves common all-caps acronyms
// like "USA" alone if the user typed them deliberately.
export function titleCase(s) {
  if (s == null) return '';
  return String(s)
    .toLowerCase()
    .replace(/(^|[\s\-/])(\w)/g, function (_, sep, ch) { return sep + ch.toUpperCase(); })
    .replace(/\s+/g, ' ')
    .trim();
}

// Lowercase + trim for emails.
export function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// Wire up on-blur normalization for a form. Pass element references.
export function attachCasingNormalizers(form) {
  if (!form) return;
  const titleCaseFields = ['practiceName', 'city', 'specialtyOther'];
  for (const name of titleCaseFields) {
    const el = form.querySelector('[name="' + name + '"]');
    if (!el) continue;
    el.addEventListener('blur', () => {
      const v = el.value;
      if (!v) return;
      el.value = titleCase(v);
    });
  }
}
