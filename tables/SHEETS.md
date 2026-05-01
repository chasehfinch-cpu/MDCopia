# MDCopia Engine — Spreadsheet Reference

Every multiplier and lookup in the engine is here as a CSV. Each file
matches the corresponding constant in `apps-script/Code.gs`. Founders edit
these spreadsheets when public sources update; values flow back into the
engine on the next deploy.

## What each file is

| File | Purpose | When to update |
|---|---|---|
| `SPECIALTY_MULTIPLIER.csv` | Stage 3b — specialty premium/discount | Annually, or when transaction-multiple data shifts |
| `STATE_MARKET_FACTOR.csv` | Stage 3g — geographic market adjustment | Annually with new GPCI / cost-of-living data |
| `BASE_MULTIPLIER_ANCHORS.csv` | Stage 3a — collections curve anchors | Quarterly review; only update when anchor points need re-calibration |
| `REAL_ESTATE_FACTOR.csv` | Stage 3e | Rare; only when ownership-vs-lease premium shifts materially |
| `TIMELINE_FACTOR.csv` | Stage 3f | Rare |
| `SPECIALTY_PAYER_DEFAULTS.csv` | Stage 3c — fallback payer mix when no NPI | Annually with new MGMA / AMA data |
| `SPECIALTY_BASE_CPV.csv` | Page-2 CPV reference, validity check | Annually |
| `TRANSACTION_MULTIPLES.csv` | Calibration band (revenue-multiple low/high) | Semi-annually as new deal data lands |
| `STATE_DEMOGRAPHICS.csv` | Page-2 demographic snapshot | Annually with new Census ACS release |
| `WORKED_EXAMPLE.csv` | Step-by-step computation for one input — your training/QA reference | When you change any other table — re-run this to verify |

## How to use this in Google Sheets

This is the recommended setup for ongoing maintenance.

1. Create a new Google Sheet named `MDCopia Engine Tables`.
2. For each file in this folder, add a tab with the same name (e.g. `SPECIALTY_MULTIPLIER`).
3. Open the CSV in any text editor → copy → paste into the Sheet tab.
4. The first row is the header. Data starts row 2.
5. **Lock the header row** (View → Freeze → 1 row) so you don't accidentally edit column names.
6. **Protect ranges that are formula-derived** (Data → Protect ranges) so a co-founder can't accidentally type over a calc.

### When CMS, BLS, or another source publishes an update

Example: CMS publishes a new GPCI file each January.

1. Download the new CMS GPCI file from cms.gov.
2. Compute the composite GPCI per state (per ENGINE.md §2C).
3. Update the relevant cells in the `STATE_MARKET_FACTOR` tab.
4. **Re-run `WORKED_EXAMPLE`** in your head or on a side calc — make sure the math still terminates in a reasonable range. The example is configured for FL / Family Medicine / $3.2M; if your edit changes the FL row, this is your sanity check.
5. Open `apps-script/Code.gs` in this repo. The `STATE_MARKET_FACTOR` constant near the top of `ENGINE_TABLES` mirrors the CSV — update the same numbers there. Save.
6. Deploy the new Code.gs version (Apps Script editor → Deploy → Manage deployments → New version). The web app URL stays the same.

### Future: live Sheet → engine wiring

If you'd rather not manually copy values into `Code.gs` on every update, the Sheet can be wired to feed the engine directly:

1. In your Sheet: File → Share → Publish to web → CSV → "Entire document."
2. In `apps-script/Code.gs`: replace the `tableLookup` function with one that fetches the published CSV via `UrlFetchApp` and caches it in `CacheService`.

That's a 30-minute change. Ask me when you're ready to do it.

## The "modified times-table" approach

`WORKED_EXAMPLE.csv` is exactly that — a row-by-row times-table where each step is `previous_value × next_multiplier`. You can drop the same structure into a Google Sheet, replace the input cells (revenue, specialty, state, etc.), and it will recompute the full valuation visually. This is the right format because:

- Every input the seller provides has a single, isolated effect.
- Every multiplier comes from a named source you can audit.
- The math is reproducible by hand on a calculator.

This makes the engine **defensible to a physician's CPA** — they can trace exactly how their input becomes the output, with no black box.

## Conventions

- All CSVs have a `_default` row as a fallback for any key not explicitly listed.
- Numbers are dimensionless multipliers unless the column header says otherwise (e.g., `medianHouseholdIncome` is in USD).
- The `BASE_MULTIPLIER_ANCHORS` table is interpreted as a piecewise-linear curve interpolated by the engine — values between anchors are computed at runtime.
- The `SPECIALTY_PAYER_DEFAULTS` percentages should sum to ~100 per row; the engine normalizes if they don't.
