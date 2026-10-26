/* Screen 1 — Customer photo delivery.
   One screen, many states: lookup → order (not submitted / pending / needs correction / approved). */
(function () {
  'use strict';
  const BCP = window.BCP;
  const { h, icon, inr, api, Brand, Badge, Notice, PaymentSummary, Button, setBusy, Field } = BCP;
  const CFG = BCP.config;

  const S = { view: 'loading', order: null, token: '', error: '', notice: '', prefillRef: '' };
  let pollTimer = null;
  let proofForm = null;
  let proofFormKey = '';
  let started = false;

  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };
  const root = () => document.getElementById('screen-customer');

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  function start() {
    if (started) { managePolling(); return; }
    started = true;
    const qRef = (new URLSearchParams(location.search).get('ref') || '').trim();
    const savedRef = store.get('bcp.ref') || '';
    const token = store.get('bcp.token');
    S.prefillRef = qRef || savedRef;
    if (token && (!qRef || qRef.toUpperCase() === savedRef.toUpperCase())) {
      S.token = token;
      S.view = 'loading';
      render();
      refresh();
    } else {
      S.view = 'lookup';
      render();
    }
  }

  function stop() { clearInterval(pollTimer); pollTimer = null; }

  function endSession(message) {
    store.del('bcp.token');
    S.token = ''; S.order = null; S.view = 'lookup'; S.notice = message || '';
    proofForm = null; proofFormKey = '';
    stop();
    render();
  }

  async function refresh() {
    try {
      const data = await api('status', { token: S.token });
      applyOrder(data.order);
    } catch (e) {
      if (e.code === 'session_expired' || e.code === 'not_found') { endSession('For your privacy, please enter your details again.'); return; }
      S.view = 'error'; S.error = e.message; render();
    }
  }

  function applyOrder(order, opts) {
    const prev = S.order;
    const changed = !prev || prev.status !== order.status || prev.balance !== order.balance ||
      prev.reviewNote !== order.reviewNote || prev.driveUrl !== order.driveUrl || prev.paid !== order.paid;
    S.order = order; S.view = 'order'; S.notice = '';
    if (changed || (opts && opts.force)) render();
    managePolling();
    if (prev && prev.status !== order.status && order.status === 'APPROVED') BCP.toast('Payment verified — your photos are ready!');
    if (prev && prev.status !== order.status && order.status === 'NEEDS_CORRECTION') BCP.toast('Your payment proof needs a correction.');
    if (prev && prev.status !== order.status && order.status === 'PARTIALLY_PAID') BCP.toast('Payment received — ' + inr(order.balance) + ' balance left.');
  }

  function managePolling() {
    const wantPoll = S.view === 'order' && S.order && S.order.status === 'PENDING';
    if (wantPoll && !pollTimer) {
      pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 30000);
    } else if (!wantPoll && pollTimer) {
      stop();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.view === 'order' && S.order && S.order.status === 'PENDING' && started) refresh();
  });

  /* ───────────────────────────── rendering ───────────────────────────── */

  function render() {
    const el = root();
    const helpLink = CFG.WHATSAPP_NUMBER && /^\d{8,15}$/.test(CFG.WHATSAPP_NUMBER)
      ? h('a', { class: 'help-link', href: 'https://wa.me/' + CFG.WHATSAPP_NUMBER, target: '_blank', rel: 'noopener noreferrer' }, 'Need help? WhatsApp us')
      : null;
    const body = S.view === 'order' ? OrderView(S.order)
      : S.view === 'lookup' ? LookupView()
      : S.view === 'error' ? ErrorView()
      : LoadingView();
    const logout = S.view === 'order'
      ? h('button', { type: 'button', class: 'logout-btn', onclick: () => { endSession('You have been logged out.'); window.scrollTo(0, 0); } }, 'Log out')
      : null;
    const actions = (helpLink || logout) ? h('div', { class: 'topbar-actions' }, helpLink, logout) : null;
    el.replaceChildren(Brand(actions), h('div', { class: 'container' }, body));
  }

  function Hero(order) {
    const ready = order && order.status === 'APPROVED';
    return h('div', { class: 'hero hero-split' },
      h('div', { class: 'hero-text' },
        h('h1', { id: 'customer-title', tabindex: '-1' }, ready ? 'Your Photos Are Ready!' : 'Your Photos Are Almost Ready!'),
        order
          ? h('p', { class: 'ref-chip' }, h('span', null, 'Delivery reference'), h('strong', null, order.reference))
          : h('p', { class: 'hero-sub' }, 'Enter your delivery reference and the phone number you booked with to check your payment and get your photos.')),
      h('img', { class: 'hero-art', src: 'assets/caricature.webp', alt: '', width: '174', height: '360', decoding: 'async' }));
  }

  function LoadingView() {
    return h('div', { 'aria-busy': 'true' },
      Hero(null),
      h('div', { class: 'card skeleton-card' }, h('div', { class: 'skeleton w60' }), h('div', { class: 'skeleton w90' }), h('div', { class: 'skeleton w40' })),
      h('p', { class: 'sr-only' }, 'Loading your order…'));
  }

  function ErrorView() {
    const retry = Button('Try again', { class: 'btn-dark', onclick: () => { S.view = 'loading'; render(); refresh(); } }, 'refresh');
    const startOver = Button('Enter details again', { class: 'btn-ghost', onclick: () => endSession('') });
    return h('div', null, Hero(null),
      h('div', { class: 'card' },
        Notice('bad', [h('strong', null, "We couldn't load your order. "), S.error], 'alert'),
        h('div', { class: 'btn-row' }, retry, startOver)));
  }

  /* ── Lookup form ── */
  function LookupView() {
    const refField = Field('f-ref', 'Delivery reference',
      h('input', { type: 'text', name: 'reference', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'BCP-2026-0148', value: S.prefillRef }),
      'Sent to you by Balloon Connect Photography, e.g. BCP-2026-0148.');
    const phoneField = Field('f-phone', 'Phone number',
      h('input', { type: 'tel', name: 'phone', inputmode: 'tel', autocomplete: 'tel', placeholder: '98765 43210' }),
      'The number you used when booking your shoot.');
    const formError = h('div', { class: 'form-alert', role: 'alert' });
    const submit = Button('View my photos & payment', { type: 'submit', class: 'btn-primary btn-block' });

    const form = h('form', {
      class: 'card form', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        formError.replaceChildren();
        const ref = refField.input.value.trim();
        const phone = phoneField.input.value.replace(/\D/g, '');
        refField.setError(ref ? '' : 'Enter your delivery reference.');
        phoneField.setError(phone.length >= 10 ? '' : 'Enter the 10-digit phone number you booked with.');
        if (!ref || phone.length < 10) { (ref ? phoneField : refField).input.focus(); return; }
        setBusy(submit, true, 'Checking…');
        try {
          const data = await api('lookup', { ref, phone });
          S.token = data.token;
          store.set('bcp.token', data.token); store.set('bcp.ref', data.order.reference);
          proofForm = null; proofFormKey = '';
          applyOrder(data.order, { force: true });
          focusHeading();
        } catch (err) {
          formError.replaceChildren(Notice('bad', err.message));
          setBusy(submit, false);
        }
      }
    },
      S.notice ? Notice('info', S.notice) : null,
      refField.el, phoneField.el, formError, submit,
      h('p', { class: 'privacy-note' }, icon('lock', 16), 'Your details are only used to find your order.'));
    return h('div', null, Hero(null), form);
  }

  /* ── Order view ── */
  function OrderView(order) {
    const canPay = (order.status === 'NOT_SUBMITTED' || order.status === 'NEEDS_CORRECTION' || order.status === 'PARTIALLY_PAID') && order.balance > 0;
    return h('div', null,
      Hero(order),
      StatusPanel(order),
      h('div', { class: 'grid' },
        h('div', { class: 'col' }, EventDetails(order), PaymentSummary(order)),
        canPay ? h('div', { class: 'col' }, PayCard(order)) : null));
  }

  function EventDetails(order) {
    const row = (k, v) => h('div', { class: 'detail-row' }, h('dt', null, k), h('dd', null, v || '—'));
    return h('div', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Event details'),
      h('dl', { class: 'details' },
        row('Customer name', order.customerName), row('Event type', order.eventType),
        row('Event date', order.eventDate), row('Booking reference', order.reference)));
  }

  function StatusPanel(order) {
    const s = order.status;
    if (s === 'APPROVED') {
      return h('section', { class: 'card status status-ok', 'aria-labelledby': 'status-title' },
        Badge('ok', 'Payment Verified', 'check'),
        h('h2', { id: 'status-title', class: 'status-title' }, 'Your photo folder is open'),
        order.driveUrl
          ? [
            h('p', { class: 'status-text' }, 'Thank you! Your payment is verified. Open the folder below to view and download all your photos.'),
            h('a', { class: 'btn btn-success btn-block', href: order.driveUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 20), h('span', null, 'View & Download Photos'))
          ]
          : h('p', { class: 'status-text' }, 'Thank you! Your payment is verified. Your photo link is being prepared and will appear here shortly — we will also message you.'));
    }
    if (s === 'PENDING') {
      return h('section', { class: 'card status status-warn', 'aria-labelledby': 'status-title' },
        Badge('warn', 'Payment verification pending', 'clock'),
        h('h2', { id: 'status-title', class: 'status-title' }, 'We are checking your payment'),
        h('p', { class: 'status-text' }, 'Your payment proof has been submitted. We will notify you once it is verified.'),
        h('dl', { class: 'meta' },
          order.claimedAmount ? h('div', null, h('dt', null, 'Amount you paid'), h('dd', null, inr(order.claimedAmount))) : null,
          h('div', null, h('dt', null, 'UPI transaction ID'), h('dd', null, order.utr || '—')),
          order.submittedAt ? h('div', null, h('dt', null, 'Submitted'), h('dd', null, BCP.dateTime(order.submittedAt))) : null),
        h('p', { class: 'status-hint' }, 'This page updates by itself — you can keep it open.'),
        Button('Check status now', { class: 'btn-ghost', onclick: async (e) => {
          const b = e.currentTarget; setBusy(b, true, 'Checking…');
          await refresh(); if (b.isConnected) { setBusy(b, false); BCP.toast('Still pending verification.'); }
        } }, 'refresh'));
    }
    if (s === 'PARTIALLY_PAID') {
      return h('section', { class: 'card status status-warn', 'aria-labelledby': 'status-title' },
        Badge('warn', 'Partial payment received', 'info'),
        h('h2', { id: 'status-title', class: 'status-title' }, 'Pay the remaining ' + inr(order.balance) + ' to unlock your photos'),
        h('p', { class: 'status-text' }, 'We have verified ' + inr(order.paid) + ' of ' + inr(order.total) + '. Your photos unlock as soon as the full payment is received and verified.'),
        order.reviewNote ? h('blockquote', { class: 'review-note' }, h('span', null, 'Note from Balloon Connect Photography'), order.reviewNote) : null);
    }
    if (s === 'NEEDS_CORRECTION') {
      return h('section', { class: 'card status status-bad', 'aria-labelledby': 'status-title' },
        Badge('bad', 'Payment verification needs correction', 'alert'),
        h('h2', { id: 'status-title', class: 'status-title' }, 'Please check your payment proof'),
        order.reviewNote ? h('blockquote', { class: 'review-note' }, h('span', null, 'Note from Balloon Connect Photography'), order.reviewNote) : null,
        h('p', { class: 'status-text' }, 'Upload your payment proof again using the form below.'));
    }
    // NOT_SUBMITTED
    if (order.balance <= 0) {
      return h('section', { class: 'card status status-neutral', 'aria-labelledby': 'status-title' },
        Badge('ok', 'No payment due', 'check'),
        h('h2', { id: 'status-title', class: 'status-title' }, 'Your balance is fully paid'),
        h('p', { class: 'status-text' }, 'Thank you! Your photo link will appear on this page as soon as it is ready.'));
    }
    return h('section', { class: 'card status status-neutral', 'aria-labelledby': 'status-title' },
      Badge('neutral', 'Payment proof not submitted', 'info'),
      h('h2', { id: 'status-title', class: 'status-title' }, 'Pay your balance to unlock your photos'),
      h('p', { class: 'status-text' }, 'Pay the full remaining ' + inr(order.balance) + ' — or a custom amount now and the rest later — using the UPI details below, then submit your payment proof. Your photos unlock once the full payment is verified.'));
  }

  /* ── Payment card ── */
  function upiLink(order, amount) {
    const p = new URLSearchParams({ pa: CFG.UPI_ID, pn: CFG.PAYEE_NAME || 'Balloon Connect Photography', am: Number(amount || order.balance).toFixed(2), cu: 'INR', tn: order.reference });
    return 'upi://pay?' + p.toString().replace(/\+/g, '%20');
  }

  function QrBlock(order, amount) {
    if (CFG.QR_IMAGE) {
      return h('div', { class: 'qr qr-image' },
        h('img', { src: CFG.QR_IMAGE, alt: 'UPI QR code for ' + (CFG.PAYEE_NAME || 'Balloon Connect Photography'), width: '480', height: '480' }));
    }
    if (BCP.isPlaceholder(CFG.UPI_ID) || typeof window.qrcode !== 'function') {
      return h('div', { class: 'qr qr-missing', role: 'img', 'aria-label': 'UPI QR code not available' },
        icon('info', 28), h('span', null, 'UPI QR not set up yet. Please contact us to pay.'));
    }
    const qr = window.qrcode(0, 'M');
    qr.addData(upiLink(order, amount));
    qr.make();
    const svg = new DOMParser().parseFromString(qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }), 'image/svg+xml').documentElement;
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'UPI QR code for ' + inr(amount || order.balance) + ' to ' + CFG.UPI_ID);
    return h('div', { class: 'qr' }, document.importNode(svg, true));
  }

  /* ── Amount picker: pay the full balance or a custom amount ── */
  function AmountPicker(order, onChange) {
    const full = Number(order.balance);
    let mode = 'full';
    const radio = (id, value, checked) => h('input', { type: 'radio', name: 'pay-mode', id, value, checked: checked || null });
    const rFull = radio('pm-full', 'full', true);
    const rCustom = radio('pm-custom', 'custom', false);
    const amtInput = h('input', { type: 'text', name: 'amount', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 2000', maxlength: '10' });
    const amtField = Field('f-amount', 'Amount you are paying now (₹)', amtInput,
      'Any amount up to ' + inr(full) + '. You can pay the rest later — your photos unlock once the full payment is verified.');
    amtField.el.hidden = true;

    const parse = () => {
      const raw = amtInput.value.replace(/[,\s₹]/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
      const n = Number(raw);
      return n > 0 ? n : null;
    };
    const current = () => (mode === 'full' ? full : parse());
    const problem = () => {
      if (mode === 'full') return '';
      const n = parse();
      if (amtInput.value.trim() === '') return 'Enter the amount you are paying now.';
      if (n === null) return 'Enter a valid amount in rupees, e.g. 2000.';
      if (n > full) return 'The amount cannot be more than the balance of ' + inr(full) + '.';
      return '';
    };
    const sync = () => {
      amtField.el.hidden = mode !== 'custom';
      optFull.classList.toggle('is-on', mode === 'full');
      optCustom.classList.toggle('is-on', mode === 'custom');
      const n = current();
      onChange(n !== null && n <= full ? n : (mode === 'full' ? full : null));
    };
    const optFull = h('label', { class: 'pay-option is-on', for: 'pm-full' }, rFull,
      h('span', null, h('strong', null, 'Pay full balance'), h('em', null, inr(full))));
    const optCustom = h('label', { class: 'pay-option', for: 'pm-custom' }, rCustom,
      h('span', null, h('strong', null, 'Pay a custom amount'), h('em', null, 'Pay part now, the rest later')));
    rFull.addEventListener('change', () => { mode = 'full'; amtField.setError(''); sync(); });
    rCustom.addEventListener('change', () => { mode = 'custom'; sync(); amtInput.focus(); });
    amtInput.addEventListener('input', () => { amtField.setError(''); sync(); });

    const el = h('fieldset', { class: 'pay-choice' },
      h('legend', { class: 'label' }, 'How much are you paying?'),
      h('div', { class: 'pay-options' }, optFull, optCustom),
      amtField.el);

    return {
      el,
      // Returns the amount to submit, or null after showing an inline error.
      validate() {
        const msg = problem();
        amtField.setError(msg);
        if (msg) { amtInput.focus(); return null; }
        return current();
      },
      get amount() { return current(); }
    };
  }

  function PayCard(order) {
    const key = order.reference + ':' + order.status + ':' + order.balance;
    if (!proofForm || proofFormKey !== key) {
      const ui = { amountEl: null, openEl: null, qrBox: null, hintEl: null, submitNote: null };
      const picker = AmountPicker(order, (amount) => {
        const shown = amount || order.balance;
        if (ui.amountEl) ui.amountEl.textContent = amount ? inr(amount) : '—';
        if (ui.openEl) ui.openEl.setAttribute('href', upiLink(order, shown));
        if (ui.qrBox && !CFG.QR_IMAGE) ui.qrBox.replaceChildren(QrBlock(order, shown));
        if (ui.hintEl && CFG.QR_IMAGE) ui.hintEl.textContent = 'Scan the QR with any UPI app (GPay, PhonePe, Paytm…) or pay to the UPI ID, and enter ' + (amount ? inr(amount) : 'your amount') + '. “Open UPI app” fills the amount in for you.';
        if (ui.submitNote) ui.submitNote.textContent = amount ? 'You are submitting proof for ' + inr(amount) + '.' : 'Enter the amount you paid above.';
      });
      proofForm = Object.assign(ProofForm(order, picker), { picker, ui });
      ui.submitNote = proofForm.note;
      proofFormKey = key;
    }
    const { ui, picker } = proofForm;
    const configured = !BCP.isPlaceholder(CFG.UPI_ID);
    const startAmount = picker.amount || order.balance;

    const copyBtn = Button('Copy UPI ID', { class: 'btn-ghost btn-sm', onclick: async (e) => {
      const b = e.currentTarget;
      const ok = await BCP.copyText(CFG.UPI_ID);
      BCP.toast(ok ? 'UPI ID copied' : 'Could not copy — please copy it manually');
      if (ok) { b.querySelector('.btn-label').textContent = 'Copied'; setTimeout(() => { if (b.isConnected) b.querySelector('.btn-label').textContent = 'Copy UPI ID'; }, 2000); }
    } }, 'copy');

    ui.amountEl = h('strong', null, inr(startAmount));
    ui.qrBox = h('div', { class: 'qr-box' }, QrBlock(order, startAmount));
    ui.openEl = configured ? h('a', { class: 'btn btn-dark btn-sm upi-open', href: upiLink(order, startAmount) }, icon('smartphone', 20), h('span', null, 'Open UPI app')) : null;
    ui.hintEl = h('p', { class: 'field-hint' }, CFG.QR_IMAGE
      ? 'Scan the QR with any UPI app (GPay, PhonePe, Paytm…) or pay to the UPI ID, and enter ' + inr(startAmount) + '. “Open UPI app” fills the amount in for you.'
      : 'Scan the QR with any UPI app (GPay, PhonePe, Paytm…) or pay to the UPI ID. The amount is filled in for you.');

    return h('section', { class: 'card pay', 'aria-labelledby': 'pay-title' },
      h('h2', { id: 'pay-title', class: 'card-title' }, order.status === 'PARTIALLY_PAID' ? 'Pay the remaining balance' : 'Pay for your photos'),
      picker.el,
      h('p', { class: 'pay-amount' }, h('span', null, 'Please pay'), ui.amountEl),
      h('div', { class: 'pay-methods' },
        ui.qrBox,
        h('div', { class: 'upi' },
          h('p', { class: 'upi-label' }, 'UPI ID'),
          h('p', { class: 'upi-id' }, configured ? CFG.UPI_ID : 'Not set up yet'),
          configured ? copyBtn : null,
          ui.openEl,
          ui.hintEl)),
      h('hr', { class: 'divider' }),
      h('h3', { class: 'card-subtitle' }, 'Then submit your payment proof'),
      proofForm.el);
  }

  /* ── Proof form (state survives re-renders via the cache above) ── */
  function ProofForm(order, picker) {
    let image = null;     // { mime, data, previewUrl }
    let busyPrepare = false;

    const utrField = Field('f-utr', 'UPI transaction ID / UTR',
      h('input', { type: 'text', name: 'utr', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '40', placeholder: 'e.g. 426288001234' }),
      'Find it in your payment app under “Transaction details” (usually 12 digits).');

    const fileInput = h('input', { type: 'file', id: 'f-shot', class: 'file-input', accept: 'image/*' });
    const shotErr = h('p', { class: 'field-error', id: 'f-shot-err', role: 'alert' });
    const dropLabel = h('label', { for: 'f-shot', class: 'drop' },
      icon('upload', 28), h('strong', null, 'Upload payment screenshot'), h('span', null, 'Tap to choose a JPG or PNG screenshot'));
    const preview = h('div', { class: 'preview', hidden: true });
    const formError = h('div', { class: 'form-alert', role: 'alert' });
    const submit = Button('Submit Payment Proof', { type: 'submit', class: 'btn-primary btn-block' });
    const submitNote = h('p', { class: 'submit-note', 'aria-live': 'polite' }, 'You are submitting proof for ' + inr(order.balance) + '.');

    function setShotError(msg) {
      shotErr.textContent = msg || '';
      dropLabel.classList.toggle('has-error', !!msg);
      if (msg) fileInput.setAttribute('aria-invalid', 'true'); else fileInput.removeAttribute('aria-invalid');
    }

    function showPreview() {
      preview.hidden = !image;
      dropLabel.hidden = !!image;
      if (!image) { preview.replaceChildren(); return; }
      preview.replaceChildren(
        h('img', { src: image.previewUrl, alt: 'Your selected payment screenshot' }),
        h('div', { class: 'preview-actions' },
          h('span', null, icon('check', 18), 'Screenshot ready'),
          Button('Remove', { class: 'btn-link', onclick: () => { URL.revokeObjectURL(image.previewUrl); image = null; fileInput.value = ''; showPreview(); fileInput.focus(); } })));
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      setShotError('');
      busyPrepare = true;
      dropLabel.classList.add('is-busy');
      try {
        image = await prepareImage(file);
        showPreview();
      } catch (err) {
        image = null; fileInput.value = '';
        setShotError(err.message);
      } finally {
        busyPrepare = false;
        dropLabel.classList.remove('is-busy');
      }
    });

    const form = h('form', {
      class: 'proof-form', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        formError.replaceChildren();
        if (busyPrepare) { setShotError('One moment — your screenshot is still being prepared.'); return; }
        const utr = utrField.input.value.replace(/\s+/g, '').toUpperCase();
        const utrOk = /^[A-Z0-9]{8,30}$/.test(utr);
        utrField.setError(utrOk ? '' : utr ? 'That doesn’t look right. A UTR has 8–30 letters and numbers, with no spaces or symbols.' : 'Enter the UPI transaction ID / UTR from your payment.');
        setShotError(image ? '' : 'Please upload a screenshot of your payment so we can verify it.');
        const amount = picker.validate();
        if (amount === null) return;
        if (!utrOk) { utrField.input.focus(); return; }
        if (!image) { fileInput.focus(); return; }
        setBusy(submit, true, 'Submitting…');
        try {
          const data = await api('submitProof', { token: S.token, utr, amount, image: { mime: image.mime, data: image.data } }, { timeoutMs: 90000 });
          if (image) URL.revokeObjectURL(image.previewUrl);
          proofForm = null; proofFormKey = '';
          applyOrder(data.order, { force: true });
          BCP.toast('Payment proof submitted');
          focusHeading('status-title');
        } catch (err) {
          setBusy(submit, false);
          if (err.code === 'session_expired') { endSession('For your privacy, please enter your details again.'); return; }
          if (err.code === 'already_pending' || err.code === 'already_approved' || err.code === 'no_payment_due') { refresh(); return; }
          if (err.code === 'invalid_utr') utrField.setError(err.message);
          else if (err.code === 'invalid_amount' || err.code === 'amount_too_high') formError.replaceChildren(Notice('bad', err.message));
          else formError.replaceChildren(Notice('bad', err.message));
        }
      }
    }, utrField.el,
      h('div', { class: 'field' },
        h('span', { class: 'label', id: 'f-shot-label' }, 'Payment screenshot'),
        fileInput, dropLabel, preview, shotErr),
      submitNote,
      formError, submit,
      h('p', { class: 'privacy-note' }, icon('lock', 16), 'Your screenshot is stored privately and only seen by Balloon Connect Photography.'));

    return { el: form, note: submitNote };
  }

  // Downscale + re-encode as JPEG so uploads stay small and fast on mobile data.
  async function prepareImage(file) {
    if (!/^image\//.test(file.type)) throw new Error('Please choose an image file — a JPG or PNG screenshot of your payment.');
    if (file.size > 25 * 1024 * 1024) throw new Error('That image is very large. Please choose a screenshot under 25 MB.');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      bitmap = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('We couldn’t read that image. Please upload a JPG or PNG screenshot.')); };
        img.src = url;
      });
    }
    const w0 = bitmap.width || bitmap.naturalWidth;
    const h0 = bitmap.height || bitmap.naturalHeight;
    if (!w0 || !h0) throw new Error('We couldn’t read that image. Please upload a JPG or PNG screenshot.');
    const encode = (maxSide, quality) => new Promise((resolve, reject) => {
      const scale = Math.min(1, maxSide / Math.max(w0, h0));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w0 * scale); canvas.height = Math.round(h0 * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('We couldn’t process that image. Please try another screenshot.'))), 'image/jpeg', quality);
    });
    let blob = await encode(1600, 0.82);
    if (blob.size > 3.2 * 1024 * 1024) blob = await encode(1200, 0.65);
    if (bitmap.close) bitmap.close();
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('We couldn’t read that image. Please try again.'));
      r.readAsDataURL(blob);
    });
    return { mime: 'image/jpeg', data, previewUrl: URL.createObjectURL(blob) };
  }

  function focusHeading(id) {
    const el = document.getElementById(id || 'customer-title');
    if (el) { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: false }); }
  }

  BCP.customer = { start, stop };
})();
