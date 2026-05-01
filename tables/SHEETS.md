# MDCopia Engine — Spreadsheet Reference

The valuation engine reads its lookup tables **live** from the bound
"MDCopia Operations" Google Sheet. Edit a cell in any `Tbl_*` tab and the
next valuation request (within 5 minutes) picks up your change. No code
deploy required.

## How to set this up (one-time, ~30 seconds)

After you've redeployed `Code.gs` once:

1. Open your Apps Script editor for `MDCopia Backend`.
2. In the function dropdown, select **`setupEngineTables`**.
3. Click **Run**. Authorize if prompted.
4. Switch back to your "MDCopia Operations" Sheet — you should see 9 new
   tabs alongside the original four:
   - `Tbl_SpecialtyMultiplier`
   - `Tbl_StateMarketFactor`
   - `Tbl_BaseMultiplierAnchors`
   - `Tbl_RealEstateFactor`
   - `Tbl_TimelineFactor`
   - `Tbl_PayerDefaults`
   - `Tbl_CpvBySpecialty`
   - `Tbl_TransactionMultiples`
   - `Tbl_StateDemographics`

Each tab opens with a bold royal-blue header row (frozen) and the current
engine values pre-populated.

## How updates flow

1. You edit a cell in a `Tbl_*` tab (e.g., bump `STATE_MARKET_FACTOR` for
   FL from 1.05 → 1.07 because GPCI shifted).
2. Within 5 minutes, the engine cache expires; the next valuation reads the
   new value automatically.
3. To take effect immediately, run **`invalidateEngineCache`** from the
   Apps Script editor — flushes the cache instantly.

## Fallback behavior

If the engine can't read a `Tbl_*` tab (someone deleted it, the Sheet is
locked, network blip during a UrlFetchApp call, etc.), it falls back to
the values compiled into `Code.gs`. **The engine never breaks because of a
Sheet edit.** The compiled defaults are always there as a safety net.

## What lives where

| Tab | Purpose | When to update |
|---|---|---|
| `Tbl_SpecialtyMultiplier` | Stage 3b — specialty premium/discount | Annually, or when transaction-multiple data shifts |
| `Tbl_StateMarketFactor` | Stage 3g — geographic market adjustment | Annually with new GPCI / cost-of-living data |
| `Tbl_BaseMultiplierAnchors` | Stage 3a — collections curve anchors (piecewise-linear) | Quarterly review; only update when anchors need re-calibration |
| `Tbl_RealEstateFactor` | Stage 3e | Rare |
| `Tbl_TimelineFactor` | Stage 3f | Rare |
| `Tbl_PayerDefaults` | Stage 3c — fallback payer mix when no NPI | Annually with new MGMA / AMA data |
| `Tbl_CpvBySpecialty` | Page-2 CPV reference + revenue/visit validity check | Annually |
| `Tbl_TransactionMultiples` | Calibration band (revenue-multiple low/high) | Semi-annually as new deal data lands |
| `Tbl_StateDemographics` | Page-2 demographic snapshot | Annually with new Census ACS release |

## CSV mirrors in this folder

The `tables/*.csv` files in this repo mirror what the tabs hold. They serve
two purposes:

1. **Reference**: a quick way to see the current production values without
   opening the Sheet.
2. **Recovery**: if you ever blow away a tab by accident, run
   `setupEngineTables()` again — it re-creates from the compiled-in
   defaults (which match these CSVs).

If you change a value in the Sheet, also update the corresponding CSV here
when convenient (so the repo stays in sync as documentation). It's not
required for the engine — the live Sheet is authoritative.

## The "modified times-table" approach

`WORKED_EXAMPLE.csv` walks one valuation step-by-step: each row is `previous_value × next_multiplier`, with the source named for every value. Drop it into a tab in the same Sheet (call it `Tbl_WorkedExample`) and you can replace the input cells (revenue, specialty, state) with formulas that reference the live `Tbl_*` tabs. You'll get a real-time, auditable view of the engine's math that matches what the API returns to within rounding.

This is the structure that makes the engine **defensible to a physician's CPA** — every cell is traceable.

## Conventions

- All tabs have a `_default` row as a fallback for any key not explicitly listed.
- Numbers are dimensionless multipliers unless the column header says otherwise (e.g., `medianHouseholdIncome` is in USD, `population` in persons, `age65PlusPct` in percentage points).
- `Tbl_BaseMultiplierAnchors` is interpreted as a piecewise-linear curve interpolated at runtime — values between rows are computed by the engine.
- `Tbl_PayerDefaults` percentages should sum to ~100 per row; the engine normalizes if they don't.

## Future: adding a new specialty or state

1. Add a new row in `Tbl_SpecialtyMultiplier` (or `Tbl_StateMarketFactor`, etc.).
2. Add the corresponding row to **every related tab** so the new key is found everywhere (`Tbl_PayerDefaults`, `Tbl_CpvBySpecialty`, `Tbl_TransactionMultiples` for a new specialty; `Tbl_StateDemographics` for a new state).
3. Add the option to the form dropdown in `valuation.html`.
4. (Optional) Add the matching constant in `Code.gs` ENGINE_TABLES so the fallback covers the new key too.
