/**
 * BCP Photo Delivery Portal — Google Apps Script backend
 *
 * Bound to the "BCP Portal" Google Sheet. Deploy as a Web app:
 *   Execute as: Me   |   Who has access: Anyone
 *
 * Data lives in the "Orders" sheet (one row per order). Payment screenshots are
 * stored in a private Drive folder. The customer's Google Drive photo link is
 * only ever returned by the API once the order status is APPROVED, which only
 * happens when the verified payments add up to the full total.
 *
 * Script Properties (Project Settings → Script properties):
 *   GOOGLE_CLIENT_ID  OAuth client ID used by the admin Google sign-in (required)
 *   ADMIN_EMAILS      comma-separated Google accounts allowed to review payments (required)
 *   SITE_URL          public URL of the site, e.g. https://bcp-portal.vercel.app (for email links)
 *   RESEND_API_KEY    Resend API key (optional — without it, email is reported as "not configured")
 *   MAIL_FROM         e.g. "Balloon Connect Photography <photos@yourdomain.com>"
 *   OWNER_EMAIL       where "payment proof submitted" emails go
 * Created automatically by setupPortal(): TOKEN_SECRET, PROOF_FOLDER_ID
 */

var SHEET_ORDERS = 'Orders';
var HEADERS = [
  'Reference', 'CustomerName', 'Phone', 'Email', 'EventType', 'EventDate',
  'Total', 'Paid', 'Status', 'UTR', 'ProofFileId', 'SubmittedAt', 'ReviewNote',
  'DriveUrl', 'ReviewedAt', 'VerifiedAmount', 'OwnerEmailStatus',
  'CustomerEmailStatus', 'WhatsAppStatus', 'PaymentAmount', 'PaymentLog'
];
var ST = {
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  PENDING: 'PENDING',
  NEEDS_CORRECTION: 'NEEDS_CORRECTION',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  APPROVED: 'APPROVED'
};
var TZ = 'Asia/Kolkata';
var TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
var MAX_LOOKUP_FAILS = 5;
var LOOKUP_LOCK_SECONDS = 900;
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
var ADMIN_LIST_APPROVED_LIMIT = 40;

/* ───────────────────────────── HTTP entry points ───────────────────────────── */

function doGet() {
  return json_({ ok: true, service: 'bcp-portal' });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var handler = ROUTES[String(body.action || '')];
    if (!handler) throw new ApiError('unknown_action', 'Unknown request.');
    return json_({ ok: true, data: handler(body) });
  } catch (err) {
    if (err instanceof ApiError) {
      return json_({ ok: false, error: err.code, message: err.message });
    }
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'server_error', message: 'Something went wrong on our side. Please try again in a moment.' });
  }
}

var ROUTES = {
  lookup: actionLookup_,
  status: actionStatus_,
  submitProof: actionSubmitProof_,
  'admin.list': actionAdminList_,
  'admin.proof': actionAdminProof_,
  'admin.checkDrive': actionAdminCheckDrive_,
  'admin.decide': actionAdminDecide_
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ─────────────────────────────── Customer actions ───────────────────────────── */

function actionLookup_(body) {
  var ref = normRef_(body.ref);
  var phone = normPhone_(body.phone);
  if (!ref || phone.length < 10) {
    throw new ApiError('invalid_input', 'Enter your delivery reference and the phone number used for the booking.');
  }
  throttleCheck_(ref);
  var found = findOrder_(ref);
  if (!found || normPhone_(found.order.Phone) !== phone) {
    throttleFail_(ref);
    throw new ApiError('not_found', "We couldn't find an order with those details. Check the reference and phone number and try again.");
  }
  throttleClear_(ref);
  return { token: makeToken_(ref), order: publicOrder_(found.order) };
}

function actionStatus_(body) {
  var ref = verifyToken_(body.token);
  var found = findOrder_(ref);
  if (!found) throw new ApiError('not_found', 'We could not find this order any more.');
  return { order: publicOrder_(found.order) };
}

function actionSubmitProof_(body) {
  var ref = verifyToken_(body.token);

  var utr = String(body.utr || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(utr)) {
    throw new ApiError('invalid_utr', 'Enter only the last 5 digits of your UPI transaction ID / UTR.');
  }

  var img = body.image || {};
  var mime = String(img.mime || '');
  var hasAmount = body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== '';
  var amount = hasAmount ? Number(body.amount) : null;
  if (hasAmount && (!isFinite(amount) || amount <= 0 || Math.abs(round2_(amount) - amount) > 1e-9)) {
    throw new ApiError('invalid_amount', 'Enter the amount you paid as a number greater than zero (up to 2 decimals).');
  }
  if (['image/jpeg', 'image/png', 'image/webp'].indexOf(mime) === -1 || typeof img.data !== 'string') {
    throw new ApiError('invalid_image', 'Please upload your payment screenshot as a JPG, PNG or WebP image.');
  }
  var bytes = Utilities.base64Decode(img.data);
  if (bytes.length < 1000 || !looksLikeImage_(bytes, mime)) {
    throw new ApiError('invalid_image', 'That file does not look like a valid image. Please upload the screenshot again.');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError('image_too_large', 'That image is too large. Please upload a smaller screenshot (under 4 MB).');
  }

  var order;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findOrder_(ref);
    if (!found) throw new ApiError('not_found', 'We could not find this order.');
    var o = found.order;
    var status = normStatus_(o.Status);
    if (status === ST.PENDING) throw new ApiError('already_pending', 'Your payment proof is already waiting for verification.');
    if (status === ST.APPROVED) throw new ApiError('already_approved', 'This payment has already been verified.');
    var due = publicOrder_(o).balance;
    if (due <= 0) throw new ApiError('no_payment_due', 'There is no balance due on this order.');
    if (amount === null) amount = due;
    if (amount > due + 1e-9) {
      throw new ApiError('amount_too_high', 'The amount cannot be more than the balance due (' + inr_(due) + ').');
    }

    var ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    var stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
    var file = proofFolder_().createFile(Utilities.newBlob(bytes, mime, ref + '_' + stamp + '.' + ext));

    updateRow_(found, {
      Status: ST.PENDING,
      UTR: utr,
      ProofFileId: file.getId(),
      SubmittedAt: new Date(),
      PaymentAmount: round2_(amount),
      ReviewNote: '',
      ReviewedAt: '',
      OwnerEmailStatus: '',
      CustomerEmailStatus: ''
    });
    order = findOrder_(ref).order;
  } finally {
    lock.releaseLock();
  }

  // Email happens after the lock is released; its real outcome is saved on the order.
  var result = notifyOwnerSubmitted_(order);
  var again = findOrder_(ref);
  updateRow_(again, { OwnerEmailStatus: result, WhatsAppStatus: 'not_enabled' });
  return { order: publicOrder_(findOrder_(ref).order) };
}

/* ───────────────────────────────── Admin actions ────────────────────────────── */

function actionAdminList_(body) {
  var admin = requireAdmin_(body);
  var data = readAll_();
  var utrRefs = {};
  data.rows.forEach(function (r) {
    var o = rowToObj_(data.headers, r);
    var u = String(o.UTR || '').trim().toUpperCase();
    if (u && normStatus_(o.Status) !== ST.NOT_SUBMITTED) {
      (utrRefs[u] = utrRefs[u] || []).push(String(o.Reference));
    }
  });

  var pending = [], needs = [], partial = [], approved = [];
  data.rows.forEach(function (r) {
    var o = rowToObj_(data.headers, r);
    var s = normStatus_(o.Status);
    if (s === ST.NOT_SUBMITTED || !String(o.Reference || '').trim()) return;
    var item = adminOrder_(o, utrRefs);
    if (s === ST.PENDING) pending.push(item);
    else if (s === ST.NEEDS_CORRECTION) needs.push(item);
    else if (s === ST.PARTIALLY_PAID) partial.push(item);
    else approved.push(item);
  });
  pending.sort(byTime_('submittedAt', 1));
  needs.sort(byTime_('reviewedAt', -1));
  partial.sort(byTime_('reviewedAt', -1));
  approved.sort(byTime_('reviewedAt', -1));

  return {
    admin: admin,
    pendingCount: pending.length,
    needsCorrectionCount: needs.length,
    partialCount: partial.length,
    orders: pending.concat(needs, partial, approved.slice(0, ADMIN_LIST_APPROVED_LIMIT)),
    channels: { email: emailConfigured_(), whatsapp: false }
  };
}

function actionAdminProof_(body) {
  requireAdmin_(body);
  var found = findOrder_(normRef_(body.ref));
  if (!found) throw new ApiError('not_found', 'Order not found.');
  var id = String(found.order.ProofFileId || '').trim();
  if (!id) throw new ApiError('no_proof', 'No screenshot has been uploaded for this order.');
  try {
    var blob = DriveApp.getFileById(id).getBlob();
    return { mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
  } catch (err) {
    throw new ApiError('proof_unavailable', 'The screenshot file could not be opened from Drive.');
  }
}

function actionAdminCheckDrive_(body) {
  requireAdmin_(body);
  var url = cleanDriveUrl_(body.driveUrl);
  if (!url) throw new ApiError('invalid_drive_url', 'Enter a valid Google Drive folder or file link (https://drive.google.com/…).');
  return { driveUrl: url, share: checkDriveShare_(url) };
}

function actionAdminDecide_(body) {
  var admin = requireAdmin_(body);
  var ref = normRef_(body.ref);
  var decision = String(body.decision || '');
  var note = String(body.note || '').trim().slice(0, 600);
  var driveUrl = '';
  var received = null;

  if (decision === 'approve') {
    if (body.verified !== true) {
      throw new ApiError('not_verified', 'Confirm that you checked the payment in your bank / UPI app before approving.');
    }
    if (body.verifiedAmount !== undefined && body.verifiedAmount !== null && String(body.verifiedAmount).trim() !== '') {
      received = Number(body.verifiedAmount);
      if (!isFinite(received) || received <= 0 || Math.abs(round2_(received) - received) > 1e-9) {
        throw new ApiError('invalid_amount', 'Enter the amount you received as a number greater than zero (up to 2 decimals).');
      }
    }
    if (String(body.driveUrl || '').trim()) {
      driveUrl = cleanDriveUrl_(body.driveUrl);
      if (!driveUrl) throw new ApiError('invalid_drive_url', 'Enter a valid Google Drive folder or file link (https://drive.google.com/…).');
    }
  } else if (decision === 'reject') {
    if (note.length < 5) throw new ApiError('note_required', 'Add a short note so the customer knows what to correct.');
  } else {
    throw new ApiError('invalid_decision', 'Unknown decision.');
  }

  var order;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findOrder_(ref);
    if (!found) throw new ApiError('not_found', 'Order not found.');
    var status = normStatus_(found.order.Status);
    if (status !== ST.PENDING) {
      throw new ApiError('not_pending', 'This order is not waiting for review (current status: ' + status.replace(/_/g, ' ').toLowerCase() + ').');
    }
    var cur = publicOrder_(found.order);
    var balance = cur.balance;
    if (decision === 'approve') {
      if (received === null) received = num_(found.order.PaymentAmount) || balance;
      if (received > balance + 1e-9) {
        throw new ApiError('amount_too_high', 'The amount received cannot be more than the balance due (' + inr_(balance) + ').');
      }
      var total = num_(found.order.Total);
      var newPaid = round2_(num_(found.order.Paid) + received);
      var complete = newPaid >= total - 1e-9;
      if (complete) {
        driveUrl = driveUrl || cleanDriveUrl_(found.order.DriveUrl);
        if (!driveUrl) throw new ApiError('invalid_drive_url', 'This approval completes the payment — add the Google Drive link for the photos (https://drive.google.com/…).');
      }
      // One line per verified payment: ISO time | amount | UTR (last 5) | verified by
      var logLine = [new Date().toISOString(), received, String(found.order.UTR || ''), admin].join('|');
      var patch = {
        Status: complete ? ST.APPROVED : ST.PARTIALLY_PAID,
        Paid: complete ? total : newPaid,
        ReviewNote: note, ReviewedAt: new Date(), VerifiedAmount: received,
        PaymentAmount: '', CustomerEmailStatus: '',
        PaymentLog: (String(found.order.PaymentLog || '') ? String(found.order.PaymentLog) + '\n' : '') + logLine
      };
      if (driveUrl) patch.DriveUrl = driveUrl;
      updateRow_(found, patch);
    } else {
      updateRow_(found, {
        Status: ST.NEEDS_CORRECTION, ReviewNote: note,
        ReviewedAt: new Date(), CustomerEmailStatus: ''
      });
    }
    order = findOrder_(ref).order;
  } finally {
    lock.releaseLock();
  }

  var outcome = decision === 'reject' ? 'reject' : (normStatus_(order.Status) === ST.APPROVED ? 'approve' : 'partial');
  var result = notifyCustomerDecision_(order, outcome);
  updateRow_(findOrder_(ref), { CustomerEmailStatus: result });
  var fresh = findOrder_(ref).order;
  return {
    reviewedBy: admin,
    order: adminOrder_(fresh, {}),
    driveCheck: outcome === 'approve' ? checkDriveShare_(driveUrl) : null
  };
}

/* ───────────────────────────── Order model helpers ──────────────────────────── */

// Verified payments recorded in PaymentLog, oldest first.
function ledger_(o) {
  var out = [];
  String(o.PaymentLog || '').split('\n').forEach(function (line) {
    var p = line.split('|');
    if (p.length < 3) return;
    var at = new Date(p[0]);
    var amount = num_(p[1]);
    if (isNaN(at) || amount <= 0) return;
    out.push({ at: at.toISOString(), amount: amount, utr: p[2], by: p[3] || '' });
  });
  return out;
}

// What the customer sees as "payment history".
function historyFor_(o, status, paid) {
  var rows = ledger_(o);
  var logged = rows.reduce(function (n, r) { return n + r.amount; }, 0);
  var history = [];
  var earlier = round2_(paid - logged);
  if (earlier > 0) history.push({ kind: 'earlier', at: '', amount: earlier, utr: '' });
  rows.forEach(function (r) { history.push({ kind: 'verified', at: r.at, amount: r.amount, utr: r.utr }); });
  if (status === ST.PENDING) {
    history.push({ kind: 'pending', at: iso_(o.SubmittedAt), amount: num_(o.PaymentAmount), utr: String(o.UTR || '').trim() });
  } else if (status === ST.NEEDS_CORRECTION && num_(o.PaymentAmount) > 0) {
    history.push({ kind: 'correction', at: iso_(o.SubmittedAt), amount: num_(o.PaymentAmount), utr: String(o.UTR || '').trim() });
  }
  return history;
}

function publicOrder_(o) {
  var status = normStatus_(o.Status);
  var total = num_(o.Total);
  var paid = num_(o.Paid);
  if (status === ST.APPROVED) paid = total;
  var balance = Math.max(0, round2_(total - paid));
  return {
    reference: String(o.Reference || '').trim(),
    customerName: String(o.CustomerName || '').trim(),
    eventType: String(o.EventType || '').trim(),
    eventDate: fmtDate_(o.EventDate),
    total: total,
    paid: paid,
    balance: balance,
    status: status,
    utr: (status === ST.PENDING || status === ST.NEEDS_CORRECTION || status === ST.APPROVED) ? String(o.UTR || '').trim() : '',
    submittedAt: iso_(o.SubmittedAt),
    claimedAmount: status === ST.PENDING ? num_(o.PaymentAmount) : 0,
    history: historyFor_(o, status, paid),
    reviewNote: (status === ST.NEEDS_CORRECTION || status === ST.PARTIALLY_PAID) ? String(o.ReviewNote || '') : '',
    // The photo link is only ever released for approved orders.
    driveUrl: status === ST.APPROVED ? cleanDriveUrl_(o.DriveUrl) : ''
  };
}

function adminOrder_(o, utrRefs) {
  var base = publicOrder_(o);
  var u = String(o.UTR || '').trim().toUpperCase();
  var others = ((utrRefs && utrRefs[u]) || []).filter(function (r) { return r !== base.reference; });
  base.phone = String(o.Phone || '').trim();
  base.email = String(o.Email || '').trim();
  base.reviewNote = String(o.ReviewNote || '');
  base.driveUrl = cleanDriveUrl_(o.DriveUrl);
  base.reviewedAt = iso_(o.ReviewedAt);
  base.verifiedAmount = o.VerifiedAmount === '' ? null : num_(o.VerifiedAmount);
  base.ledger = ledger_(o);
  base.utr = String(o.UTR || '').trim();
  base.hasProof = !!String(o.ProofFileId || '').trim();
  base.duplicateUtrRefs = others;
  base.notifications = {
    ownerEmail: String(o.OwnerEmailStatus || ''),
    customerEmail: String(o.CustomerEmailStatus || ''),
    whatsapp: String(o.WhatsAppStatus || '')
  };
  return base;
}

function byTime_(key, dir) {
  return function (a, b) {
    var x = a[key] ? Date.parse(a[key]) : 0;
    var y = b[key] ? Date.parse(b[key]) : 0;
    return (x - y) * dir;
  };
}

function normStatus_(v) {
  var s = String(v || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return ST[s] ? s : ST.NOT_SUBMITTED;
}
function normRef_(v) { return String(v || '').trim().toUpperCase().replace(/\s+/g, ''); }
function normPhone_(v) { return String(v == null ? '' : v).replace(/\D/g, '').slice(-10); }
function num_(v) { var n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }
function round2_(n) { return Math.round(n * 100) / 100; }
function iso_(v) { return v instanceof Date && !isNaN(v) ? v.toISOString() : ''; }
function fmtDate_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, TZ, 'dd MMM yyyy');
  return String(v == null ? '' : v).trim();
}

/* ─────────────────────────────── Sheet access ───────────────────────────────── */

function ordersSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ORDERS);
  if (!sheet) throw new Error('Orders sheet is missing. Run setupPortal() once from the Apps Script editor.');
  return sheet;
}

function readAll_() {
  var sheet = ordersSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  HEADERS.forEach(function (h) {
    if (headers.indexOf(h) === -1) throw new Error('Orders sheet is missing the "' + h + '" column. Run setupPortal().');
  });
  return { sheet: sheet, headers: headers, rows: values.slice(1) };
}

function rowToObj_(headers, row) {
  var o = {};
  headers.forEach(function (h, i) { o[h] = row[i]; });
  return o;
}

function findOrder_(ref) {
  if (!ref) return null;
  var data = readAll_();
  var refIdx = data.headers.indexOf('Reference');
  for (var i = 0; i < data.rows.length; i++) {
    if (normRef_(data.rows[i][refIdx]) === ref) {
      return { sheet: data.sheet, headers: data.headers, rowIndex: i + 2, order: rowToObj_(data.headers, data.rows[i]) };
    }
  }
  return null;
}

// Writes only the named cells, so any formulas in other columns are left untouched.
function updateRow_(found, patch) {
  if (!found) return;
  Object.keys(patch).forEach(function (key) {
    var col = found.headers.indexOf(key);
    if (col === -1) return;
    found.sheet.getRange(found.rowIndex, col + 1).setValue(patch[key]);
  });
  SpreadsheetApp.flush();
}

function proofFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PROOF_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* recreate below */ }
  }
  var folder = DriveApp.createFolder('BCP Payment Proofs (private)');
  props.setProperty('PROOF_FOLDER_ID', folder.getId());
  return folder;
}

/* ───────────────────────── Tokens, throttling & admin auth ──────────────────── */

function secret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', s);
  }
  return s;
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_()));
}

function makeToken_(ref) {
  var payload = Utilities.base64EncodeWebSafe(ref + '|' + (Date.now() + TOKEN_TTL_MS));
  return payload + '.' + sign_(payload);
}

function verifyToken_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2 || sign_(parts[0]) !== parts[1]) {
    throw new ApiError('session_expired', 'Your session has expired. Please look up your order again.');
  }
  var decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString().split('|');
  if (decoded.length !== 2 || Number(decoded[1]) < Date.now()) {
    throw new ApiError('session_expired', 'Your session has expired. Please look up your order again.');
  }
  return decoded[0];
}

function throttleKey_(ref) { return 'lk_' + ref; }
function throttleCheck_(ref) {
  var n = Number(CacheService.getScriptCache().get(throttleKey_(ref)) || 0);
  if (n >= MAX_LOOKUP_FAILS) {
    throw new ApiError('locked', 'Too many unsuccessful attempts. Please wait 15 minutes and try again, or contact us on WhatsApp.');
  }
}
function throttleFail_(ref) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(throttleKey_(ref)) || 0) + 1;
  cache.put(throttleKey_(ref), String(n), LOOKUP_LOCK_SECONDS);
}
function throttleClear_(ref) { CacheService.getScriptCache().remove(throttleKey_(ref)); }

/**
 * Verifies a Google ID token (from Google sign-in on the admin screen) and checks the
 * account is on the ADMIN_EMAILS allow-list. Returns the admin's email.
 */
function requireAdmin_(body) {
  var idToken = String(body.idToken || '');
  if (!idToken) throw new ApiError('unauthorized', 'Please sign in to continue.');
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('GOOGLE_CLIENT_ID');
  var allowed = String(props.getProperty('ADMIN_EMAILS') || '')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  if (!clientId || !allowed.length) {
    throw new ApiError('not_configured', 'Admin sign-in is not configured yet (GOOGLE_CLIENT_ID / ADMIN_EMAILS).');
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = 'adm_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  var email = cache.get(cacheKey);

  if (!email) {
    var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new ApiError('unauthorized', 'Your sign-in has expired. Please sign in again.');
    var info = JSON.parse(res.getContentText());
    var expiresIn = Number(info.exp) - Math.floor(Date.now() / 1000);
    if (info.aud !== clientId || String(info.email_verified) !== 'true' || !(expiresIn > 0)) {
      throw new ApiError('unauthorized', 'Your sign-in could not be verified. Please sign in again.');
    }
    email = String(info.email || '').toLowerCase();
    if (allowed.indexOf(email) === -1) {
      throw new ApiError('forbidden', 'This Google account is not authorised to review payments.');
    }
    cache.put(cacheKey, email, Math.max(1, Math.min(300, expiresIn)));
  }
  return email;
}

/* ─────────────────────────────── Drive link helpers ─────────────────────────── */

function driveId_(url) {
  var m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(url) ||
          /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url) ||
          /[?&]id=([A-Za-z0-9_-]{10,})/.exec(url);
  return m ? m[1] : '';
}

// Returns a cleaned https://drive.google.com/... link, or '' if it is not one.
function cleanDriveUrl_(v) {
  var url = String(v || '').trim();
  if (!/^https:\/\/drive\.google\.com\/[^\s<>"']+$/i.test(url)) return '';
  return driveId_(url) ? url : '';
}

// 'public' (anyone with the link can open it), 'restricted', or 'unverified' (script can't see it).
function checkDriveShare_(url) {
  var id = driveId_(url);
  if (!id) return 'unverified';
  var item = null;
  try { item = DriveApp.getFolderById(id); } catch (e1) {
    try { item = DriveApp.getFileById(id); } catch (e2) { return 'unverified'; }
  }
  try {
    var access = item.getSharingAccess();
    return (access === DriveApp.Access.ANYONE || access === DriveApp.Access.ANYONE_WITH_LINK) ? 'public' : 'restricted';
  } catch (e3) {
    return 'unverified';
  }
}

/* ─────────────────────────────────── Email (Resend) ─────────────────────────── */

function emailConfigured_() {
  var p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('RESEND_API_KEY') && p.getProperty('MAIL_FROM'));
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function inr_(n) { return '₹' + Number(n).toLocaleString('en-IN'); }

function stamp_() { return Utilities.formatDate(new Date(), TZ, 'dd MMM, HH:mm'); }

// Returns 'sent · …', 'failed: …' or 'not_configured'. Never throws.
function sendEmail_(to, subject, html, text) {
  var p = PropertiesService.getScriptProperties();
  var key = p.getProperty('RESEND_API_KEY');
  var from = p.getProperty('MAIL_FROM');
  if (!key || !from || !to) return 'not_configured';
  try {
    var res = UrlFetchApp.fetch('https://api.resend.com/emails', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify({ from: from, to: [to], subject: subject, html: html, text: text }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return 'sent · ' + stamp_();
    var detail = '';
    try { detail = JSON.parse(res.getContentText()).message || ''; } catch (e) { /* ignore */ }
    return ('failed: HTTP ' + code + (detail ? ' – ' + detail : '')).slice(0, 220);
  } catch (err) {
    return ('failed: ' + (err && err.message ? err.message : err)).slice(0, 220);
  }
}

function siteUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('SITE_URL') || '').replace(/\/+$/, '');
}

function emailShell_(heading, bodyHtml, ctaLabel, ctaUrl) {
  var cta = ctaUrl
    ? '<p style="margin:24px 0 0"><a href="' + esc_(ctaUrl) + '" style="background:#F26A21;color:#292B32;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:12px;display:inline-block">' + esc_(ctaLabel) + '</a></p>'
    : '';
  return '<div style="font-family:Inter,Arial,sans-serif;background:#FFF9F4;padding:24px"><div style="max-width:520px;margin:auto;background:#fff;border-radius:16px;padding:28px;color:#292B32">' +
    (siteUrl_() ? '<img src="' + esc_(siteUrl_()) + '/assets/logo-192.png" width="56" height="56" alt="" style="display:block;margin:0 0 8px">' : '') +
    '<p style="margin:0 0 6px;font-size:13px;color:#8a8d96">Balloon Connect Photography</p>' +
    '<h1 style="margin:0 0 16px;font-size:22px">' + esc_(heading) + '</h1>' + bodyHtml + cta + '</div></div>';
}

function notifyOwnerSubmitted_(o) {
  var to = PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL');
  var pub = publicOrder_(o);
  var adminLink = siteUrl_() ? siteUrl_() + '/#/admin' : '';
  var html = emailShell_(
    'Payment proof submitted',
    '<p style="margin:0 0 12px"><b>' + esc_(pub.customerName) + '</b> submitted proof for <b>' + esc_(pub.reference) + '</b>.</p>' +
    '<table style="font-size:15px;line-height:1.7"><tr><td style="color:#8a8d96;padding-right:16px">Event</td><td>' + esc_(pub.eventType) + ' · ' + esc_(pub.eventDate) + '</td></tr>' +
    '<tr><td style="color:#8a8d96">Balance due</td><td><b>' + esc_(inr_(pub.balance)) + '</b></td></tr>' +
    '<tr><td style="color:#8a8d96">UTR</td><td>' + esc_(pub.utr) + '</td></tr></table>' +
    '<p style="margin:16px 0 0;color:#5c5f68">Check the payment in your bank / UPI app before approving.</p>',
    'Review payment', adminLink);
  var text = 'Payment proof submitted by ' + pub.customerName + ' for ' + pub.reference +
    '. Balance ' + inr_(pub.balance) + ', UTR ' + pub.utr + (adminLink ? '. Review: ' + adminLink : '.');
  return sendEmail_(to, 'Payment proof submitted — ' + pub.reference, html, text);
}

function notifyCustomerDecision_(o, decision) {
  var to = String(o.Email || '').trim();
  if (!to) return 'skipped: no customer email';
  var pub = publicOrder_(o);
  var link = siteUrl_() ? siteUrl_() + '/?ref=' + encodeURIComponent(pub.reference) : '';
  var html, subject, text;
  if (decision === 'approve') {
    subject = 'Your photos are ready — ' + pub.reference;
    html = emailShell_('Your photos are ready!',
      '<p style="margin:0">Hi ' + esc_(pub.customerName) + ', your payment has been verified. Open your delivery page to view and download your photos.</p>',
      'View my photos', link);
    text = 'Hi ' + pub.customerName + ', your payment is verified and your photos are ready. ' + (link ? 'Open: ' + link : '');
  } else if (decision === 'partial') {
    subject = 'Payment received — balance ' + inr_(pub.balance) + ' — ' + pub.reference;
    html = emailShell_('Payment received',
      '<p style="margin:0 0 12px">Hi ' + esc_(pub.customerName) + ', we have verified your payment. You have paid ' + inr_(pub.paid) + ' of ' + inr_(pub.total) + '.</p>' +
      '<p style="margin:0">Your photos unlock once the remaining balance of <strong>' + inr_(pub.balance) + '</strong> is paid and verified.</p>',
      'Pay the balance', link);
    text = 'Hi ' + pub.customerName + ', we verified your payment. Paid ' + inr_(pub.paid) + ' of ' + inr_(pub.total) + '. Balance ' + inr_(pub.balance) + ' — photos unlock once it is paid. ' + (link ? 'Open: ' + link : '');
  } else {
    subject = 'Payment needs a correction — ' + pub.reference;
    html = emailShell_('Payment needs a correction',
      '<p style="margin:0 0 12px">Hi ' + esc_(pub.customerName) + ', we could not verify your payment proof yet.</p>' +
      '<p style="margin:0;padding:12px 14px;background:#FFF1E8;border-radius:10px">' + esc_(pub.reviewNote) + '</p>',
      'Upload proof again', link);
    text = 'Hi ' + pub.customerName + ', we could not verify your payment proof: ' + pub.reviewNote + (link ? ' Upload again: ' + link : '');
  }
  return sendEmail_(to, subject, html, text);
}

/* ───────────────────────────────── Image sniffing ───────────────────────────── */

function looksLikeImage_(b, mime) {
  var u = function (i) { return (b[i] + 256) % 256; };
  if (mime === 'image/jpeg') return u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF;
  if (mime === 'image/png') return u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47;
  if (mime === 'image/webp') return u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46 && u(8) === 0x57 && u(9) === 0x45 && u(10) === 0x42 && u(11) === 0x50;
  return false;
}

/* ───────────────────────── One-time setup & owner helpers ───────────────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('BCP Portal')
    .addItem('1. Set up sheet & folders', 'setupPortal')
    .addItem('Add a demo order', 'addDemoOrder')
    .addItem('Check configuration', 'checkConfiguration')
    .addToUi();
}

function setupPortal() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_ORDERS) || ss.insertSheet(SHEET_ORDERS);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  } else {
    var existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(String);
    HEADERS.forEach(function (h) {
      if (existing.indexOf(h) === -1) {
        existing.push(h);
        sheet.getRange(1, existing.length).setValue(h);
      }
    });
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#292B32').setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);

  var phoneCol = headers.indexOf('Phone') + 1;
  var refCol = headers.indexOf('Reference') + 1;
  var statusCol = headers.indexOf('Status') + 1;
  sheet.getRange(2, phoneCol, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  sheet.getRange(2, refCol, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  sheet.getRange(2, statusCol, sheet.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(ST), true).setAllowInvalid(false).build());

  secret_();
  proofFolder_();
  checkConfiguration();
}

function addDemoOrder() {
  var sheet = ordersSheet_();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  var demo = {
    Reference: 'BCP-DEMO-0001', CustomerName: 'Demo Customer', Phone: '9999999999', Email: '',
    EventType: 'Baby Shoot', EventDate: new Date(), Total: 12000, Paid: 5000, Status: ST.NOT_SUBMITTED
  };
  var row = headers.map(function (h) { return demo[h] === undefined ? '' : demo[h]; });
  sheet.appendRow(row);
  var r = sheet.getLastRow();
  sheet.getRange(r, headers.indexOf('Phone') + 1).setNumberFormat('@').setValue('9999999999');
}

function checkConfiguration() {
  var p = PropertiesService.getScriptProperties();
  var lines = [];
  var need = function (k, why) { lines.push((p.getProperty(k) ? '✔ ' : '✘ ') + k + ' — ' + why); };
  need('GOOGLE_CLIENT_ID', 'required for admin Google sign-in');
  need('ADMIN_EMAILS', 'required: who may approve payments');
  need('SITE_URL', 'recommended: links inside emails');
  need('RESEND_API_KEY', 'optional: real email notifications');
  need('MAIL_FROM', 'optional: sender for emails');
  need('OWNER_EMAIL', 'optional: where owner alerts are sent');
  lines.push((p.getProperty('PROOF_FOLDER_ID') ? '✔ ' : '✘ ') + 'Payment proof folder');
  var msg = lines.join('\n');
  console.log(msg);
  try { SpreadsheetApp.getUi().alert('BCP Portal configuration', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* run from editor */ }
  return msg;
}
