/* Screen 2 — Admin payment review (private; opened at #/admin).
   Sign-in is Google Identity Services; the backend verifies the ID token and an allow-list of admin emails. */
(function () {
  'use strict';
  const BCP = window.BCP;
  const { h, icon, inr, api, Brand, Badge, Notice, PaymentSummary, Button, setBusy, Field } = BCP;
  const CFG = BCP.config;

  const A = {
    idToken: '', email: '', orders: [], pendingCount: 0, needsCount: 0, channels: { email: false, whatsapp: false },
    tab: 'pending', selected: '', loading: false, loaded: false, error: '', notice: '', flash: null
  };
  const drafts = {};          // per-order unsent form values, so background refreshes never wipe typing
  const proofCache = {};      // ref -> data URL
  const proofInflight = {};   // ref -> Promise
  let refreshTimer = null;
  let started = false;
  let gsiInit = false;
  let lastSig = '';

  const root = () => document.getElementById('screen-admin');
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };
  const tabOf = (o) => (o.status === 'PENDING' ? 'pending' : o.status === 'NEEDS_CORRECTION' ? 'needs' : o.status === 'PARTIALLY_PAID' ? 'partial' : 'approved');
  const isDriveUrl = (u) => /^https:\/\/drive\.google\.com\/\S+$/i.test(u) && /\/folders\/[\w-]{10,}|\/file\/d\/[\w-]{10,}|[?&]id=[\w-]{10,}/.test(u);

  function parseJwt(t) {
    try {
      const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p), (c) => c.charCodeAt(0))));
    } catch (e) { return null; }
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  function start() {
    if (!started) {
      started = true;
      const t = store.get('bcp.admin.idt');
      const p = t && parseJwt(t);
      if (p && p.exp * 1000 > Date.now() + 30000) { A.idToken = t; A.email = p.email || ''; }
    }
    if (A.idToken) {
      loadList(false);
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => { if (!document.hidden && A.idToken) loadList(true); }, 60000);
    } else {
      render();
    }
  }

  function stop() { clearInterval(refreshTimer); refreshTimer = null; }

  function signOut(message) {
    store.del('bcp.admin.idt');
    A.idToken = ''; A.orders = []; A.loaded = false; A.selected = ''; A.flash = null; A.error = '';
    A.notice = message || '';
    lastSig = '';
    stop();
    try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
    render();
  }

  function onCredential(resp) {
    const p = parseJwt(resp.credential);
    if (!p) return;
    A.idToken = resp.credential; A.email = p.email || ''; A.notice = '';
    store.set('bcp.admin.idt', A.idToken);
    start();
  }

  async function loadList(silent) {
    if (!silent) { A.loading = true; render(); }
    try {
      const d = await api('admin.list', { idToken: A.idToken });
      A.orders = d.orders; A.pendingCount = d.pendingCount; A.needsCount = d.needsCorrectionCount;
      A.channels = d.channels; A.email = d.admin; A.loaded = true; A.error = '';
      ensureSelection();
    } catch (e) {
      if (e.code === 'unauthorized' || e.code === 'forbidden' || e.code === 'not_configured') { signOut(e.message); return; }
      if (silent) return;      // keep what's on screen if a background refresh blips
      A.error = e.message;
    }
    A.loading = false;
    const sig = JSON.stringify([A.orders.map((o) => [o.reference, o.status, o.reviewedAt, o.submittedAt, o.notifications]), A.error, A.tab, A.selected]);
    if (!silent || sig !== lastSig) { lastSig = sig; render(); }
  }

  function ensureSelection() {
    const list = A.orders.filter((o) => tabOf(o) === A.tab);
    if (!list.some((o) => o.reference === A.selected)) A.selected = list.length ? list[0].reference : '';
  }

  function select(ref) {
    A.selected = ref; A.flash = A.flash && A.flash.ref === ref ? A.flash : null;
    render();
    if (window.innerWidth < 980) {
      const el = document.getElementById('detail-title');
      if (el) el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  /* ───────────────────────────── rendering ───────────────────────────── */

  function render() {
    // Keep keyboard focus + caret if a re-render happens while someone is typing.
    const active = document.activeElement;
    const keep = active && active.id && root().contains(active)
      ? { id: active.id, s: active.selectionStart, e: active.selectionEnd } : null;

    const el = root();
    if (!A.idToken) {
      el.replaceChildren(Brand(null), SignedOutView());
      mountGsi();
    } else {
      el.replaceChildren(Brand(null), h('div', { class: 'container wide' }, A.loading && !A.loaded ? LoadingView() : A.error && !A.loaded ? ErrorView() : MainView()));
    }
    if (keep) {
      const n = document.getElementById(keep.id);
      if (n) { n.focus({ preventScroll: true }); try { if (keep.s != null) n.setSelectionRange(keep.s, keep.e); } catch (e) { /* not a text field */ } }
    }
  }

  /* ── Signed out ── */
  function SignedOutView() {
    return h('div', { class: 'container narrow' },
      h('div', { class: 'hero' },
        h('h1', { id: 'admin-title', tabindex: '-1' }, 'Payment Review'),
        h('p', { class: 'hero-sub' }, 'Private area for the Balloon Connect Photography owner.')),
      h('div', { class: 'card admin-signin' },
        Badge('neutral', 'Signed out', 'lock'),
        A.notice ? Notice('info', A.notice, 'alert') : null,
        h('p', { class: 'status-text' }, 'Sign in with your authorised Google account to review payment proofs.'),
        h('div', { id: 'gsi-slot', class: 'gsi-slot' }),
        h('p', { class: 'privacy-note' }, icon('lock', 16), 'Only accounts on the admin list can review payments.')));
  }

  function loadGsi() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.id) return resolve();
      let s = document.querySelector('script[data-gsi]');
      if (!s) { s = h('script', { src: 'https://accounts.google.com/gsi/client', async: true, defer: true, 'data-gsi': '1' }); document.head.append(s); }
      s.addEventListener('load', () => resolve());
      s.addEventListener('error', () => { s.remove(); reject(new Error('gsi')); });
    });
  }

  async function mountGsi() {
    const slot = document.getElementById('gsi-slot');
    if (!slot) return;
    if (BCP.isPlaceholder(CFG.GOOGLE_CLIENT_ID)) {
      slot.replaceChildren(Notice('bad', 'Admin sign-in is not set up yet. Add GOOGLE_CLIENT_ID in config.js.'));
      return;
    }
    try { await loadGsi(); } catch (e) {
      slot.replaceChildren(Notice('bad', 'Google sign-in could not load. Check your connection and refresh the page.'));
      return;
    }
    if (!document.getElementById('gsi-slot')) return;
    if (!gsiInit) {
      google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
      gsiInit = true;
    }
    google.accounts.id.renderButton(slot, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'left', width: 280 });
  }

  /* ── Loading / error ── */
  function LoadingView() {
    return h('div', { 'aria-busy': 'true' },
      h('div', { class: 'admin-head' }, h('h1', { id: 'admin-title' }, 'Payment Review')),
      h('div', { class: 'admin-grid' },
        h('div', { class: 'card skeleton-card' }, h('div', { class: 'skeleton w90' }), h('div', { class: 'skeleton w60' }), h('div', { class: 'skeleton w90' })),
        h('div', { class: 'card skeleton-card' }, h('div', { class: 'skeleton w60' }), h('div', { class: 'skeleton shot-skel' }))),
      h('p', { class: 'sr-only' }, 'Loading submissions…'));
  }

  function ErrorView() {
    return h('div', null,
      Header(),
      h('div', { class: 'card' },
        Notice('bad', [h('strong', null, "Couldn't load submissions. "), A.error], 'alert'),
        h('div', { class: 'btn-row' }, Button('Try again', { class: 'btn-dark', onclick: () => loadList(false) }, 'refresh'),
          Button('Sign out', { class: 'btn-ghost', onclick: () => signOut('') }, 'logout'))));
  }

  /* ── Main ── */
  function Header() {
    return h('div', { class: 'admin-head' },
      h('div', { class: 'admin-title-row' },
        h('h1', { id: 'admin-title', tabindex: '-1' }, 'Payment Review'),
        h('span', { class: 'pill pill-count' + (A.pendingCount ? ' has-pending' : ''), 'aria-live': 'polite' },
          h('strong', null, String(A.pendingCount)), A.pendingCount === 1 ? ' pending submission' : ' pending submissions')),
      h('div', { class: 'session' },
        h('span', { class: 'session-chip' }, icon('lock', 16), h('span', null, h('span', { class: 'sr-only' }, 'Signed in securely as '), A.email)),
        Button('Sign out', { class: 'btn-ghost btn-sm', onclick: () => signOut('You have been signed out.') }, 'logout'),
        Button('Refresh', { class: 'btn-ghost btn-sm', onclick: async (e) => { const b = e.currentTarget; setBusy(b, true, 'Refreshing…'); await loadList(true); if (b.isConnected) setBusy(b, false); BCP.toast('Up to date'); } }, 'refresh')));
  }

  function MainView() {
    const counts = { pending: A.pendingCount, needs: A.needsCount, partial: A.orders.filter((o) => tabOf(o) === 'partial').length, approved: A.orders.filter((o) => tabOf(o) === 'approved').length };
    const list = A.orders.filter((o) => tabOf(o) === A.tab);
    const sel = A.orders.find((o) => o.reference === A.selected && tabOf(o) === A.tab);
    const tab = (id, label) => h('button', {
      type: 'button', class: 'tab' + (A.tab === id ? ' is-active' : ''), 'aria-pressed': A.tab === id ? 'true' : 'false',
      onclick: () => { A.tab = id; A.flash = null; ensureSelection(); render(); }
    }, label, h('span', { class: 'tab-count' }, String(counts[id])));

    return h('div', null,
      Header(),
      h('div', { class: 'admin-grid' },
        h('aside', { class: 'queue', 'aria-label': 'Submissions' },
          h('nav', { class: 'tabs', 'aria-label': 'Filter submissions' }, tab('pending', 'Pending'), tab('needs', 'Needs correction'), tab('partial', 'Part paid'), tab('approved', 'Approved')),
          list.length ? h('div', { class: 'queue-list' }, list.map(QueueItem)) : EmptyList()),
        sel ? Detail(sel) : h('section', { class: 'detail' }, h('div', { class: 'card empty' }, icon('inbox', 36), h('p', null, A.tab === 'pending' ? 'Select a submission to review it.' : 'Nothing selected.')))));
  }

  function EmptyList() {
    const msg = { pending: ['No payments waiting for review', 'New payment proofs appear here automatically.'], needs: ['Nothing needs correction', 'Orders you send back for correction show up here.'], partial: ['No part-paid orders', 'Orders where the customer has paid only part of the total show up here.'], approved: ['No approved payments yet', 'Approved orders show up here.'] }[A.tab];
    return h('div', { class: 'card empty' }, icon('inbox', 36), h('strong', null, msg[0]), h('p', null, msg[1]));
  }

  function QueueItem(o) {
    const selected = o.reference === A.selected;
    const amt = (o.status === 'APPROVED' || o.status === 'PARTIALLY_PAID') ? (o.verifiedAmount != null ? o.verifiedAmount : o.total) : (o.status === 'PENDING' && o.claimedAmount) ? o.claimedAmount : o.balance;
    return h('button', {
      type: 'button', class: 'queue-item' + (selected ? ' is-selected' : ''), 'aria-current': selected ? 'true' : null,
      onclick: () => select(o.reference)
    },
      h('div', { class: 'qi-top' }, h('strong', null, o.customerName || o.reference), h('span', { class: 'qi-amt' }, inr(amt))),
      h('div', { class: 'qi-mid' }, o.reference + ' · ' + (o.eventType || 'Event')),
      h('div', { class: 'qi-bot' },
        h('span', null, o.status === 'PENDING' ? 'Submitted ' + BCP.timeAgo(o.submittedAt) : 'Reviewed ' + BCP.timeAgo(o.reviewedAt)),
        o.duplicateUtrRefs.length ? Badge('bad', 'Duplicate UTR', 'alert') : null));
  }

  function StatusBadge(o) {
    return o.status === 'APPROVED' ? Badge('ok', 'Fully paid', 'check')
      : o.status === 'PARTIALLY_PAID' ? Badge('warn', 'Part paid', 'info')
      : o.status === 'NEEDS_CORRECTION' ? Badge('bad', 'Needs correction', 'alert')
      : Badge('warn', 'Pending review', 'clock');
  }

  /* ── Detail ── */
  function Detail(o) {
    const row = (k, v) => h('div', { class: 'detail-row' }, h('dt', null, k), h('dd', null, v || '—'));
    const utrCopy = o.utr ? h('button', { type: 'button', class: 'copy-inline', 'aria-label': 'Copy UTR', onclick: async () => { const ok = await BCP.copyText(o.utr); BCP.toast(ok ? 'UTR copied' : 'Could not copy'); } }, icon('copy', 16)) : null;
    return h('section', { class: 'detail', 'aria-labelledby': 'detail-title' },
      A.flash && A.flash.ref === o.reference ? FlashNotice(o) : null,
      h('div', { class: 'detail-head' },
        h('div', null, h('h2', { id: 'detail-title', class: 'detail-name', tabindex: '-1' }, o.customerName || o.reference),
          h('p', { class: 'detail-sub' }, o.reference + ' · ' + (o.eventType || 'Event') + (o.eventDate ? ' · ' + o.eventDate : ''))),
        StatusBadge(o)),
      o.duplicateUtrRefs.length
        ? Notice('bad', [h('strong', null, 'Duplicate UTR. '), 'This transaction ID was also submitted for ' + o.duplicateUtrRefs.join(', ') + '. Check your bank statement carefully before approving.'], 'alert')
        : null,
      h('div', { class: 'detail-grid' },
        h('div', { class: 'stack' },
          h('div', { class: 'card' },
            h('h3', { class: 'card-title' }, 'Submission'),
            h('dl', { class: 'details' },
              row('Customer', o.customerName), row('Event', (o.eventType || '—') + (o.eventDate ? ' · ' + o.eventDate : '')),
              row('Delivery reference', o.reference),
              h('div', { class: 'detail-row' }, h('dt', null, 'Phone'), h('dd', null, o.phone ? h('a', { href: 'tel:' + o.phone.replace(/[^\d+]/g, '') }, o.phone) : '—')),
              o.email ? row('Email', o.email) : null,
              h('div', { class: 'detail-row' }, h('dt', null, 'UPI transaction ID / UTR'), h('dd', { class: 'utr' }, h('span', null, o.utr || '—'), utrCopy)),
              o.status === 'PENDING' && o.claimedAmount ? row('Customer says they paid', inr(o.claimedAmount)) : null,
              row('Submitted', BCP.dateTime(o.submittedAt)))),
          PaymentSummary(o, { balanceLabel: 'Balance due' }),
          o.paymentLog ? h('div', { class: 'card' }, h('h3', { class: 'card-title' }, 'Payment history'),
            h('ul', { class: 'pay-log' }, o.paymentLog.split('\n').map((l) => h('li', null, l)))) : null,
          NotificationsCard(o)),
        h('div', { class: 'stack' }, ScreenshotCard(o), o.status === 'PENDING' ? ActionsCard(o) : ReviewedCard(o))));
  }

  function FlashNotice(o) {
    const f = A.flash;
    const nodes = [];
    if (f.kind === 'partial') {
      nodes.push(Notice('ok', [h('strong', null, 'Partial payment recorded. '), 'Paid ' + inr(o.paid) + ' of ' + inr(o.total) + ' — balance ' + inr(o.balance) + '. The photos stay locked until the full payment is verified.']));
    } else if (f.kind === 'approve') {
      nodes.push(Notice('ok', [h('strong', null, 'Payment complete. '), (o.customerName || 'The customer') + '’s page now shows “View & Download Photos”.']));
      if (f.driveCheck === 'restricted') nodes.push(Notice('warn', [h('strong', null, 'Check the Drive sharing. '), 'That folder isn’t shared with “Anyone with the link”, so the customer may not be able to open it. Change its sharing in Drive — no change is needed here.']));
      else if (f.driveCheck === 'unverified') nodes.push(Notice('info', 'We couldn’t check that folder’s sharing from here. Open the link in a private window to confirm customers can view it.'));
    } else {
      nodes.push(Notice('ok', [h('strong', null, 'Sent back for correction. '), 'The download link stays hidden. The customer sees your note and can upload proof again.']));
    }
    return h('div', { class: 'flash', id: 'flash', tabindex: '-1', role: 'status' }, nodes);
  }

  function NotificationsCard(o) {
    const n = o.notifications || {};
    const pill = (value, emptyText, label) => {
      const v = String(value || '');
      if (v.indexOf('sent') === 0) return [Badge('ok', label + ' sent', 'check'), h('span', { class: 'n-detail' }, v.split('·')[1] ? v.split('·')[1].trim() : '')];
      if (v.indexOf('failed') === 0) return [Badge('bad', 'Failed', 'alert'), h('span', { class: 'n-detail' }, v.replace(/^failed:\s*/, ''))];
      if (v === 'not_configured') return [Badge('neutral', 'Not set up', 'info'), h('span', { class: 'n-detail' }, 'Email isn’t configured on the server yet.')];
      if (v.indexOf('skipped') === 0) return [Badge('neutral', 'Skipped', 'info'), h('span', { class: 'n-detail' }, v.replace(/^skipped:\s*/, ''))];
      if (v === 'not_enabled') return [Badge('neutral', 'Not enabled', 'info'), h('span', { class: 'n-detail' }, 'WhatsApp alerts aren’t connected.')];
      return [Badge('neutral', emptyText, 'clock')];
    };
    const row = (name, iconName, cells) => h('li', { class: 'notif-row' }, h('span', { class: 'n-name' }, icon(iconName, 18), name), h('span', { class: 'n-state' }, cells));
    return h('div', { class: 'card' },
      h('h3', { class: 'card-title' }, 'Notifications'),
      h('ul', { class: 'notif-list' },
        row('Email to BCP owner', 'mail', pill(n.ownerEmail, 'Not sent', 'Email')),
        row('Email to customer', 'mail', pill(n.customerEmail, o.status === 'PENDING' ? 'Sent after your decision' : 'Not sent', 'Email')),
        row('WhatsApp to BCP owner', 'phone', pill(n.whatsapp, 'Not enabled', 'WhatsApp'))),
      h('p', { class: 'field-hint' }, 'These show the email service’s real response for this order — nothing here is simulated.'));
  }

  function fetchProof(ref) {
    if (proofCache[ref]) return Promise.resolve(proofCache[ref]);
    if (!proofInflight[ref]) {
      proofInflight[ref] = api('admin.proof', { idToken: A.idToken, ref }, { timeoutMs: 90000 })
        .then((d) => { proofCache[ref] = 'data:' + d.mime + ';base64,' + d.data; return proofCache[ref]; })
        .finally(() => { delete proofInflight[ref]; });
    }
    return proofInflight[ref];
  }

  function ScreenshotCard(o) {
    const box = h('div', { class: 'shot' });
    const card = h('div', { class: 'card' }, h('h3', { class: 'card-title' }, 'Payment screenshot'), box);
    const show = (url) => box.replaceChildren(
      h('button', { type: 'button', class: 'shot-btn', 'aria-label': 'Enlarge payment screenshot', onclick: () => BCP.openLightbox(url) },
        h('img', { src: url, alt: 'Payment screenshot uploaded by ' + (o.customerName || o.reference) }),
        h('span', { class: 'shot-zoom' }, 'Tap to enlarge')));
    const load = () => {
      if (!o.hasProof) { box.replaceChildren(h('p', { class: 'field-hint' }, 'No screenshot has been uploaded for this order.')); return; }
      if (proofCache[o.reference]) { show(proofCache[o.reference]); return; }
      box.replaceChildren(h('div', { class: 'skeleton shot-skel', 'aria-label': 'Loading screenshot' }));
      fetchProof(o.reference).then((url) => { if (box.isConnected) show(url); else { /* re-rendered: new card will use cache */ } })
        .catch((e) => {
          if (e.code === 'unauthorized' || e.code === 'forbidden') { signOut(e.message); return; }
          box.replaceChildren(Notice('bad', e.message), Button('Retry', { class: 'btn-ghost btn-sm', onclick: load }, 'refresh'));
        });
    };
    load();
    return card;
  }

  function ActionsCard(o) {
    const d = (drafts[o.reference] = drafts[o.reference] || { verified: false, driveUrl: o.driveUrl || '', note: '', amount: String(o.claimedAmount || o.balance) });

    const verified = h('input', { type: 'checkbox', id: 'a-verified', onchange: (e) => { d.verified = e.target.checked; verifiedErr.textContent = ''; } });
    verified.checked = d.verified;
    const verifiedErr = h('p', { class: 'field-error', id: 'a-verified-err', role: 'alert' });
    const verifyRow = h('div', { class: 'check-row' },
      verified,
      h('label', { for: 'a-verified' }, 'I checked my bank / UPI app and confirm the amount below was received for UTR ', h('strong', null, o.utr || '—'), '.'));

    const amountField = Field('a-amount', 'Amount received (₹)',
      h('input', { type: 'text', name: 'amount', inputmode: 'decimal', autocomplete: 'off', maxlength: '10' }),
      o.claimedAmount ? 'The customer says they paid ' + inr(o.claimedAmount) + '. Change this if your bank shows a different amount.' : 'Balance due is ' + inr(o.balance) + '.');
    amountField.input.value = d.amount;
    const outcome = h('p', { class: 'outcome', 'aria-live': 'polite' });
    const parseAmt = () => {
      const raw = amountField.input.value.replace(/[,\s₹]/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
      const n = Number(raw); return n > 0 ? n : null;
    };
    const updateOutcome = () => {
      const n = parseAmt();
      if (n === null) { outcome.textContent = ''; return; }
      if (n > o.balance) { outcome.textContent = 'That is more than the balance due (' + inr(o.balance) + ').'; return; }
      const left = Math.round((o.balance - n) * 100) / 100;
      outcome.textContent = left <= 0
        ? 'This completes the payment — the photos will unlock for the customer.'
        : 'Balance after approval: ' + inr(left) + '. The photos stay locked until the full payment is verified.';
    };
    amountField.input.addEventListener('input', () => { d.amount = amountField.input.value; amountField.setError(''); updateOutcome(); });
    updateOutcome();

    const driveField = Field('a-drive', 'Google Drive folder link',
      h('input', { type: 'url', name: 'driveUrl', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://drive.google.com/drive/folders/…' }),
      'Share the folder as “Anyone with the link → Viewer”. Needed when this approval completes the payment; the customer only sees the link once the full payment is verified.');
    driveField.input.value = d.driveUrl;
    const driveStatus = h('div', { class: 'drive-status', 'aria-live': 'polite' });
    let checkSeq = 0;
    driveField.input.addEventListener('input', () => { d.driveUrl = driveField.input.value; driveField.setError(''); driveStatus.replaceChildren(); });
    driveField.input.addEventListener('change', async () => {
      const url = driveField.input.value.trim();
      if (!url) return;
      if (!isDriveUrl(url)) { driveField.setError('That doesn’t look like a Google Drive link. It should start with https://drive.google.com/'); return; }
      const seq = ++checkSeq;
      driveStatus.replaceChildren(h('span', { class: 'n-detail' }, 'Checking sharing…'));
      try {
        const r = await api('admin.checkDrive', { idToken: A.idToken, driveUrl: url });
        if (seq !== checkSeq) return;
        driveStatus.replaceChildren(r.share === 'public' ? Badge('ok', 'Anyone with the link can open this', 'check')
          : r.share === 'restricted' ? Badge('warn', 'Not shared by link — customers may not be able to open it', 'alert')
          : Badge('neutral', 'Couldn’t check sharing — test the link in a private window', 'info'));
      } catch (e) {
        if (seq !== checkSeq) return;
        if (e.code === 'unauthorized' || e.code === 'forbidden') { signOut(e.message); return; }
        driveStatus.replaceChildren(Badge('neutral', 'Couldn’t check sharing', 'info'));
      }
    });

    const noteField = Field('a-note', 'Review note',
      h('textarea', { name: 'note', rows: '3', maxlength: '600', placeholder: 'e.g. Received ₹5,000 only — please pay the full balance.' }),
      'Required when requesting a correction — the customer sees this note.');
    noteField.input.value = d.note;
    noteField.input.addEventListener('input', () => { d.note = noteField.input.value; noteField.setError(''); });

    const formError = h('div', { class: 'form-alert', role: 'alert' });
    const approve = Button('Approve Payment', { class: 'btn-success', onclick: () => decide('approve') }, 'check');
    const reject = Button('Reject / Request Correction', { class: 'btn-danger-outline', onclick: () => decide('reject') }, 'alert');

    async function decide(kind) {
      formError.replaceChildren();
      verifiedErr.textContent = ''; driveField.setError(''); noteField.setError(''); amountField.setError('');
      const url = driveField.input.value.trim();
      const note = noteField.input.value.trim();
      const amount = parseAmt();
      if (kind === 'approve') {
        let first = null;
        if (!verified.checked) { verifiedErr.textContent = 'Confirm you verified this payment in your bank or UPI app.'; first = first || verified; }
        if (amount === null || amount > o.balance) { amountField.setError(amount === null ? 'Enter the amount you received, e.g. 2000.' : 'That is more than the balance due (' + inr(o.balance) + ').'); first = first || amountField.input; }
        const completes = amount !== null && amount >= o.balance;
        if (completes && !isDriveUrl(url)) { driveField.setError(url ? 'That doesn’t look like a Google Drive link. It should start with https://drive.google.com/' : 'This approval completes the payment — paste the Google Drive link to this customer’s photos.'); first = first || driveField.input; }
        if (!completes && url && !isDriveUrl(url)) { driveField.setError('That doesn’t look like a Google Drive link. It should start with https://drive.google.com/'); first = first || driveField.input; }
        if (first) { first.focus(); return; }
      } else if (note.length < 5) {
        noteField.setError('Add a short note so the customer knows what to correct.'); noteField.input.focus(); return;
      }
      const btn = kind === 'approve' ? approve : reject;
      setBusy(btn, true, kind === 'approve' ? 'Approving…' : 'Sending back…');
      (kind === 'approve' ? reject : approve).disabled = true;
      try {
        const r = await api('admin.decide', { idToken: A.idToken, ref: o.reference, decision: kind, note, driveUrl: kind === 'approve' ? url : '', verifiedAmount: kind === 'approve' ? amount : undefined, verified: kind === 'approve' ? verified.checked : false }, { timeoutMs: 60000 });
        const i = A.orders.findIndex((x) => x.reference === o.reference);
        if (i >= 0) A.orders[i] = r.order; else A.orders.unshift(r.order);
        A.pendingCount = Math.max(0, A.pendingCount - 1);
        if (kind === 'reject') A.needsCount += 1;
        delete drafts[o.reference];
        const outcomeKind = kind === 'reject' ? 'reject' : (r.order.status === 'APPROVED' ? 'approve' : 'partial');
        A.flash = { ref: o.reference, kind: outcomeKind, driveCheck: r.driveCheck };
        A.tab = outcomeKind === 'approve' ? 'approved' : outcomeKind === 'partial' ? 'partial' : 'needs'; A.selected = o.reference;
        lastSig = '';
        render();
        BCP.toast(outcomeKind === 'approve' ? 'Payment complete — photos unlocked' : outcomeKind === 'partial' ? 'Partial payment recorded' : 'Sent back for correction');
        const f = document.getElementById('flash'); if (f) f.focus();
      } catch (e) {
        setBusy(btn, false); (kind === 'approve' ? reject : approve).disabled = false;
        if (e.code === 'unauthorized' || e.code === 'forbidden') { signOut(e.message); return; }
        if (e.code === 'not_pending') { formError.replaceChildren(Notice('warn', e.message)); loadList(true); return; }
        if (e.code === 'invalid_drive_url') driveField.setError(e.message);
        else if (e.code === 'invalid_amount' || e.code === 'amount_too_high') amountField.setError(e.message);
        else if (e.code === 'note_required') noteField.setError(e.message);
        else formError.replaceChildren(Notice('bad', e.message));
      }
    }

    return h('section', { class: 'card actions', 'aria-labelledby': 'actions-title' },
      h('h3', { id: 'actions-title', class: 'card-title' }, 'Review & decide'),
      h('p', { class: 'field-hint' }, 'Check the amount and UTR in your bank or UPI app first — the screenshot alone isn’t proof.'),
      verifyRow, verifiedErr,
      amountField.el, outcome,
      driveField.el, driveStatus,
      noteField.el, formError,
      h('div', { class: 'btn-row btn-row-split' }, approve, reject));
  }

  function ReviewedCard(o) {
    const rows = [];
    if (o.reviewedAt) rows.push(h('div', { class: 'detail-row' }, h('dt', null, 'Reviewed'), h('dd', null, BCP.dateTime(o.reviewedAt))));
    if (o.status === 'APPROVED' || o.status === 'PARTIALLY_PAID') {
      rows.push(h('div', { class: 'detail-row' }, h('dt', null, o.status === 'APPROVED' ? 'Last verified amount' : 'Verified amount'), h('dd', null, inr(o.verifiedAmount != null ? o.verifiedAmount : o.total))));
      rows.push(h('div', { class: 'detail-row' }, h('dt', null, 'Photos link'), h('dd', null, o.driveUrl
        ? h('a', { href: o.driveUrl, target: '_blank', rel: 'noopener noreferrer', class: 'ext-link' }, 'Open Drive folder', icon('external', 16))
        : '—')));
    }
    return h('div', { class: 'card' },
      h('h3', { class: 'card-title' }, o.status === 'APPROVED' ? 'Fully paid' : o.status === 'PARTIALLY_PAID' ? 'Partially paid' : 'Sent back for correction'),
      h('dl', { class: 'details' }, rows),
      o.reviewNote ? h('blockquote', { class: 'review-note' }, h('span', null, o.status === 'APPROVED' ? 'Your note' : 'Note shown to the customer'), o.reviewNote) : null,
      o.status === 'NEEDS_CORRECTION' ? h('p', { class: 'field-hint' }, 'Waiting for the customer to upload new proof. The download link stays hidden.') : null,
      o.status === 'PARTIALLY_PAID' ? h('p', { class: 'field-hint' }, 'Waiting for the customer to pay the remaining ' + inr(o.balance) + '. The download link stays hidden until the full payment is verified.') : null);
  }

  BCP.admin = { start, stop };
})();
