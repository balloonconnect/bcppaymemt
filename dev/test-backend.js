'use strict';
const assert = require('assert');
const { createGas } = require('./mock-gas');

// 1×1-ish valid JPEG header padded to pass size/magic checks (content isn't decoded server-side).
const jpegBytes = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(2000, 7)]);
const IMG = { mime: 'image/jpeg', data: jpegBytes.toString('base64') };
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const future = String(Math.floor(Date.now() / 1000) + 3600);
const goodAdmin = { aud: CLIENT_ID, email: 'owner@example.com', email_verified: 'true', exp: future };
const otherUser = { aud: CLIENT_ID, email: 'stranger@example.com', email_verified: 'true', exp: future };
const wrongAud = { aud: 'someone-elses-client', email: 'owner@example.com', email_verified: 'true', exp: future };
const DRIVE = 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing';

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ✓', name); }

function fresh(extra = {}) {
  const g = createGas({
    props: Object.assign({ GOOGLE_CLIENT_ID: CLIENT_ID, ADMIN_EMAILS: 'Owner@Example.com', SITE_URL: 'https://portal.test', RESEND_API_KEY: 're_test', MAIL_FROM: 'BCP <photos@bcp.test>', OWNER_EMAIL: 'owner@example.com' }, extra.props),
    adminTokens: { GOOD: goodAdmin, OTHER: otherUser, WRONGAUD: wrongAud },
    driveSharing: extra.driveSharing, resendFail: extra.resendFail,
  });
  g.setup();
  g.addOrder({ Reference: 'BCP-2026-0148', CustomerName: 'Priya <b>Raman</b>', Phone: '98765 43210', Email: 'priya@example.com', EventType: 'Baby Shoot', EventDate: new Date('2026-10-12T00:00:00+05:30'), Total: 12000, Paid: 5000, Status: '', DriveUrl: DRIVE });
  g.addOrder({ Reference: 'BCP-2026-0149', CustomerName: 'Arun Kumar', Phone: '9000000001', Email: '', EventType: 'Housewarming', EventDate: '15 Oct 2026', Total: 8000, Paid: 8000, Status: 'NOT_SUBMITTED' });
  g.addOrder({ Reference: 'BCP-2026-0150', CustomerName: 'Meena S', Phone: '9000000002', Email: '', EventType: 'Birthday', EventDate: '20 Oct 2026', Total: 6000, Paid: 1000, Status: '' });
  return g;
}
const login = (g, ref = 'BCP-2026-0148', phone = '+91 98765-43210') => g.call({ action: 'lookup', ref, phone });

console.log('Customer lookup');
t('rejects wrong phone with a generic message', () => {
  const g = fresh();
  const r = g.call({ action: 'lookup', ref: 'BCP-2026-0148', phone: '9111111111' });
  assert.equal(r.ok, false); assert.equal(r.error, 'not_found');
});
t('locks the reference after 5 failures, even for the right phone', () => {
  const g = fresh();
  for (let i = 0; i < 5; i++) g.call({ action: 'lookup', ref: 'BCP-2026-0148', phone: '9111111111' });
  const r = login(g); assert.equal(r.error, 'locked');
});
t('accepts reference + phone in any common format', () => {
  const g = fresh();
  const r = login(g, ' bcp-2026-0148 ', '098765 43210');
  assert.equal(r.ok, true); assert.equal(r.data.order.status, 'NOT_SUBMITTED');
  assert.equal(r.data.order.balance, 7000); assert.equal(r.data.order.eventDate, '12 Oct 2026');
});
t('never returns the drive link before approval, even if the owner pre-filled it', () => {
  const g = fresh();
  const r = login(g); assert.equal(r.data.order.driveUrl, '');
  assert.ok(!JSON.stringify(r).includes('drive.google.com'));
});

console.log('Payment proof submission');
t('validates UTR and image', () => {
  const g = fresh(); const { token } = login(g).data;
  assert.equal(g.call({ action: 'submitProof', token, utr: '123', image: IMG }).error, 'invalid_utr');
  assert.equal(g.call({ action: 'submitProof', token, utr: '123456789012', image: { mime: 'image/gif', data: IMG.data } }).error, 'invalid_image');
  assert.equal(g.call({ action: 'submitProof', token, utr: '123456789012', image: { mime: 'image/jpeg', data: Buffer.alloc(3000, 1).toString('base64') } }).error, 'invalid_image');
  assert.equal(g.call({ action: 'submitProof', token, utr: '123456789012' }).error, 'invalid_image');
});
t('rejects tampered or foreign tokens', () => {
  const g = fresh(); const { token } = login(g).data;
  const bad = token.slice(0, -3) + 'AAA';
  assert.equal(g.call({ action: 'submitProof', token: bad, utr: '123456789012', image: IMG }).error, 'session_expired');
  assert.equal(g.call({ action: 'status', token: 'x.y' }).error, 'session_expired');
});
t('stores proof, goes PENDING, emails the owner (escaped) and records the real result', () => {
  const g = fresh(); const { token } = login(g).data;
  const r = g.call({ action: 'submitProof', token, utr: '4262 8800 1234', image: IMG });
  assert.equal(r.ok, true); assert.equal(r.data.order.status, 'PENDING'); assert.equal(r.data.order.utr, '426288001234');
  assert.equal(g.outbox.length, 1);
  const mail = g.outbox[0].payload;
  assert.deepEqual(mail.to, ['owner@example.com']);
  assert.ok(!mail.html.includes('<b>Raman</b>') && mail.html.includes('&lt;b&gt;Raman&lt;/b&gt;'), 'customer name must be HTML-escaped');
  const row = g.readOrder('BCP-2026-0148');
  assert.ok(row.OwnerEmailStatus.startsWith('sent'), row.OwnerEmailStatus);
  assert.equal(row.WhatsAppStatus, 'not_enabled');
  assert.ok(row.ProofFileId);
});
t('blocks a second submission while pending', () => {
  const g = fresh(); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG });
  assert.equal(g.call({ action: 'submitProof', token, utr: '426288001299', image: IMG }).error, 'already_pending');
});
t('reports email failure honestly instead of faking success', () => {
  const g = fresh({ resendFail: 422 }); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG });
  assert.ok(g.readOrder('BCP-2026-0148').OwnerEmailStatus.startsWith('failed: HTTP 422'));
});
t('reports "not_configured" when Resend is not set up', () => {
  const g = fresh({ props: { RESEND_API_KEY: '' } }); const { token } = login(g).data;
  const r = g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG });
  assert.equal(r.ok, true); assert.equal(g.readOrder('BCP-2026-0148').OwnerEmailStatus, 'not_configured');
});
t('refuses proof when nothing is due', () => {
  const g = fresh(); const { token } = login(g, 'BCP-2026-0149', '9000000001').data;
  assert.equal(g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG }).error, 'no_payment_due');
});

console.log('Admin access');
t('requires a valid token from an allow-listed admin for the right client', () => {
  const g = fresh();
  assert.equal(g.call({ action: 'admin.list' }).error, 'unauthorized');
  assert.equal(g.call({ action: 'admin.list', idToken: 'NOPE' }).error, 'unauthorized');
  assert.equal(g.call({ action: 'admin.list', idToken: 'OTHER' }).error, 'forbidden');
  assert.equal(g.call({ action: 'admin.list', idToken: 'WRONGAUD' }).error, 'unauthorized');
  assert.equal(g.call({ action: 'admin.list', idToken: 'GOOD' }).ok, true);
});
t('is closed when admin sign-in is not configured', () => {
  const g = fresh({ props: { ADMIN_EMAILS: '' } });
  assert.equal(g.call({ action: 'admin.list', idToken: 'GOOD' }).error, 'not_configured');
});
t('lists submissions with pending count, screenshot and duplicate-UTR flags', () => {
  const g = fresh();
  const a = login(g).data.token; const b = login(g, 'BCP-2026-0150', '9000000002').data.token;
  g.call({ action: 'submitProof', token: a, utr: 'SAMEUTR12345', image: IMG });
  g.call({ action: 'submitProof', token: b, utr: 'SAMEUTR12345', image: IMG });
  const r = g.call({ action: 'admin.list', idToken: 'GOOD' }).data;
  assert.equal(r.pendingCount, 2); assert.equal(r.admin, 'owner@example.com');
  assert.deepEqual(r.orders[0].duplicateUtrRefs, ['BCP-2026-0150']);
  assert.equal(r.orders[0].reference, 'BCP-2026-0148'); // oldest first
  const p = g.call({ action: 'admin.proof', idToken: 'GOOD', ref: 'BCP-2026-0148' });
  assert.equal(p.data.mime, 'image/jpeg'); assert.equal(Buffer.from(p.data.data, 'base64').length, jpegBytes.length);
  assert.equal(g.call({ action: 'admin.proof', ref: 'BCP-2026-0148' }).error, 'unauthorized');
});

console.log('Approve / reject');
t('approval needs verification + a real Google Drive link', () => {
  const g = fresh(); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG });
  const base = { action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0148', decision: 'approve' };
  assert.equal(g.call({ ...base, verified: false, driveUrl: DRIVE }).error, 'not_verified');
  assert.equal(g.call({ ...base, verified: true, driveUrl: 'https://evil.example.com/drive.google.com/folders/1AbCdEfGhIjKlMnOp' }).error, 'invalid_drive_url');
  assert.equal(g.call({ ...base, verified: true, driveUrl: 'javascript:alert(1)' }).error, 'invalid_drive_url');
  assert.equal(login(g).data.order.status, 'PENDING');
});
t('approval releases the link to the customer, clears the balance and emails them', () => {
  const g = fresh(); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG });
  const r = g.call({ action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0148', decision: 'approve', verified: true, driveUrl: ' ' + DRIVE + ' ', note: 'Thanks!' });
  assert.equal(r.ok, true); assert.equal(r.data.order.status, 'APPROVED'); assert.equal(r.data.order.verifiedAmount, 7000);
  const cust = g.call({ action: 'status', token }).data.order;
  assert.equal(cust.status, 'APPROVED'); assert.equal(cust.driveUrl, DRIVE); assert.equal(cust.balance, 0); assert.equal(cust.paid, 12000);
  assert.equal(g.outbox.length, 2); assert.deepEqual(g.outbox[1].payload.to, ['priya@example.com']);
  assert.ok(!g.outbox[1].payload.html.includes('drive.google.com'), 'email must not contain the drive link');
  assert.ok(g.readOrder('BCP-2026-0148').CustomerEmailStatus.startsWith('sent'));
  assert.equal(g.call({ action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0148', decision: 'reject', note: 'oops oops' }).error, 'not_pending');
});
t('drive sharing check reports public / restricted / unverified', () => {
  const g = fresh();
  assert.equal(g.call({ action: 'admin.checkDrive', idToken: 'GOOD', driveUrl: DRIVE }).data.share, 'unverified');
  const folder = g.ctx.DriveApp.createFolder('x'); const id = folder.getId();
  const url = 'https://drive.google.com/drive/folders/' + id;
  assert.equal(g.call({ action: 'admin.checkDrive', idToken: 'GOOD', driveUrl: url }).data.share, 'restricted');
  g.sharing[id] = 'ANYONE_WITH_LINK';
  assert.equal(g.call({ action: 'admin.checkDrive', idToken: 'GOOD', driveUrl: url }).data.share, 'public');
});
t('rejection keeps the link hidden, shows the note, and allows re-upload', () => {
  const g = fresh(); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG });
  assert.equal(g.call({ action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0148', decision: 'reject', note: 'ab' }).error, 'note_required');
  const r = g.call({ action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0148', decision: 'reject', note: 'Amount received is ₹5,000, please pay the full balance.' });
  assert.equal(r.data.order.status, 'NEEDS_CORRECTION');
  const cust = g.call({ action: 'status', token }).data.order;
  assert.equal(cust.status, 'NEEDS_CORRECTION'); assert.equal(cust.driveUrl, ''); assert.ok(cust.reviewNote.includes('₹5,000'));
  const again = g.call({ action: 'submitProof', token, utr: 'NEWUTR987654', image: IMG });
  assert.equal(again.ok, true); assert.equal(again.data.order.status, 'PENDING'); assert.equal(again.data.order.reviewNote, '');
});
t('never edits the Total column; Paid rises only by the verified amount', () => {
  const g = fresh(); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG, amount: 2000 });
  g.call({ action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0148', decision: 'approve', verified: true });
  const row = g.readOrder('BCP-2026-0148'); assert.equal(row.Paid, 7000); assert.equal(row.Total, 12000);
});

console.log('Full or custom payment');
const decide = (g, extra) => g.call({ action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0148', decision: 'approve', verified: true, ...extra });
t('a customer can pay a custom amount; the amount is validated', () => {
  const g = fresh(); const { token } = login(g).data;
  const sub = (amount) => g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG, amount });
  assert.equal(sub(0).error, 'invalid_amount'); assert.equal(sub(-5).error, 'invalid_amount');
  assert.equal(sub('abc').error, 'invalid_amount'); assert.equal(sub(10.123).error, 'invalid_amount');
  assert.equal(sub(7000.01).error, 'amount_too_high');
  const ok = sub(2000);
  assert.equal(ok.ok, true); assert.equal(ok.data.order.status, 'PENDING'); assert.equal(ok.data.order.claimedAmount, 2000);
  assert.equal(ok.data.order.balance, 7000, 'balance does not change until the owner verifies');
});
t('omitting the amount means the full balance', () => {
  const g = fresh(); const { token } = login(g).data;
  const r = g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG });
  assert.equal(r.data.order.claimedAmount, 7000);
});
t('a partial payment updates paid / balance but keeps the photos locked', () => {
  const g = fresh(); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG, amount: 2000 });
  const r = decide(g, { note: 'Received ₹2,000, thanks' });
  assert.equal(r.ok, true); assert.equal(r.data.order.status, 'PARTIALLY_PAID'); assert.equal(r.data.order.verifiedAmount, 2000);
  const cust = g.call({ action: 'status', token }).data.order;
  assert.equal(cust.status, 'PARTIALLY_PAID'); assert.equal(cust.paid, 7000); assert.equal(cust.balance, 5000);
  assert.equal(cust.driveUrl, '', 'link must stay hidden until fully paid');
  assert.ok(!JSON.stringify(cust).includes('drive.google.com'));
  assert.equal(cust.utr, ''); assert.equal(cust.reviewNote, 'Received ₹2,000, thanks');
  assert.ok(g.outbox[1].payload.subject.includes('balance'), 'customer gets a balance email');
  assert.ok(!g.outbox[1].payload.html.includes('drive.google.com'));
  assert.ok(g.readOrder('BCP-2026-0148').PaymentLog.includes('₹2,000'));
});
t('the customer can pay again after a partial payment; the final payment unlocks the photos', () => {
  const g = fresh(); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG, amount: 2000 });
  decide(g, {});
  const second = g.call({ action: 'submitProof', token, utr: 'SECONDUTR9999', image: IMG, amount: 5000 });
  assert.equal(second.ok, true); assert.equal(second.data.order.claimedAmount, 5000);
  assert.equal(g.call({ action: 'submitProof', token, utr: 'THIRDUTR99999', image: IMG, amount: 100 }).error, 'already_pending');
  const fin = decide(g, {});
  assert.equal(fin.data.order.status, 'APPROVED');
  const cust = g.call({ action: 'status', token }).data.order;
  assert.equal(cust.driveUrl, DRIVE); assert.equal(cust.balance, 0); assert.equal(cust.paid, 12000);
  assert.equal(g.readOrder('BCP-2026-0148').Paid, 12000);
  assert.equal(g.call({ action: 'submitProof', token, utr: 'FOURTHUTR9999', image: IMG }).error, 'already_approved');
});
t('the owner can correct the received amount; it cannot exceed the balance', () => {
  const g = fresh(); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG, amount: 3000 });
  assert.equal(decide(g, { verifiedAmount: 7000.5 }).error, 'amount_too_high');
  assert.equal(decide(g, { verifiedAmount: 0 }).error, 'invalid_amount');
  const r = decide(g, { verifiedAmount: 1500 });
  assert.equal(r.data.order.status, 'PARTIALLY_PAID'); assert.equal(r.data.order.paid, 6500); assert.equal(r.data.order.balance, 5500);
});
t('completing the payment needs a Drive link (from the sheet or the form)', () => {
  const g = fresh(); const t3 = login(g, 'BCP-2026-0150', '9000000002').data.token;
  g.call({ action: 'submitProof', token: t3, utr: '426288001234', image: IMG });
  const base = { action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0150', decision: 'approve', verified: true };
  assert.equal(g.call({ ...base, driveUrl: '' }).error, 'invalid_drive_url');
  const ok = g.call({ ...base, driveUrl: DRIVE });
  assert.equal(ok.data.order.status, 'APPROVED'); assert.equal(g.call({ action: 'status', token: t3 }).data.order.driveUrl, DRIVE);
});
t('a partial approval does not need a Drive link, and a rejected partial payment changes nothing', () => {
  const g = fresh(); const t3 = login(g, 'BCP-2026-0150', '9000000002').data.token;
  g.call({ action: 'submitProof', token: t3, utr: '426288001234', image: IMG, amount: 1000 });
  const r = g.call({ action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0150', decision: 'approve', verified: true, verifiedAmount: 1000 });
  assert.equal(r.data.order.status, 'PARTIALLY_PAID'); assert.equal(r.data.order.balance, 4000);
  g.call({ action: 'submitProof', token: t3, utr: 'ANOTHERUTR123', image: IMG, amount: 500 });
  const rej = g.call({ action: 'admin.decide', idToken: 'GOOD', ref: 'BCP-2026-0150', decision: 'reject', note: 'Not received in bank.' });
  assert.equal(rej.data.order.status, 'NEEDS_CORRECTION'); assert.equal(rej.data.order.paid, 2000);
  assert.equal(g.readOrder('BCP-2026-0150').Paid, 2000);
});
t('admin list shows part-paid orders in their own bucket', () => {
  const g = fresh(); const { token } = login(g).data;
  g.call({ action: 'submitProof', token, utr: '426288001234', image: IMG, amount: 2000 });
  decide(g, {});
  const r = g.call({ action: 'admin.list', idToken: 'GOOD' }).data;
  assert.equal(r.partialCount, 1); assert.equal(r.pendingCount, 0); assert.equal(r.orders[0].status, 'PARTIALLY_PAID');
});

console.log(`\n${passed} backend checks passed`);
