/* Shared helpers: DOM builder, icons, formatting, API client, toast, lightbox. */
(function () {
  'use strict';
  const CFG = window.BCP_CONFIG || {};
  const BCP = (window.BCP = window.BCP || {});
  BCP.config = CFG;

  const isPlaceholder = (v) => !v || /^PASTE_|^yourname@/i.test(String(v));
  BCP.isPlaceholder = isPlaceholder;

  /* ── DOM builder (never uses innerHTML for data) ── */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    kids.flat(Infinity).forEach((c) => {
      if (c == null || c === false) return;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return el;
  }
  BCP.h = h;

  /* ── Icons (static, trusted markup) ── */
  const ICONS = {
    camera: '<path d="M4 8a2 2 0 0 1 2-2h1.6l1.2-1.6A1 1 0 0 1 9.6 4h4.8a1 1 0 0 1 .8.4L16.4 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"/><circle cx="12" cy="12.5" r="3.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M12 4l9 16H3L12 4Z"/><path d="M12 10v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-8 8"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>',
    logout: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M15 8l4 4-4 4M19 12H9"/>',
    inbox: '<path d="M3 13l3-8h12l3 8M3 13v6h18v-6M3 13h5l1 3h6l1-3h5"/>',
    smartphone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12M12 8C10 8 8 7 8 5.5S9.5 3 12 8c2.5-5 4-3.5 4-2S14 8 12 8Z"/>'
  };
  function icon(name, size) {
    const s = size || 20;
    const svg = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || '') + '</svg>',
      'image/svg+xml').documentElement;
    return document.importNode(svg, true);
  }
  BCP.icon = icon;

  /* ── Formatting ── */
  BCP.inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  const dtf = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  BCP.dateTime = (iso) => (iso ? dtf.format(new Date(iso)).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase()) : '');
  BCP.timeAgo = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    return Math.floor(s / 86400) + ' d ago';
  };

  /* ── API client ── */
  class ApiError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  BCP.ApiError = ApiError;

  BCP.api = async function api(action, payload, opts) {
    if (isPlaceholder(CFG.API_URL)) {
      throw new ApiError('not_configured', 'This site is not connected to its backend yet. Add the Apps Script URL in config.js.');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || 45000);
    let res;
    try {
      // text/plain keeps this a "simple" request, so the browser skips the CORS preflight Apps Script can't answer.
      res = await fetch(CFG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
        signal: ctrl.signal,
        redirect: 'follow',
        credentials: 'omit'
      });
    } catch (e) {
      throw new ApiError('network', e && e.name === 'AbortError'
        ? 'The request timed out. Please try again.'
        : "We couldn't reach the server. Check your internet connection and try again.");
    } finally {
      clearTimeout(timer);
    }
    let body;
    try { body = await res.json(); } catch (e) {
      throw new ApiError('bad_response', 'The server sent an unexpected response. Please try again.');
    }
    if (!body.ok) throw new ApiError(body.error || 'error', body.message || 'Something went wrong. Please try again.');
    return body.data;
  };

  /* ── Toast ── */
  let toastTimer;
  BCP.toast = function (message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  };

  /* ── Clipboard ── */
  BCP.copyText = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = h('textarea', { 'aria-hidden': 'true', tabindex: '-1', class: 'sr-clip' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
      ta.remove();
      return ok;
    }
  };

  /* ── Lightbox ── */
  BCP.openLightbox = function (src) {
    const box = document.getElementById('lightbox');
    const prev = document.activeElement;
    box.querySelector('img').src = src;
    box.hidden = false;
    const close = () => {
      box.hidden = true;
      box.querySelector('img').removeAttribute('src');
      document.removeEventListener('keydown', onKey);
      if (prev && prev.focus) prev.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    box.onclick = (e) => { if (e.target === box || e.target.classList.contains('lightbox-close')) close(); };
    box.querySelector('.lightbox-close').focus();
  };

  /* ── Shared components ── */
  BCP.Brand = function (right) {
    return h('header', { class: 'topbar' },
      h('div', { class: 'brand' },
        h('img', { class: 'brand-logo', src: 'assets/logo-192.png', alt: '', width: '44', height: '44' }),
        h('span', { class: 'brand-name' }, 'Balloon Connect Photography')),
      right || null);
  };

  // kind: ok | warn | bad | neutral | info
  BCP.Badge = function (kind, text, iconName) {
    return h('span', { class: 'badge badge-' + kind }, iconName ? icon(iconName, 16) : null, text);
  };

  BCP.Notice = function (kind, children, role) {
    return h('div', { class: 'notice notice-' + kind, role: role || null },
      icon(kind === 'bad' ? 'alert' : kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'info', 20),
      h('div', { class: 'notice-body' }, children));
  };

  BCP.PaymentSummary = function (order, opts) {
    const o = opts || {};
    const settled = order.balance <= 0;
    return h('div', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Payment summary'),
      h('dl', { class: 'summary' },
        h('div', { class: 'summary-row' }, h('dt', null, 'Total amount'), h('dd', null, BCP.inr(order.total))),
        h('div', { class: 'summary-row' }, h('dt', null, 'Amount already paid'), h('dd', null, BCP.inr(order.paid))),
        h('div', { class: 'summary-row summary-balance' + (settled ? ' is-settled' : '') },
          h('dt', null, o.balanceLabel || 'Remaining balance'),
          h('dd', null, BCP.inr(order.balance)))));
  };


  /* Labelled form field with inline error + hint. */
  BCP.Field = function (id, label, input, hint) {
    const err = h('p', { class: 'field-error', id: id + '-err', role: 'alert' });
    const hintEl = hint ? h('p', { class: 'field-hint', id: id + '-hint' }, hint) : null;
    input.id = id;
    input.setAttribute('aria-describedby', [hint ? id + '-hint' : '', id + '-err'].filter(Boolean).join(' '));
    const el = h('div', { class: 'field' }, h('label', { for: id }, label), input, hintEl, err);
    return {
      el, input,
      setError(msg) {
        err.textContent = msg || '';
        if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
        el.classList.toggle('has-error', !!msg);
      }
    };
  };

  BCP.Spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });

  BCP.Button = function (label, props, iconName) {
    const p = Object.assign({ type: 'button' }, props);
    p.class = 'btn ' + (p.class || 'btn-primary');
    return h('button', p, iconName ? icon(iconName, 20) : null, h('span', { class: 'btn-label' }, label));
  };

  BCP.setBusy = function (btn, busy, busyLabel) {
    const label = btn.querySelector('.btn-label');
    if (busy) {
      btn.dataset.label = label.textContent;
      label.textContent = busyLabel || 'Please wait…';
      btn.disabled = true;
      btn.prepend(BCP.Spinner());
    } else {
      const sp = btn.querySelector('.spinner');
      if (sp) sp.remove();
      if (btn.dataset.label) label.textContent = btn.dataset.label;
      btn.disabled = false;
    }
  };
})();
