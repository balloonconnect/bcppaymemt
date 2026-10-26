# BCP Photo Delivery Portal

Customers pay their balance by UPI, upload proof, and — once you approve it — get a button to their Google Drive photos.
Two screens only: **Customer** (`/`) and **Admin** (`/#/admin`).

```
Browser (Vercel static site)  ──POST──▶  Google Apps Script web app  ──▶  Google Sheet (orders)
                                                    │                      Drive folder (private payment screenshots)
                                                    └──▶ Resend (email)
```
The Drive photo link is stored in the sheet and **only returned by the API once the order is APPROVED**.

## One-time setup (~30 min)

### 1. Backend (Google Sheet + Apps Script)
1. Create a Google Sheet named **BCP Portal**. Open **Extensions → Apps Script**.
2. Replace `Code.gs` with `backend/Code.gs`. In Project Settings tick *Show appsscript.json* and replace it with `backend/appsscript.json`.
3. Run **`setupPortal`** once (Run button; approve permissions). It creates the `Orders` sheet, a private Drive folder for screenshots and a signing secret.
4. **Project Settings → Script properties**, add:

| Property | Value |
|---|---|
| `ADMIN_EMAILS` | your Google account(s), comma-separated |
| `GOOGLE_CLIENT_ID` | from step 3 below |
| `SITE_URL` | your Vercel URL, e.g. `https://bcp-photos.vercel.app` |
| `RESEND_API_KEY`, `MAIL_FROM`, `OWNER_EMAIL` | optional, for real emails (see step 4) |

5. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Copy the URL ending `/exec`. (After any later code change: Deploy → Manage deployments → edit → New version.)

### 2. Orders
Add one row per customer in `Orders`: `Reference` (e.g. `BCP-2026-0148`), `CustomerName`, `Phone`, `Email` (optional), `EventType`, `EventDate`, `Total`, `Paid`. Leave `Status` blank. Menu **BCP Portal → Add a demo order** makes a test row.
Customer link: `https://your-site/?ref=BCP-2026-0148` (they confirm with their phone number).
- The app never edits `Total`/`Paid`; on approval it shows the balance as cleared and records `VerifiedAmount`.
- Already paid in full? Set `Status` = `APPROVED` and paste `DriveUrl` in the sheet to release photos.
- **Full or custom payment:** the customer chooses to pay the full balance or a custom amount. When you approve, you confirm the amount actually received; `Paid` goes up by that amount. The order becomes `PARTIALLY_PAID` (photos stay locked, the customer can pay again) until `Paid` reaches `Total`, then `APPROVED` and the `DriveUrl` is released. Each verified payment is appended to the `PaymentLog` column. After updating the backend code, run **BCP Portal → Set up sheet & folders** once to add the new `PaymentAmount` and `PaymentLog` columns.

### 3. Admin Google sign-in
Google Cloud Console → *APIs & Services → Credentials → Create OAuth client ID → Web application*. Add your site URL (and `http://localhost:5173` for testing) under **Authorized JavaScript origins**. Copy the client ID into the Script property and `site/config.js`.

### 4. Email (optional but recommended)
Create a [Resend](https://resend.com) account and API key. With no domain, use `MAIL_FROM = onboarding@resend.dev` — it only delivers to your own Resend email, which is fine for owner alerts. To email customers, verify a domain in Resend. If email is not configured the admin screen says **Not set up** — it never fakes "sent". WhatsApp alerts are not connected (shown as *Not enabled*).

### 5. Site
Edit `site/config.js`: `API_URL` and `GOOGLE_CLIENT_ID` (the UPI ID, QR image, payee name and help WhatsApp number are already filled in). Brand files live in `site/assets/` — `upi-qr.png` is your QR (static, so customers enter the amount shown; the *Open UPI app* button on phones pre-fills it). Clear `QR_IMAGE` to show a generated QR with the amount built in instead. Deploy to Vercel (import the folder; `vercel.json` serves `site/` and sets security headers).

## Daily use
Customer submits → you get an email → open `/#/admin` → check the money in your bank/UPI app → paste the Drive folder link (shared "Anyone with the link → Viewer") → **Approve**. Their page updates by itself.

## Security notes
- Customers sign in with reference + phone; 5 wrong tries lock that reference for 15 minutes.
- Admin: Google ID token verified server-side + email allow-list. Screenshots live in a private Drive folder and are only served to the admin.
- Duplicate UTRs across orders are flagged on the admin screen.

## Local preview & tests
```
node dev/server.js          # http://localhost:5173 — real backend code on in-memory fakes, emails captured
node dev/test-backend.js    # 19 backend checks
python3 dev/e2e.py          # 42 browser checks (needs: pip install playwright pillow; playwright install chromium)
```
