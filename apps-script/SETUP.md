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

## Updating the deployment

When you change `Code.gs`:

1. Paste the new code into the Apps Script editor.
2. **Deploy → Manage deployments** → pencil icon on the existing deployment → Version: **New version** → **Deploy**.
3. The web app URL stays the same. No site changes needed.

## Sending a buyer lead manually

1. In the `Buyer Email Drafts` tab, fill in a row: Buyer Email, Buyer Name, seller fields, valuation low/high, Email Subject, Email Body.
2. In the Apps Script editor, run `sendBuyerEmail` with the row number — easiest via the editor's debugger:
   - Open `Code.gs` → temporarily change `function sendBuyerEmail(rowNumber)` invocation to a wrapper, e.g. add `function sendRow2() { sendBuyerEmail(2); }`, save, run `sendRow2`. Or use the **Editor URL** + `?function=sendBuyerEmail&row=2` flow if you prefer.
3. The row's `Sent` cell is set to TRUE and `Sent Date` is timestamped. A row is appended to `Transactions`.

## Troubleshooting

- **"Resend not configured" in logs:** `RESEND_API_KEY` script property is missing.
- **CORS errors in browser console:** Re-deploy as a new version with "Anyone" access. Make sure the site is using POST with `application/x-www-form-urlencoded` (already handled by `js/api.js`).
- **`Lead not found` on verification:** The seller hasn't completed `seller_submit` first — verification requires an existing row in `Seller Leads` matched by email.
