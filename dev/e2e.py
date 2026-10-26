"""End-to-end browser test: real site + real backend code (on in-memory Google fakes) via the local dev server.
Usage: python3 dev/e2e.py [screenshot_dir]"""
import json, os, subprocess, sys, time, urllib.request, io
from playwright.sync_api import sync_playwright, expect
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dev', 'shots')
os.makedirs(SHOTS, exist_ok=True)
PORT = 5191
BASE = f'http://localhost:{PORT}'
DRIVE = 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing'

# A believable "payment screenshot" so previews look real.
img = Image.new('RGB', (900, 1500), '#F4F6FA')
d = ImageDraw.Draw(img)
d.rectangle([0, 0, 900, 220], fill='#5F259F')
d.text((60, 90), 'Payment successful', fill='white')
d.text((60, 330), 'Rs 7,000.00', fill='#111')
d.text((60, 420), 'To: bcp.studio@okhdfc', fill='#333')
d.text((60, 480), 'UTR: ...01234', fill='#333')
png_path = os.path.join(SHOTS, '_proof.png'); img.save(png_path)
bad_path = os.path.join(SHOTS, '_not_an_image.png'); open(bad_path, 'wb').write(b'this is not really an image' * 40)

def get(path):
    return json.loads(urllib.request.urlopen(BASE + path).read())

srv = subprocess.Popen(['node', 'dev/server.js', str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL)
for _ in range(50):
    try: urllib.request.urlopen(BASE + '/config.js'); break
    except Exception: time.sleep(0.1)

problems = []
passed = 0
def ok(msg):
    global passed; passed += 1; print('  ✓', msg)

def watch(page, label, ignore=()):
    page.on('console', lambda m: problems.append(f'[{label}] console {m.type}: {m.text}') if m.type in ('error',) and not any(i in m.text for i in ignore) else None)
    page.on('pageerror', lambda e: problems.append(f'[{label}] pageerror: {e}'))
    page.on('requestfailed', lambda r: problems.append(f'[{label}] requestfailed: {r.url}') if not any(i in r.url for i in ignore) else None)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()

        # ───────────── Customer (mobile) ─────────────
        print('Customer screen — mobile')
        mob = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        cust = mob.new_page(); watch(cust, 'customer')
        cust.goto(f'{BASE}/?ref=BCP-2026-0148')
        expect(cust.get_by_role('heading', level=1)).to_have_text('Your Photos Are Almost Ready!')
        expect(cust.locator('#f-ref')).to_have_value('BCP-2026-0148')
        cust.screenshot(path=f'{SHOTS}/01-customer-lookup.png', full_page=True); ok('lookup form shown, reference prefilled from link')

        cust.get_by_role('button', name='View my photos & payment').click()
        expect(cust.locator('#f-phone-err')).to_contain_text('10-digit phone'); ok('empty phone is rejected with a helpful message')
        cust.fill('#f-phone', '99999 00000'); cust.get_by_role('button', name='View my photos & payment').click()
        expect(cust.get_by_role('alert').filter(has_text="couldn't find an order")).to_be_visible(); ok('wrong phone gives a generic not-found error')
        cust.fill('#f-phone', '98765 43210'); cust.get_by_role('button', name='View my photos & payment').click()
        expect(cust.get_by_text('Payment proof not submitted')).to_be_visible()
        body = cust.inner_text('body')
        for want in ['Priya Raman', 'Baby Shoot', '12 Oct 2026', '₹12,000', '₹5,000', '₹7,000', 'BCP-2026-0148']:
            assert want in body, f'missing {want!r}'
        ok('event details + payment summary rendered with real order data')
        expect(cust.locator('.qr-image img')).to_be_visible()
        assert cust.eval_on_selector('.qr-image img', 'i => i.complete && i.naturalWidth > 0'); ok('brand UPI QR image shown')
        assert cust.eval_on_selector('.brand-logo', 'i => i.complete && i.naturalWidth > 0'); assert cust.eval_on_selector('.hero-art', 'i => i.complete && i.naturalWidth > 0'); ok('brand logo and caricature load')
        expect(cust.get_by_role('link', name='Open UPI app')).to_be_visible(); ok('"Open UPI app" shown on touch devices')
        href = cust.get_by_role('link', name='Open UPI app').get_attribute('href')
        assert href.startswith('upi://pay?pa=7094295334%40okbizaxis') and 'am=7000.00' in href and 'tn=BCP-2026-0148' in href, href
        ok('UPI link carries the payee, exact balance and order reference')
        assert 'drive.google.com' not in cust.content(); ok('Drive link is not in the page before approval')
        cust.screenshot(path=f'{SHOTS}/02-customer-notsubmitted.png', full_page=True)

        cust.get_by_role('button', name='Submit Payment Proof').click()
        expect(cust.locator('#f-utr-err')).to_contain_text('Enter the last 5 digits')
        expect(cust.locator('#f-shot-err')).to_contain_text('upload a screenshot'); ok('submit blocked without UTR and screenshot')
        cust.fill('#f-utr', '426288001234'); cust.get_by_role('button', name='Submit Payment Proof').click()
        expect(cust.locator('#f-utr-err')).to_contain_text('only the last 5 digits'); ok('a full-length UTR is rejected — only the last 5 digits are accepted')
        cust.set_input_files('#f-shot', bad_path)
        expect(cust.locator('#f-shot-err')).to_contain_text('couldn’t read that image'); ok('non-image file rejected')
        cust.set_input_files('#f-shot', png_path)
        expect(cust.get_by_text('Screenshot ready')).to_be_visible(); ok('screenshot accepted and previewed')
        cust.fill('#f-utr', '01 234')
        cust.screenshot(path=f'{SHOTS}/03-customer-ready-to-submit.png', full_page=True)
        cust.get_by_role('button', name='Submit Payment Proof').click()
        expect(cust.get_by_text('Payment verification pending').first).to_be_visible()
        expect(cust.get_by_text('Your payment proof has been submitted. We will notify you once it is verified.')).to_be_visible()
        expect(cust.locator('.pay')).to_have_count(0); ok('proof submitted → status switches to pending on the same screen, payment form gone')
        cust.screenshot(path=f'{SHOTS}/04-customer-pending.png', full_page=True)
        row = get('/__test/order?ref=BCP-2026-0148')
        assert row['Status'] == 'PENDING' and row['UTR'] == '01234' and row['ProofFileId'] and row['OwnerEmailStatus'].startswith('sent'), row
        assert get('/__test/mail')[0]['subject'].startswith('Payment proof submitted'); ok('backend stored proof and the owner email was sent')

        # ───────────── Admin (desktop) ─────────────
        print('Admin screen — desktop')
        desk = b.new_context(viewport={'width': 1360, 'height': 900})
        adm = desk.new_page(); watch(adm, 'admin', ignore=('accounts.google.com', 'ERR_TUNNEL_CONNECTION_FAILED'))
        adm.goto(f'{BASE}/#/admin')
        expect(adm.get_by_text('Signed out')).to_be_visible()
        adm.screenshot(path=f'{SHOTS}/05-admin-signed-out.png'); ok('admin screen is gated when signed out')
        jwt = get('/__test/admin-jwt')['jwt']
        adm.evaluate('t => sessionStorage.setItem("bcp.admin.idt", t)', jwt)
        adm.reload()
        expect(adm.get_by_role('heading', name='Payment Review')).to_be_visible()
        expect(adm.locator('.pill-count')).to_contain_text('1 pending submission'); ok('signed-in admin sees the pending count')
        expect(adm.locator('.session-chip')).to_contain_text('owner@example.com')
        expect(adm.locator('.shot-btn img')).to_be_visible(timeout=10000); ok('uploaded screenshot preview loads for the admin')
        for want in ['Priya Raman', 'BCP-2026-0148', '01234', '₹12,000', '₹7,000']:
            assert want in adm.inner_text('body'), want
        adm.screenshot(path=f'{SHOTS}/06-admin-review.png', full_page=True)

        adm.get_by_role('button', name='Approve Payment').click()
        expect(adm.locator('#a-verified-err')).to_contain_text('Confirm you verified'); expect(adm.locator('#a-drive-err')).to_contain_text('paste the Google Drive link')
        ok('approve blocked until verified + Drive link given')
        adm.fill('#a-drive', 'https://example.com/folders/abc'); adm.get_by_role('button', name='Approve Payment').click()
        expect(adm.locator('#a-drive-err')).to_contain_text('doesn’t look like a Google Drive link'); ok('non-Drive URL rejected')
        adm.get_by_role('button', name='Reject / Request Correction').click()
        expect(adm.locator('#a-note-err')).to_contain_text('Add a short note'); ok('reject needs a note')

        # while the customer page is still open, approve from the admin
        adm.check('#a-verified'); adm.fill('#a-drive', DRIVE); adm.locator('#a-drive').blur()
        expect(adm.locator('.drive-status')).to_contain_text('Couldn’t check sharing')
        adm.fill('#a-note', 'Thanks for the quick payment!')
        adm.get_by_role('button', name='Approve Payment').click()
        expect(adm.get_by_text('Payment complete.')).to_be_visible(); ok('approval succeeds and shows a clear success message')
        expect(adm.locator('.tab.is-active')).to_contain_text('Approved')
        expect(adm.locator('.pill-count')).to_contain_text('0 pending submissions')
        notif = adm.locator('.notif-list').inner_text()
        assert notif.count('Email sent') == 2 and 'Not enabled' in notif, notif; ok('notification statuses show the real backend results (2 emails sent, WhatsApp not enabled)')
        adm.screenshot(path=f'{SHOTS}/07-admin-approved.png', full_page=True)

        # customer page that was already open picks the approval up without navigating
        cust.evaluate('document.dispatchEvent(new Event("visibilitychange"))')
        expect(cust.get_by_text('Payment Verified', exact=True)).to_be_visible(timeout=8000)
        expect(cust.get_by_role('heading', level=1)).to_have_text('Your Photos Are Ready!')
        link = cust.get_by_role('link', name='View & Download Photos')
        assert link.get_attribute('href') == DRIVE and link.get_attribute('rel') == 'noopener noreferrer'
        ok('customer screen updates in place: green "Payment Verified" + "View & Download Photos" → approved Drive folder')
        assert '₹0' in cust.inner_text('body'); cust.screenshot(path=f'{SHOTS}/08-customer-approved.png', full_page=True)
        cust.reload(); expect(cust.get_by_role('link', name='View & Download Photos')).to_be_visible(); ok('approved state survives a reload (session token)')

        # ───────────── Rejection path ─────────────
        print('Rejection path')
        c2 = mob.new_page(); watch(c2, 'customer2')
        c2.goto(f'{BASE}/?ref=BCP-2026-0149')
        c2.fill('#f-phone', '9000000001'); c2.get_by_role('button', name='View my photos & payment').click()
        c2.set_input_files('#f-shot', png_path); c2.fill('#f-utr', '99999')
        c2.get_by_role('button', name='Submit Payment Proof').click()
        expect(c2.get_by_text('Payment verification pending').first).to_be_visible()
        adm.reload()
        expect(adm.locator('.pill-count')).to_contain_text('1 pending submission')
        adm.get_by_role('button', name='Pending').click()
        expect(adm.locator('.detail-name')).to_have_text('Arun Kumar')
        adm.fill('#a-note', 'Amount received is ₹2,500 only. Please pay the full balance of ₹5,500.')
        adm.get_by_role('button', name='Reject / Request Correction').click()
        expect(adm.get_by_text('Sent back for correction.')).to_be_visible(); ok('rejection saved with note; link stays hidden')
        c2.reload()
        expect(c2.get_by_text('Payment verification needs correction')).to_be_visible()
        expect(c2.locator('.review-note')).to_contain_text('₹5,500')
        expect(c2.get_by_role('button', name='Submit Payment Proof')).to_be_visible()
        assert 'drive.google.com' not in c2.content(); ok('customer sees the admin note and can re-upload; no download button')
        c2.screenshot(path=f'{SHOTS}/09-customer-needs-correction.png', full_page=True)
        c2.set_input_files('#f-shot', png_path); c2.fill('#f-utr', '77777')
        c2.get_by_role('button', name='Submit Payment Proof').click()
        expect(c2.get_by_text('Payment verification pending').first).to_be_visible(); ok('re-upload after rejection returns the order to pending')

        # ───────────── Already-paid order & guards ─────────────
        c3 = mob.new_page(); watch(c3, 'customer3')
        c3.goto(f'{BASE}/?ref=BCP-2026-0150'); c3.fill('#f-phone', '9000000002'); c3.get_by_role('button', name='View my photos & payment').click()
        expect(c3.get_by_text('No payment due')).to_be_visible(); expect(c3.locator('.pay')).to_have_count(0); ok('fully paid order shows no payment form')
        c3.screenshot(path=f'{SHOTS}/10-customer-nodue.png', full_page=True)

        # ───────────── Full / custom payment ─────────────
        print('Custom amount, part payment, then final payment')
        c4 = mob.new_page(); watch(c4, 'customer4')
        c4.goto(f'{BASE}/?ref=BCP-2026-0152'); c4.fill('#f-phone', '9000000004'); c4.get_by_role('button', name='View my photos & payment').click()
        expect(c4.locator('#pm-full')).to_be_checked(); expect(c4.locator('.pay-amount strong')).to_have_text('₹10,000')
        expect(c4.locator('#f-amount')).to_be_hidden(); ok('payment card offers "Pay full balance" (default) and "Pay a custom amount"')
        c4.locator('label[for=pm-custom]').click()
        expect(c4.locator('#f-amount')).to_be_visible()
        c4.set_input_files('#f-shot', png_path); c4.fill('#f-utr', '12121')
        c4.get_by_role('button', name='Submit Payment Proof').click()
        expect(c4.locator('#f-amount-err')).to_contain_text('Enter the amount you are paying now'); ok('custom amount is required')
        c4.fill('#f-amount', '15000'); c4.get_by_role('button', name='Submit Payment Proof').click()
        expect(c4.locator('#f-amount-err')).to_contain_text('cannot be more than the balance'); ok('custom amount cannot exceed the balance')
        c4.fill('#f-amount', 'abc'); c4.get_by_role('button', name='Submit Payment Proof').click()
        expect(c4.locator('#f-amount-err')).to_contain_text('valid amount'); ok('non-numeric amount rejected')
        c4.fill('#f-amount', '4000')
        expect(c4.locator('.pay-amount strong')).to_have_text('₹4,000')
        href = c4.locator('.upi-open').get_attribute('href'); assert 'am=4000.00' in href, href
        expect(c4.locator('.submit-note')).to_contain_text('₹4,000'); ok('chosen amount flows into the amount shown and the "Open UPI app" link')
        c4.screenshot(path=f'{SHOTS}/12-customer-custom-amount.png', full_page=True)
        c4.get_by_role('button', name='Submit Payment Proof').click()
        expect(c4.get_by_text('Payment verification pending').first).to_be_visible()
        expect(c4.get_by_text('Amount you paid')).to_be_visible(); expect(c4.locator('.status')).to_contain_text('₹4,000')
        ok('custom payment submitted; pending shows the amount the customer reported')
        assert get('/__test/order?ref=BCP-2026-0152')['PaymentAmount'] == 4000

        adm.reload()
        adm.get_by_role('button', name='Pending').click()
        adm.locator('.queue-item', has_text='BCP-2026-0152').click()
        expect(adm.locator('.detail-name')).to_have_text('Divya Menon')
        expect(adm.locator('#a-amount')).to_have_value('4000'); expect(adm.locator('.outcome')).to_contain_text('Balance after approval: ₹6,000')
        ok('admin sees the amount the customer reported and what approving will leave as balance')
        adm.check('#a-verified')
        adm.fill('#a-amount', '99999'); adm.get_by_role('button', name='Approve Payment').click()
        expect(adm.locator('#a-amount-err')).to_contain_text('more than the balance'); ok('admin cannot record more than the balance')
        adm.fill('#a-amount', '4000')
        adm.get_by_role('button', name='Approve Payment').click()
        expect(adm.get_by_text('Partial payment recorded.')).to_be_visible()
        expect(adm.locator('.tab.is-active')).to_contain_text('Part paid')
        expect(adm.locator('.flash')).to_contain_text('balance ₹6,000'); ok('partial approval needs no Drive link and lands in the "Part paid" tab')
        adm.screenshot(path=f'{SHOTS}/13-admin-part-paid.png', full_page=True)
        row = get('/__test/order?ref=BCP-2026-0152')
        assert row['Status'] == 'PARTIALLY_PAID' and row['Paid'] == 4000 and row['Total'] == 10000, row

        c4.evaluate('document.dispatchEvent(new Event("visibilitychange"))'); c4.reload()
        expect(c4.get_by_text('Partial payment received')).to_be_visible()
        expect(c4.get_by_role('heading', name='Pay the remaining ₹6,000 to unlock your photos')).to_be_visible()
        assert 'drive.google.com' not in c4.content(); expect(c4.get_by_role('link', name='View & Download Photos')).to_have_count(0)
        expect(c4.locator('.summary').first).to_contain_text('₹4,000'); expect(c4.locator('.summary-balance')).to_contain_text('₹6,000')
        hist = c4.locator('.history'); expect(hist).to_contain_text('₹4,000'); expect(hist).to_contain_text('UTR …12121'); expect(hist).to_contain_text('Verified')
        ok('customer sees a payment history with the verified ₹4,000 and its last-5 UTR digits')
        ok('customer sees paid ₹4,000 / balance ₹6,000, no download button, and can pay again')
        c4.screenshot(path=f'{SHOTS}/14-customer-part-paid.png', full_page=True)
        expect(c4.locator('.pay-amount strong')).to_have_text('₹6,000')
        c4.set_input_files('#f-shot', png_path); c4.fill('#f-utr', '34343')
        c4.get_by_role('button', name='Submit Payment Proof').click()
        expect(c4.locator('.status')).to_contain_text('₹6,000'); expect(c4.get_by_text('Payment verification pending').first).to_be_visible()

        adm.reload(); adm.get_by_role('button', name='Pending').click()
        adm.locator('.queue-item', has_text='BCP-2026-0152').click()
        expect(adm.locator('.outcome')).to_contain_text('completes the payment')
        adm.check('#a-verified'); adm.get_by_role('button', name='Approve Payment').click()
        expect(adm.locator('#a-drive-err')).to_contain_text('completes the payment'); ok('the approval that completes the payment requires the Drive link')
        adm.fill('#a-drive', DRIVE); adm.get_by_role('button', name='Approve Payment').click()  # clicked straight away: the sharing check must not make the button jump
        expect(adm.get_by_text('Payment complete.')).to_be_visible()
        c4.reload()
        expect(c4.get_by_text('Payment Verified', exact=True)).to_be_visible()
        link = c4.get_by_role('link', name='View & Download Photos'); assert link.get_attribute('href') == DRIVE
        expect(c4.locator('.history')).to_contain_text('UTR …34343'); expect(c4.locator('.history-row')).to_have_count(2)
        expect(c4.locator('.summary-balance')).to_contain_text('₹0'); ok('final payment verified → photos unlock and balance shows ₹0')
        row = get('/__test/order?ref=BCP-2026-0152'); assert row['Status'] == 'APPROVED' and row['Paid'] == 10000, row
        c4.screenshot(path=f'{SHOTS}/15-customer-paid-in-full.png', full_page=True)

        # Desktop customer layout
        dc = desk.new_page(); watch(dc, 'customer-desktop')
        dc.goto(f'{BASE}/?ref=BCP-2026-0149'); dc.fill('#f-phone', '9000000001'); dc.get_by_role('button', name='View my photos & payment').click()
        expect(dc.get_by_text('Payment verification pending').first).to_be_visible()
        dc.screenshot(path=f'{SHOTS}/11-customer-desktop.png', full_page=True)
        # fallback: without QR_IMAGE the page generates a UPI QR from UPI_ID with the amount
        fb = mob.new_page(); watch(fb, 'fallback')
        def strip_qr(route):
            r = route.fetch(); route.fulfill(response=r, body=r.text().replace('"QR_IMAGE":"assets/upi-qr.png"', '"QR_IMAGE":""'))
        fb.route('**/config.js', strip_qr)
        fb.goto(f'{BASE}/?ref=BCP-2026-0151'); fb.fill('#f-phone', '9000000003'); fb.get_by_role('button', name='View my photos & payment').click()
        expect(fb.locator('.qr svg')).to_be_visible(); ok('fallback: QR generated from UPI ID when no QR image is configured')
        b.close()
finally:
    srv.terminate()

print()
if problems:
    print('PROBLEMS:'); [print('  ', x) for x in problems]; sys.exit(1)
print(f'{passed} browser checks passed, no console errors, no CSP violations')
