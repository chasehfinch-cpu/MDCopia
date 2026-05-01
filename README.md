# MDCopia

Physician practice valuation & acquisition marketplace. See `extracted/CLAUDE.md` and `extracted/ENGINE.md` for the full product and engine specifications.

This commit ships **Phase 0 (engine)** and **Phase 2 (Apps Script backend)** per `CLAUDE.md` Build Order. The static site (`index.html`, `valuation.html`, etc.) is Phase 1 and will follow once the engine is verified.

## Layout

```
js/
  engine.js          Valuation engine (4 stages, async, deterministic)
  tables.js          Table accessor seam (the Sheet/Excel migration boundary)
  tables-static.js   Embedded MVP lookup tables
  interpolate.js     Generic piecewise-linear interpolation
  form-submit.js     POST helpers for valuation.html → Apps Script
  verify.js          Verification code send/validate helpers
  engine.test.html   Standalone harness: run determinism + continuity tests in a browser
apps-script/
  Code.gs            5 doPost routes + sendBuyerEmail + setupSheets
  SETUP.md           Deploy + Script Properties + Sheet bootstrap walkthrough
```

## Verifying the engine

1. Open `js/engine.test.html` directly in a browser (file:// works; module imports are relative).
2. Click **Run Determinism** — console should log `PASS` for 10 identical runs.
3. Click **Run Continuity** — revenue sweep should be monotonically increasing with no >40% jumps.
4. DevTools → Network → Offline → re-run to confirm static-fallback path.

## Migrating tables to a Google Sheet

Today, every lookup lives in `js/tables-static.js`. To move them into a Sheet:

1. Create a Google Sheet with one tab per table (`SPECIALTY_MULTIPLIER`, `STATE_MARKET_FACTOR`, `BLS_COMPENSATION`, `SPECIALTY_PAYER_DEFAULTS`, `BASE_MULTIPLIER_ANCHORS`, `REAL_ESTATE_FACTOR`, `TIMELINE_FACTOR`, `TRANSACTION_MULTIPLES`).
2. File → Share → Publish to web → "Entire Document" → CSV.
3. Set `REMOTE_CSV_BASE` and `TABLE_GIDS` in `js/tables.js`.

No engine code changes required. `tables-static.js` remains the offline fallback.

## Deploying the Apps Script backend

See [`apps-script/SETUP.md`](apps-script/SETUP.md).
