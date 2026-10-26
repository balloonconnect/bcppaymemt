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
      prev.reviewNote !== order.reviewNote || prev.driveUrl !== order.driveUrl;
    S.order = order; S.view = 'order'; S.notice = '';
    if (changed || (opts && opts.force)) render();
    managePolling();
    if (prev && prev.status !== order.status && order.status === 'APPROVED') BCP.toast('Payment verified — your photos are ready!');
    if (prev && prev.status !== order.status && order.status === 'NEEDS_CORRECTION') BCP.toast('Your payment proof needs a correction.');
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
    el.replaceChildren(Brand(helpLink), h('div', { class: 'container' }, body));
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
    const canPay = (order.status === 'NOT_SUBMITTED' || order.status === 'NEEDS_CORRECTION') && order.balance > 0;
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
          h('div', null, h('dt', null, 'UPI transaction ID'), h('dd', null, order.utr || '—')),
          order.submittedAt ? h('div', null, h('dt', null, 'Submitted'), h('dd', null, BCP.dateTime(order.submittedAt))) : null),
        h('p', { class: 'status-hint' }, 'This page updates by itself — you can keep it open.'),
        Button('Check status now', { class: 'btn-ghost', onclick: async (e) => {
          const b = e.currentTarget; setBusy(b, true, 'Checking…');
          await refresh(); if (b.isConnected) { setBusy(b, false); BCP.toast('Still pending verification.'); }
        } }, 'refresh'));
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
      h('p', { class: 'status-text' }, 'Pay the remaining ' + inr(order.balance) + ' using the UPI details below, then submit your payment proof.'));
  }

  /* ── Payment card ── */
  function upiLink(order) {
    const p = new URLSearchParams({ pa: CFG.UPI_ID, pn: CFG.PAYEE_NAME || 'Balloon Connect Photography', am: Number(order.balance).toFixed(2), cu: 'INR', tn: order.reference });
    return 'upi://pay?' + p.toString().replace(/\+/g, '%20');
  }

  function QrBlock(order) {
    if (CFG.QR_IMAGE) {
      return h('div', { class: 'qr qr-image' },
        h('img', { src: CFG.QR_IMAGE, alt: 'UPI QR code for ' + (CFG.PAYEE_NAME || 'Balloon Connect Photography'), width: '480', height: '480' }));
    }
    if (BCP.isPlaceholder(CFG.UPI_ID) || typeof window.qrcode !== 'function') {
      return h('div', { class: 'qr qr-missing', role: 'img', 'aria-label': 'UPI QR code not available' },
        icon('info', 28), h('span', null, 'UPI QR not set up yet. Please contact us to pay.'));
    }
    const qr = window.qrcode(0, 'M');
    qr.addData(upiLink(order));
    qr.make();
    const svg = new DOMParser().parseFromString(qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }), 'image/svg+xml').documentElement;
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'UPI QR code for ' + inr(order.balance) + ' to ' + CFG.UPI_ID);
    return h('div', { class: 'qr' }, document.importNode(svg, true));
  }

  function PayCard(order) {
    const key = order.reference + ':' + order.status + ':' + order.balance;
    if (!proofForm || proofFormKey !== key) { proofForm = ProofForm(order); proofFormKey = key; }
    const configured = !BCP.isPlaceholder(CFG.UPI_ID);

    const copyBtn = Button('Copy UPI ID', { class: 'btn-ghost btn-sm', onclick: async (e) => {
      const b = e.currentTarget;
      const ok = await BCP.copyText(CFG.UPI_ID);
      BCP.toast(ok ? 'UPI ID copied' : 'Could not copy — please copy it manually');
      if (ok) { b.querySelector('.btn-label').textContent = 'Copied'; setTimeout(() => { if (b.isConnected) b.querySelector('.btn-label').textContent = 'Copy UPI ID'; }, 2000); }
    } }, 'copy');

    return h('section', { class: 'card pay', 'aria-labelledby': 'pay-title' },
      h('h2', { id: 'pay-title', class: 'card-title' }, 'Pay the remaining balance'),
      h('p', { class: 'pay-amount' }, h('span', null, 'Please pay'), h('strong', null, inr(order.balance))),
      h('div', { class: 'pay-methods' },
        QrBlock(order),
        h('div', { class: 'upi' },
          h('p', { class: 'upi-label' }, 'UPI ID'),
          h('p', { class: 'upi-id' }, configured ? CFG.UPI_ID : 'Not set up yet'),
          configured ? copyBtn : null,
          configured ? h('a', { class: 'btn btn-dark btn-sm upi-open', href: upiLink(order) }, icon('smartphone', 20), h('span', null, 'Open UPI app')) : null,
          h('p', { class: 'field-hint' }, CFG.QR_IMAGE
            ? 'Scan the QR with any UPI app (GPay, PhonePe, Paytm…) or pay to the UPI ID, and enter ' + inr(order.balance) + '. “Open UPI app” fills the amount in for you.'
            : 'Scan the QR with any UPI app (GPay, PhonePe, Paytm…) or pay to the UPI ID. The amount is filled in for you.'))),
      h('hr', { class: 'divider' }),
      h('h3', { class: 'card-subtitle' }, 'Then submit your payment proof'),
      proofForm.el);
  }

  /* ── Proof form (state survives re-renders via the cache above) ── */
  function ProofForm(order) {
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
        if (!utrOk) { utrField.input.focus(); return; }
        if (!image) { fileInput.focus(); return; }
        setBusy(submit, true, 'Submitting…');
        try {
          const data = await api('submitProof', { token: S.token, utr, image: { mime: image.mime, data: image.data } }, { timeoutMs: 90000 });
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
          else formError.replaceChildren(Notice('bad', err.message));
        }
      }
    }, utrField.el,
      h('div', { class: 'field' },
        h('span', { class: 'label', id: 'f-shot-label' }, 'Payment screenshot'),
        fileInput, dropLabel, preview, shotErr),
      formError, submit,
      h('p', { class: 'privacy-note' }, icon('lock', 16), 'Your screenshot is stored privately and only seen by Balloon Connect Photography.'));

    return { el: form };
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
