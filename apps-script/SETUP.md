# Apps Script Backend Setup

One-time deploy. ~10 minutes.

## 1. Create the bound Sheet

1. Go to https://sheets.google.com → blank spreadsheet → name it **"MDCopia Operations"**.
2. Extensions → Apps Script. A new tab opens with `Code.gs` empty.
3. Replace the contents of the editor with the contents of `apps-script/Code.gs` from this repo.
4. Save (Ctrl/Cmd-S). Name the project **"MDCopia Backend"**.

## 2. Configure secrets

In the Apps Script editor: ⚙ Project Settings → **Script Properties** → Add Script Property. Add each of:

| Key | Value | Required |
|-----|-------|----------|
| `RESEND_API_KEY` | `re_...` from your Resend dashboard | Yes |
| `PARTNER_EMAIL_1` | First partner's email | Yes |
| `PARTNER_EMAIL_2` | Second partner's email | Optional |
| `SELLER_FROM_EMAIL` | e.g. `sales@mdcopia.com` (must be verified in Resend) | Yes |
| `SHEET_ID` | Leave blank (script uses the bound Sheet automatically) | Optional |

## 3. Initialize the Sheet tabs

In the Apps Script editor:

1. Select function dropdown → `setupSheets`.
2. Click **Run**. Authorize the script when prompted (it needs Sheet + UrlFetch access).
3. Switch back to the Sheet — you should see four tabs: `Seller Leads`, `Buyer Inquiries`, `Transactions`, `Buyer Email Drafts`, each with bold header rows.
4. Run `setupManualTab` once. It builds a `Manual` tab in the Sheet documenting every column on every other tab — who writes it (script/Stripe/hand), whether it's safe to edit, and what each value means. Re-run any time `HEADERS` in `Code.gs` changes.

## 4. Deploy as a Web App

1. Click **Deploy** → **New deployment**.
2. Select type: **Web app**.
3. Description: `v1`.
4. Execute as: **Me**.
5. Who has access: **Anyone**.
6. Click **Deploy**, authorize again when prompted.
7. **Copy the Web app URL.** It looks like `https://script.google.com/macros/s/AKfy.../exec`.

## 5. Wire the site

Open `js/api.js` and paste the URL into the `APPS_SCRIPT_URL` constant:

```js
export const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfy.../exec';
```

Commit + push.

## 6. Smoke test

From the browser console on any site page (or from `engine.test.html` after wiring):

```js
import('./js/verify.js').then(m => m.requestCode('you@example.com'));
```

Then check the `Seller Leads` tab — note: `send_verification` requires an existing seller row, so submit through the form first, or insert a test row manually with your email in the `Email` column.

## NPPES API proxy (automatic, no extra config)

The deployed web app exposes an `api_proxy` route at the same URL that the engine uses to fetch the NPPES NPI Registry from a browser (NPPES doesn't send CORS headers, so direct browser fetch is blocked). The proxy is:

- **Stateless** — no Sheet writes, no logging
- **Whitelisted** — only allows requests to `npiregistry.cms.hhs.gov` and `data.cms.gov`
- **Automatic** — `js/engine.js` routes through the proxy whenever `APPS_SCRIPT_URL` is configured in `js/api.js`. In Node (smoke tests) it goes direct.

Quick test once the web app is deployed:

```
https://script.google.com/macros/s/AKfy.../exec?action=api_proxy&url=https%3A%2F%2Fnpiregistry.cms.hhs.gov%2Fapi%2F%3Fversion%3D2.1%26number%3D1437151168
```

Should return `{"success":true,"status":200,"data":{...}}`.

## Stripe buyer infrastructure (one-time, ~10 minutes)

The script ships with a complete Stripe pipeline: invoice creation, webhook receipt, refund handling, Lead Credits, and bulk orders. Activate it once and it runs hands-off.

### 1. Create the Stripe account and configure

Per the Stripe section in your engagement notes:
1. Sign up at https://dashboard.stripe.com/register, complete business verification.
2. Settings → Branding (logo + royal blue + gold).
3. Settings → Invoice template, set default footer to: *"Payment of this invoice constitutes Buyer's binding acceptance of the MDCopia Buyer Agreement (www.mdcopia.com/buyer-agreement.html). Lead refund or non-expiring Lead Credit per §9 of the Buyer Agreement."*
4. Settings → Payment methods → enable Cards (auto) + ACH Direct Debit.
5. Products → create product `MDCopia Lead`, $1,000 USD, one-time. (Optional; the script also creates ad-hoc invoiceitems without a stored product.)

### 2. Add Stripe secrets to Script Properties

Apps Script editor → Project Settings → Script Properties:

| Key | Value | Required |
|---|---|---|
| `STRIPE_API_KEY` | Restricted key with **Invoices: write** + **Customers: write** + **Customers: search**. Get from Stripe Dashboard → Developers → API keys → Create restricted key. | Yes |
| `STRIPE_WEBHOOK_TOKEN` | A random ~32-char string you generate (e.g., `openssl rand -hex 16`). This is your shared secret for webhook auth. | Yes |

### 3. Register the webhook URL in Stripe

Stripe Dashboard → Developers → Webhooks → **Add endpoint**:

- **Endpoint URL:**
  ```
  <YOUR_APPS_SCRIPT_URL>?action=stripe_webhook&token=<YOUR_STRIPE_WEBHOOK_TOKEN>
  ```
  Replace both placeholders with your actual values.
- **Events to send:**
  - `invoice.created`
  - `invoice.paid`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
  - `charge.refunded`
  - `customer.created`
- Save. Stripe will send a test event; the dashboard should show `200 OK`.

### 4. Bootstrap the Lead Credits tab

Apps Script editor → function dropdown → `setupBuyerInfrastructure` → Run. Authorize if prompted. Switch to your Sheet — you should see a new `Lead Credits` tab with a frozen, gold-tinted header row.

### 5. Verify

In the Stripe dashboard, create a test invoice for a fake customer (use Stripe test mode if you want zero-risk testing). When you mark it paid, you should see:
- A new row in the `Transactions` tab with `inv:in_xxx · amount:$1000.00 · lead`
- An email to your partner addresses titled "MDCopia: Buyer invoice paid"

### Sending a real invoice from the script

Two admin functions are available in the editor for ad-hoc use:

- `createBuyerInvoice('buyer@firm.com', 'L-20260501-XXXXXX-NNNN', 'Gulf Coast Family Medicine - Pensacola FL')` — single-lead invoice. Auto-emails the buyer with the hosted invoice link.
- `createBulkInvoice('buyer@firm.com', ['L-...', 'L-...', 'L-...'], 1000, 15, 'TX Cardiology bundle')` — multi-lead invoice with optional volume discount (last two args: per-lead price USD, discount %).

Both write the invoice ID into the `Notes` column of the `Transactions` tab. The webhook then auto-updates `Outcome` and `Close Price` when payment lands.

### Lead Credits

When a refund is processed in Stripe (Refunds → Issue refund), the `charge.refunded` webhook auto-creates a Lead Credit row. To issue a credit manually (e.g., as a goodwill gesture):

```
issueLeadCredit('buyer@firm.com', 1000, 'Goodwill credit per Buyer Agreement §9');
```

To check a buyer's balance before invoicing them again:

```
Logger.log(getBuyerCreditBalance('buyer@firm.com'));
```

To redeem credits against a new invoice (call after creating the invoice in Stripe; pass the invoice ID):

```
applyLeadCredit('buyer@firm.com', 1000, 'in_1AbC...');
```

### Note on Stripe-Signature header

Apps Script's `doPost` cannot read HTTP request headers, so the canonical Stripe-Signature HMAC verification isn't available. We use a shared-secret query token instead. This is secure as long as `STRIPE_WEBHOOK_TOKEN` stays in Script Properties (never committed). For higher assurance, place a Cloudflare Worker between Stripe and the Apps Script endpoint that performs the canonical verification and forwards the verified payload — about a 30-minute build when warranted.

## Updating the deployment

When you change `Code.gs`:

1. Paste the new code into the Apps Script editor.
2. **Deploy → Manage deployments** → pencil icon on the existing deployment → Version: **New version** → **Deploy**.
3. The web app URL stays the same. No site changes needed.

## Sending a buyer lead

Two paths. Both end in the same place — a row in `Buyer Email Drafts`, a sent Resend email, and a `Transactions` row.

### Recommended: auto-populate from a Lead ID

1. In the `Apps Script editor`, run `prepBuyerDraft` in the editor by adding a temporary wrapper:
   ```js
   function draftRow() {
     prepBuyerDraft('L-20260503-XXXXXX-NNNN', 'buyer@firm.com', 'Jane Doe', 'Acme Capital');
   }
   ```
   Save, select `draftRow` from the dropdown, click Run. The function looks up the Seller Leads row by `Lead ID`, copies practice name / city / state / specialty / valuation range into a fresh `Buyer Email Drafts` row, and seeds a templated subject + body. It logs the new row number.
2. Open the `Buyer Email Drafts` tab and review the seeded subject and body — edit anything you want to personalize.
3. Run `sendBuyerEmail(<rowNumber>)` (using the same wrapper trick — `function sendRow() { sendBuyerEmail(N); }`).
4. The script:
   - Sends the email via Resend from `SELLER_FROM_EMAIL` (e.g. `sales@mdcopia.com`).
   - Stamps `Sent = TRUE` and `Sent Date`.
   - Appends a `Transactions` row with the `Lead ID` populated (so the row ties back to Seller Leads).
   - Stamps `Buyer Matched` on the Seller Leads row (`Buyer Org <buyer@firm.com>`; appended with `;` if the seller already had matches).

### Hand-fill an entire row

Skip `prepBuyerDraft` and fill all 14 columns of a `Buyer Email Drafts` row yourself, then run `sendBuyerEmail(<rowNumber>)`. The Lead ID column is optional — leave it blank and the script skips the Transactions / Buyer Matched write-backs.

## Troubleshooting

- **"Resend not configured" in logs:** `RESEND_API_KEY` script property is missing.
- **CORS errors in browser console:** Re-deploy as a new version with "Anyone" access. Make sure the site is using POST with `application/x-www-form-urlencoded` (already handled by `js/api.js`).
- **`Lead not found` on verification:** The seller hasn't completed `seller_submit` first — verification requires an existing row in `Seller Leads` matched by email.
