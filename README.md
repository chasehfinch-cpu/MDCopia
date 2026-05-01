# MDCopia

Physician practice valuation & acquisition marketplace. See `extracted/CLAUDE.md` and `extracted/ENGINE.md` for the full product and engine specifications.

## Layout

```
*.html               Seven static pages (index, valuation, verify, submit,
                     success, why, privacy)
css/style.css        Single stylesheet — see STYLE.md for tokens + section map
js/
  api.js             Shared fetch wrapper to the Apps Script web app
  engine.js          Thin client: posts inputs → backend, returns range
  form-submit.js     submitSellerLead + notifyEngineError
  form-validation.js Required-field + helper-trigger logic
  flow.js            sessionStorage controller + page guards
  gate.js            Pre-launch SHA-256 password overlay
  verify.js          requestCode / submitCode / recordConsent
  engine.test.html   Browser harness: determinism + continuity (calls backend)
apps-script/
  Code.gs            doPost router with: seller_submit, send_verification,
                     verify_code, seller_consent, engine_error, api_proxy,
                     compute_valuation (the engine + all proprietary tables)
                     + sendBuyerEmail / setupSheets admin
  SETUP.md           Deploy + Script Properties + Sheet bootstrap walkthrough
robots.txt           Disallow: / (pre-launch)
STYLE.md             How to retheme the site
```

## Engine architecture

The valuation engine — multiplier curves, lookup tables, NPPES + CMS
enrichment, calibration check — lives **entirely in `apps-script/Code.gs`**.
The browser only sees inputs and the resulting range. No proprietary
formulas are exposed to anyone viewing page source.

Cost: each valuation is one HTTP roundtrip (~700–1500ms). The valuation
page masks this with a loading-bar animation.

## Verifying the engine

1. With the Apps Script web app deployed and `APPS_SCRIPT_URL` set in `js/api.js`, serve the repo locally (`python -m http.server 8000` from the root).
2. Open http://localhost:8000/js/engine.test.html.
3. Click **Run Determinism** — should log `PASS` for 5 identical runs.
4. Click **Run Continuity** — revenue sweep should be monotonically increasing with no >40% jumps.

## Migrating tables to a Google Sheet (founders)

Tables live in the `ENGINE_TABLES` IIFE near the top of `apps-script/Code.gs`.
To move to a Sheet later:

1. Create a `Tables` tab on your bound Sheet with one columnar layout per
   table (e.g., `SPECIALTY | MULTIPLIER` for `SPECIALTY_MULTIPLIER`).
2. Replace `tableLookup(name, key)` in `Code.gs` to read from the Sheet
   instead of the in-memory map (using `SpreadsheetApp.getActive().getSheetByName('Tables')...`).
3. Engine logic stays unchanged.

## Deploying the Apps Script backend

See [`apps-script/SETUP.md`](apps-script/SETUP.md).

## Pre-launch password gate

Currently `mdcopia-2026` (hashed in `js/gate.js`). To rotate, replace `PASSWORD_HASH` with `sha256("new-password")`.

To launch publicly: set `GATE_ENABLED = false` in `js/gate.js`, remove `Disallow: /` from `robots.txt`, and remove the `<meta name="robots" content="noindex, nofollow">` tag from each HTML head.
