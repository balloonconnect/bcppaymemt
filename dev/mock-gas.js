// Minimal in-memory fakes of the Apps Script services used by backend/Code.gs,
// so the real backend code can be exercised locally (tests + local dev server).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const unsigned = (arr) => Buffer.from(Array.from(arr, (b) => (b + 256) % 256));
const toBuf = (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : unsigned(v));
const webSafe = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_');
const unWebSafe = (s) => s.replace(/-/g, '+').replace(/_/g, '/');

function makeBlob(bytes, mime, name) {
  const buf = toBuf(bytes);
  return {
    getBytes: () => signed(buf),
    getContentType: () => mime || 'application/octet-stream',
    getDataAsString: () => buf.toString('utf8'),
    getName: () => name,
  };
}

function fmtDate(date, tz, pattern) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const m2 = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const hh = p.hour === '24' ? '00' : p.hour;
  return pattern
    .replace('yyyy', p.year).replace('MMM', p.month).replace('MM', m2[p.month])
    .replace('dd', p.day).replace('HH', hh).replace('mm', p.minute).replace('ss', p.second);
}

function createGas(opts = {}) {
  const props = Object.assign({}, opts.props || {});
  const sheets = {};
  const driveFiles = {};
  const folders = {};
  let idCounter = 1;
  const outbox = [];            // captured Resend calls
  const fetchLog = [];
  const adminTokens = Object.assign({}, opts.adminTokens || {}); // idToken -> tokeninfo payload

  function makeSheet(name) {
    const cells = []; // cells[r][c] 0-based
    const get = (r, c) => (cells[r] && cells[r][c] !== undefined ? cells[r][c] : '');
    const set = (r, c, v) => { (cells[r] = cells[r] || [])[c] = v; };
    const lastRow = () => { let n = 0; cells.forEach((row, i) => { if (row && row.some((x) => x !== '' && x !== undefined)) n = i + 1; }); return n; };
    const lastCol = () => { let n = 0; cells.forEach((row) => { if (row) row.forEach((x, j) => { if (x !== '' && x !== undefined) n = Math.max(n, j + 1); }); }); return n; };
    const range = (r, c, nr = 1, nc = 1) => {
      const self = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => get(r - 1 + i, c - 1 + j))),
        setValues: (vals) => { vals.forEach((row, i) => row.forEach((v, j) => set(r - 1 + i, c - 1 + j, v))); return self; },
        setValue: (v) => { set(r - 1, c - 1, v); return self; },
      };
      ['setNumberFormat', 'setFontWeight', 'setBackground', 'setFontColor', 'setDataValidation'].forEach((m) => { self[m] = () => self; });
      return self;
    };
    return {
      name, cells,
      getDataRange: () => range(1, 1, Math.max(lastRow(), 1), Math.max(lastCol(), 1)),
      getRange: range,
      getLastRow: lastRow, getLastColumn: lastCol, getMaxRows: () => Math.max(lastRow(), 1) + 100,
      setFrozenRows: () => {},
      appendRow: (row) => { const r = lastRow(); row.forEach((v, j) => set(r, j, v)); },
    };
  }

  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
  };

  const makeFile = (blob) => {
    const id = 'FILE' + String(idCounter++).padStart(8, '0') + 'abcdef';
    const f = { getId: () => id, getBlob: () => blob };
    driveFiles[id] = f;
    return f;
  };

  const Access = { ANYONE: 'ANYONE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN', DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK', PRIVATE: 'PRIVATE' };
  const sharing = Object.assign({}, opts.driveSharing || {}); // id -> Access

  const store = {};
  const cacheApi = { get: (k) => (k in store ? store[k] : null), put: (k, v) => { store[k] = v; }, remove: (k) => { delete store[k]; } };

  const context = {
    console: { log() {}, error: console.error, warn: console.warn },
    Date, JSON, Math, Number, String, Object, Array, Error, RegExp, isFinite, isNaN, encodeURIComponent, parseInt,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush: () => {},
      getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addToUi() {} }), alert() {}, ButtonSet: { OK: 'OK' } }),
      newDataValidation: () => ({ requireValueInList() { return this; }, setAllowInvalid() { return this; }, build() { return {}; } }),
    },
    DriveApp: {
      Access,
      createFolder: (name) => {
        const id = 'FOLDER' + String(idCounter++).padStart(6, '0') + 'abcdef';
        folders[id] = { getId: () => id, createFile: (blob) => makeFile(blob), getSharingAccess: () => sharing[id] || Access.PRIVATE };
        return folders[id];
      },
      getFolderById: (id) => { if (!folders[id]) throw new Error('Not found'); return folders[id]; },
      getFileById: (id) => { if (!driveFiles[id]) throw new Error('Not found'); const f = driveFiles[id]; f.getSharingAccess = () => sharing[id] || Access.PRIVATE; return f; },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => cacheApi },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (s) => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }) },
    UrlFetchApp: {
      fetch: (url, o = {}) => {
        fetchLog.push(url);
        const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
        if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
          const tok = decodeURIComponent(url.split('id_token=')[1]);
          return adminTokens[tok] ? resp(200, adminTokens[tok]) : resp(400, { error: 'invalid_token' });
        }
        if (url === 'https://api.resend.com/emails') {
          const payload = JSON.parse(o.payload);
          outbox.push({ headers: o.headers, payload });
          if (opts.resendFail) return resp(opts.resendFail, { message: 'forced failure' });
          return resp(200, { id: 'email_' + outbox.length });
        }
        throw new Error('Unexpected fetch ' + url);
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      base64Encode: (b) => toBuf(b).toString('base64'),
      base64Decode: (s) => signed(Buffer.from(s, 'base64')),
      base64EncodeWebSafe: (b) => webSafe(toBuf(b).toString('base64')),
      base64DecodeWebSafe: (s) => signed(Buffer.from(unWebSafe(s), 'base64')),
      computeHmacSha256Signature: (v, key) => signed(crypto.createHmac('sha256', key).update(toBuf(v)).digest()),
      computeDigest: (alg, v) => signed(crypto.createHash('sha256').update(toBuf(v)).digest()),
      newBlob: makeBlob,
      formatDate: fmtDate,
      getUuid: () => crypto.randomUUID(),
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), context, { filename: 'Code.gs' });

  const call = (body) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());

  // Helpers for tests
  const setup = () => context.setupPortal();
  const headers = () => sheets.Orders.cells[0];
  const addOrder = (o) => {
    const h = headers();
    const sh = sheets.Orders;
    const r = sh.getLastRow();
    h.forEach((name, j) => { sh.cells[r] = sh.cells[r] || []; sh.cells[r][j] = o[name] === undefined ? '' : o[name]; });
  };
  const readOrder = (ref) => {
    const h = headers();
    const row = sheets.Orders.cells.find((r, i) => i > 0 && r && r[h.indexOf('Reference')] === ref);
    const o = {}; h.forEach((n, j) => { o[n] = row[j]; }); return o;
  };
  return { ctx: context, call, setup, addOrder, readOrder, props, outbox, fetchLog, driveFiles, folders, sharing, adminTokens };
}

module.exports = { createGas };
