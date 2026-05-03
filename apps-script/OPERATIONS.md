# MDCopia Operations Runbook

Step-by-step procedures for every recurring business workflow. Read top-to-bottom on first run, then jump to the workflow you need.

For one-time deployment (Sheet creation, Apps Script paste-in, Stripe wiring, Resend setup), see [SETUP.md](SETUP.md). This file picks up where SETUP ends — it's about the day-to-day.

> **How most admin actions are triggered**: open the bound Google Sheet → click **MDCopia** in the menu bar (next to Help) → pick the menu item. The custom menu is installed by the `onOpen()` trigger; if you don't see it, reload the Sheet once. Apps Script's editor "Run" button does not pass arguments, so functions like `prepBuyerDraft(leadId, …)` will fail if launched from the editor dropdown — always use the menu.

---

## Workflows

### 1. A new seller submits the valuation form

**What's automated** (zero action required):
- Engine computes the valuation in the seller's browser via `compute_valuation`.
- `seller_submit` appends a row to **Seller Leads** with `Status = 'Consent Acknowledged - Pending Verification'` (when the inline Terms checkbox was checked).
- A partner-notification email goes to `PARTNER_EMAIL_1`/`PARTNER_EMAIL_2` (Script Properties).
- The seller is redirected to `/verify.html` and emailed a 6-digit code.
- When they enter the code, `verify_code` flips `Email Verified = TRUE`, `Consent Given = TRUE`, `Consent Date = now`, and `Status = 'Consented and Verified - In Marketplace'`.

**Your job**: nothing on the happy path. Glance at the partner notification email when it arrives.

**Watch out for**:
- If `Consent Given` stays FALSE after the seller clearly verified, the consent payload was likely lost (legacy rows from before commit `805752c`). Run **MDCopia → Backfill consent** once.
- If `Status` is stuck at `'Email Verified'` (verification done but no consent flag), same backfill applies.

---

### 2. Seller is locked out of email verification

Three failed code attempts triggers a soft lock. They'll see "Too many attempts. Please request a new code." but `send_verification` won't issue a new code until you reset their attempt count.

**Steps**:
1. **MDCopia → Reset stuck verification (by email)…**
2. Enter the seller's email.
3. The script clears `Verification Code`, `Code Expiry`, and `Code Attempts`.
4. Tell the seller to go back to `/verify.html` and request a new code.

---

### 3. Sending a lead to a buyer

This is the day-to-day "sales" motion. Recommended path uses the menu so you never type a function call.

**Prerequisites**:
- The buyer is in **Buyer Inquiries** with `Vetted = TRUE` and `Agreement Signed = TRUE`. If not, vet them first (see Workflow 4).
- The seller is in **Seller Leads** with `Consent Given = TRUE`. Sending leads where consent is FALSE violates the Buyer Agreement — don't do it.

**Steps**:
1. Open the **Seller Leads** tab and copy the `Lead ID` of the row you want to send (looks like `L-20260503-XXXXXX-NNNN`).
2. **MDCopia → Prep buyer draft from Lead ID…**
3. Paste the Lead ID. Enter buyer email, name, org when prompted.
4. The script appends a row to **Buyer Email Drafts** with all seller fields auto-filled and a templated subject + body, then jumps you there.
5. Review the seeded body. Edit anything you want personalized. Don't change `Lead ID` or the seller fields.
6. **MDCopia → Send drafted email (current row)** (you should already be on the right row from step 4; if not, click any cell in the row first).
7. Confirm the prompt. The script:
   - Sends via Resend from `SELLER_FROM_EMAIL` (e.g. `sales@mdcopia.com`).
   - Stamps `Sent = TRUE` and `Sent Date`.
   - Appends a row to **Transactions** with `Lead ID`, `Buyer ID`, `Date Matched`, `Valuation Range Low/High`, `Outcome = 'Lead Sent'`.
   - Stamps `Buyer Matched` on the Seller Leads row (`Acme Capital <buyer@firm.com>`; semicolon-appended if there were prior matches).

**Then send a Stripe invoice** (Workflow 5).

**Common mistake**: prepping a draft from the editor's Run button instead of the Sheet menu. The editor button calls the function with no arguments → `Error: leadId required`. Use the menu.

---

### 4. A new buyer inquires (vetting)

Buyer inquiries arrive however you collect them today (email, LinkedIn, intake form). They are **not auto-populated** — the **Buyer Inquiries** tab is hand-filled.

**Steps**:
1. Open **Buyer Inquiries** and append a row. Fill in: Timestamp, Organization, Contact Name, Email, Phone, Org Type, target Specialties, Geography, Revenue Range, Message. Set `Status = 'New'`, `Vetted = FALSE`, `Agreement Signed = FALSE`.
2. Run your standard buyer-vetting checks (background, fund size, prior track record). When done, set `Vetted = TRUE` and `Vetted Date = today`.
3. Send the Buyer Agreement (e-signed via your tool of choice). When countersigned, set `Agreement Signed = TRUE`.
4. The buyer is now eligible to receive leads (Workflow 3).

---

### 5. Sending a Stripe invoice for a lead

After a buyer has been emailed a lead, you invoice them. Today this is two functions in the editor (no menu yet — Stripe interactions are kept off the UI to avoid accidental clicks).

**Single-lead invoice** (most common):
1. Open the Apps Script editor.
2. Add a wrapper function near the top of `Code.gs`:
   ```js
   function invoiceOne() {
     createBuyerInvoice(
       'buyer@firm.com',
       'L-20260503-XXXXXX-NNNN',
       'Gulf Coast Family Medicine - Pensacola FL'
     );
   }
   ```
3. Save, select `invoiceOne` from the dropdown, click Run.
4. The function creates a Stripe invoice for $1,000 and emails the buyer the hosted invoice link. The Stripe invoice ID is written into the **Transactions** row's `Notes` column.

**Bulk / volume-discount invoice**:
```js
function invoiceBundle() {
  createBulkInvoice(
    'buyer@firm.com',
    ['L-...', 'L-...', 'L-...'],
    1000,                       // per-lead price USD
    15,                         // discount %
    'TX Cardiology bundle'
  );
}
```

**What happens after the buyer pays**: the Stripe webhook fires automatically (no action from you):
- `invoice.paid` updates **Transactions** row's `Outcome = 'Closed'`, `Close Price = amount`, `Notes` appended with `inv:in_xxx · amount:$… · paid`.
- A partner notification email goes out: "MDCopia: Buyer invoice paid".

---

### 6. A deal closes (or doesn't)

Three terminal outcomes per Transactions row. Stripe handles two of them automatically; the third is manual.

| Outcome | How it gets set |
|---|---|
| Closed (paid) | Stripe webhook on `invoice.paid` → `Outcome = 'Closed'`, `Close Price` filled. |
| Refunded | Stripe webhook on `charge.refunded` → `Outcome = 'Refunded'`, Lead Credit row auto-issued (see Workflow 7). |
| No Deal | Hand-edit `Outcome = 'No Deal'` and add notes when the buyer formally walks. No Stripe action. |

For **Closed** rows, the **Seller Leads** row's `Buyer Matched` already has the buyer; manually fill `Lead Sold Date` and update `Status = 'Lead Sold'` for clean reporting.

The **12-Month Follow-Up Date** column is hand-set when you'd like a calendar reminder to check post-deal outcomes for engine calibration.

---

### 7. Lead Credits (refunds + goodwill)

Lead Credits exist so a buyer who refunds (or who you give a goodwill credit to) can apply that balance against a future invoice instead of getting cash back.

**Auto-issued on refund**: when you issue a refund in Stripe Dashboard, the `charge.refunded` webhook fires and a **Lead Credits** row is auto-created with `Buyer Email`, `Credit Amount USD`, `Issued Date`, `Reason = 'Stripe refund …'`, `Source Invoice = in_xxx`, `Status = 'Issued'`.

**Manually issued** (goodwill, dispute resolution):
```js
function giveCredit() {
  issueLeadCredit('buyer@firm.com', 1000, 'Goodwill credit per Buyer Agreement §9');
}
```

**Check a buyer's balance before invoicing**:
```js
function checkBalance() {
  Logger.log(getBuyerCreditBalance('buyer@firm.com'));
}
```

**Apply credit to a future invoice** (after creating the Stripe invoice):
```js
function redeem() {
  applyLeadCredit('buyer@firm.com', 1000, 'in_1AbC...');
}
```
This decrements `Remaining Balance` and stamps `Applied Date` / `Applied To Invoice`. When `Remaining Balance` hits 0, `Status` flips to `'Applied'`.

---

### 8. A seller wants to withdraw

Per Buyer Agreement §3 and Privacy Policy §6, the seller can withdraw at any time by emailing `sales@mdcopia.com`.

**Steps**:
1. In **Seller Leads**, find their row by Email.
2. Set `Status = 'Withdrawn'`. Add a note in `Methodology` or a new column if you want a paper trail.
3. If the lead was already sent to a buyer (`Buyer Matched` is non-empty and the corresponding **Transactions** row's `Outcome` is `'Lead Sent'` not `'Closed'`):
   - Email the buyer that the seller withdrew. Set the Transactions row's `Outcome = 'No Deal'` and `Notes` += `Seller withdrew on YYYY-MM-DD`.
   - If the buyer already paid, issue a refund in Stripe — the webhook will auto-create a Lead Credit. Or refund cash directly per your discretion.
4. Reply to the seller confirming the withdrawal.

The Sheet keeps the row for audit; do not delete it.

---

### 9. Periodic operations

**Weekly** (~5 min):
- Scan **Seller Leads** for any `Status = 'Email Verified'` rows where `Consent Given = FALSE`. If consent should clearly be TRUE, run **MDCopia → Backfill consent**.
- Scan **Transactions** for `Outcome = 'Pending'` or `'Lead Sent'` older than 14 days — chase the buyer for a status update.

**Monthly** (~15 min):
- Review **Lead Credits** for `Status = 'Issued'` balances older than 90 days. Reach out to those buyers with eligible inventory.
- Review **Buyer Inquiries** for `Status = 'New'` not yet vetted; either vet or close them.

**Quarterly**:
- Pull all **Transactions** with `12-Month Follow-Up Date` due that quarter; email the seller for outcome data (deal closed? at what price? deal-structure notes). Use this to calibrate the engine.

---

### 10. Schema or engine changes

Whenever you (or I, in a PR) update `HEADERS`, `MANUAL_ROWS`, or the engine tables in `Code.gs`:

1. **Paste the new `Code.gs`** into the Apps Script editor.
2. **Deploy → Manage deployments → pencil → New version → Deploy.** The web app URL stays the same.
3. **Reload the bound Google Sheet** (so the new `onOpen` runs and the menu refreshes).
4. **MDCopia → Re-run setupSheets** — adds any new columns (additive; existing data is preserved).
5. **MDCopia → Re-run setupManualTab** — refreshes the Manual tab from the new MANUAL_ROWS.

---

## When something looks wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `Consent Given` stays FALSE after verification | Legacy row from before consent-flag fix | MDCopia → Backfill consent |
| Seller can't get a verification code | Stuck attempts counter | MDCopia → Reset stuck verification |
| `prepBuyerDraft` errors with "leadId required" | Run from editor instead of menu | MDCopia → Prep buyer draft from Lead ID |
| `prepBuyerDraft` errors with "No Seller Leads row with Lead ID …" | Lead ID typo or whitespace | Copy directly from the Sheet cell |
| Transactions row has blank Lead ID | Drafts row didn't have Lead ID set when `sendBuyerEmail` ran | Hand-fill the Transactions row's Lead ID; use prep flow next time |
| Stripe webhook didn't update Transactions | Token mismatch or webhook not registered | Re-check `STRIPE_WEBHOOK_TOKEN` Script Property + the endpoint URL in Stripe Dashboard |
| "Resend not configured" in logs | `RESEND_API_KEY` Script Property missing | Add it; re-deploy |

For anything you can't trace from the table, open the Apps Script editor → Executions tab. Failed runs log a stack trace.
