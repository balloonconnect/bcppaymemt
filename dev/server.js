// Local preview: serves site/ and an /api endpoint backed by the REAL backend/Code.gs running on in-memory
// Google fakes (see mock-gas.js). Emails are captured, not sent. Run:  node dev/server.js [port]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createGas } = require('./mock-gas');

const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const SITE = path.join(__dirname, '..', 'site');
const CLIENT_ID = 'local-dev.apps.googleusercontent.com';
const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const securityHeaders = Object.fromEntries(vercel.headers[0].headers.map((x) => [x.key, x.value]));

const gas = createGas({
  props: { GOOGLE_CLIENT_ID: CLIENT_ID, ADMIN_EMAILS: 'owner@example.com', SITE_URL: `http://localhost:${PORT}`, RESEND_API_KEY: 're_local', MAIL_FROM: 'BCP <photos@bcp.test>', OWNER_EMAIL: 'owner@example.com' },
});
gas.setup();
const seed = [
  { Reference: 'BCP-2026-0148', CustomerName: 'Priya Raman', Phone: '9876543210', Email: 'priya@example.com', EventType: 'Baby Shoot', EventDate: new Date('2026-10-12T00:00:00+05:30'), Total: 12000, Paid: 5000 },
  { Reference: 'BCP-2026-0149', CustomerName: 'Arun Kumar', Phone: '9000000001', Email: '', EventType: 'Housewarming', EventDate: new Date('2026-10-15T00:00:00+05:30'), Total: 8000, Paid: 2500 },
  { Reference: 'BCP-2026-0150', CustomerName: 'Meena Subramanian', Phone: '9000000002', Email: '', EventType: 'Birthday', EventDate: new Date('2026-10-20T00:00:00+05:30'), Total: 6000, Paid: 6000 },
  { Reference: 'BCP-2026-0151', CustomerName: 'Karthik Rao', Phone: '9000000003', Email: '', EventType: 'Engagement', EventDate: new Date('2026-10-22T00:00:00+05:30'), Total: 30000, Paid: 10000 },
];
seed.forEach((o) => gas.addOrder(o));

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };

function readBody(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json', 'Access-Control-Allow-Origin': '*' }, extra)); res.end(body); };

  if (url.pathname === '/api' && req.method === 'POST') {
    const body = await readBody(req);
    const out = gas.ctx.doPost({ postData: { contents: body } });
    return send(200, out.getContent());
  }
  if (url.pathname === '/__test/admin-jwt') {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 3000;
    const jwt = [b64({ alg: 'RS256' }), b64({ email: 'owner@example.com', exp, aud: CLIENT_ID }), crypto.randomBytes(8).toString('hex')].join('.');
    gas.adminTokens[jwt] = { aud: CLIENT_ID, email: 'owner@example.com', email_verified: 'true', exp: String(exp) };
    return send(200, JSON.stringify({ jwt }));
  }
  if (url.pathname === '/__test/order') return send(200, JSON.stringify(gas.readOrder(url.searchParams.get('ref'))));
  if (url.pathname === '/__test/mail') return send(200, JSON.stringify(gas.outbox.map((m) => ({ to: m.payload.to, subject: m.payload.subject, text: m.payload.text }))));

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  if (url.pathname === '/config.js') {
    const real = {}; new Function('window', fs.readFileSync(path.join(SITE, 'config.js'), 'utf8'))(real);
    const cfg = Object.assign({}, real.BCP_CONFIG, { API_URL: `http://localhost:${PORT}/api`, GOOGLE_CLIENT_ID: CLIENT_ID });
    return send(200, `window.BCP_CONFIG = ${JSON.stringify(cfg)};`, 'text/javascript', securityHeaders);
  }
  const full = path.normalize(path.join(SITE, file));
  if (!full.startsWith(SITE) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(404, 'Not found', 'text/plain');
  send(200, fs.readFileSync(full), mime[path.extname(full)] || 'application/octet-stream', securityHeaders);
});
server.listen(PORT, () => console.log(`BCP portal (local, mock backend) → http://localhost:${PORT}\n  Customer: /?ref=BCP-2026-0148   phone 9876543210\n  Admin:    /#/admin  (local dev auto-sign-in helper: /__test/admin-jwt)`));
