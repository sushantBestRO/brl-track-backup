'use strict';
/**
 * BRL Track (robot 59) — https://bestroadways.com/t/<code>
 * nginx sends /t/… here with the /t prefix removed:  location /t/ { proxy_pass http://127.0.0.1:3090/; }
 *
 *   GET  /<CODE>                    client page (no login, refreshes every 2 min)
 *   GET  /api/j/<CODE>              client page data (never a source, driver number or own / market)
 *   POST /api/sync      (x-key)     robot 45 sends LR rows + positions → returns {lr, vehicle, link}
 *   GET  /api/lr?lr=&k=             robots (KAM 40t): link + status for one LR
 *   GET  /find?ewb=&veh= | ?lr=&veh= website Track page → that journey's link (both numbers must match)
 *   POST /push/<SOURCE>/<secret>    GPS push {vehicle, lat, lng, time}
 *   GET  /api/log?k=                last 200 robot log lines
 *   GET  /health
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { open } = require('./src/db');
const { Engine } = require('./src/engine');

function loadCfg() {
  const base = require('./config.sample.js');
  let cfg = {}; try { cfg = require('./config.js'); } catch (e) { console.warn('config.js missing — using config.sample.js (NOT for production)'); }
  return Object.assign({}, base, cfg, { db: Object.assign({}, base.db, cfg.db || {}) });
}

const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'page.html'), 'utf8');
const CODE_RX = /^[A-Z]{10}$/;

function send(res, code, body, type, extra) {
  const isObj = typeof body !== 'string';
  res.writeHead(code, Object.assign({
    'Content-Type': type || (isObj ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8'),
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  }, extra || {}));
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const safeEq = (a, b) => { a = String(a || ''); b = String(b || ''); if (!a || !b || a.length !== b.length) return false; return require('crypto').timingSafeEqual(Buffer.from(a), Buffer.from(b)); };

/* light rate limit for the public endpoints */
const hits = new Map();
function limited(ip, max) {
  const k = ip + '|' + Math.floor(Date.now() / 6e4), n = (hits.get(k) || 0) + 1; hits.set(k, n);
  if (hits.size > 20000) hits.clear();
  return n > max;
}

function makeServer(eng, cfg) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/\/+$/, '') || '/', q = Object.fromEntries(u.searchParams);
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const key = req.headers['x-key'] || q.k;
    try {
      if (p === '/health') return send(res, 200, { ok: true });

      if (req.method === 'POST' && p === '/api/sync') {
        if (!safeEq(key, cfg.internal_key)) return send(res, 403, { ok: false, err: 'key' });
        const b = await readBody(req, 8 * 1024 * 1024);
        const links = await eng.sync(b.rows || [], b.sheet || '');
        return send(res, 200, { ok: true, links });
      }

      if (p === '/api/lr') {
        if (!safeEq(key, cfg.internal_key)) return send(res, 403, { ok: false, err: 'key' });
        const r = await eng.byLr(q.lr);
        return send(res, 200, r || { ok: false });
      }

      if (p === '/api/log') {
        if (!safeEq(key, cfg.internal_key)) return send(res, 403, { ok: false, err: 'key' });
        const rows = await eng.db.query('SELECT at, kind, msg FROM track_log ORDER BY id DESC LIMIT 200', []);
        return send(res, 200, rows.map(r => ({ at: new Date(Number(r.at)).toISOString(), kind: r.kind, msg: r.msg })));
      }

      if (req.method === 'POST' && p.startsWith('/push/')) {
        const parts = p.split('/');                                  // ['', 'push', SOURCE, secret]
        if (parts.length !== 4 || !safeEq(parts[3], cfg.push_secret)) return send(res, 403, { ok: false });
        const b = await readBody(req, 1024 * 1024);
        const list = Array.isArray(b) ? b : [b];
        const out = []; for (const x of list.slice(0, 500)) out.push(await eng.push(parts[2].toUpperCase().slice(0, 20), x));
        return send(res, 200, { ok: true, results: out });
      }

      if (p === '/find') {
        if (limited(ip, 30)) return send(res, 429, { ok: false, err: 'busy' });
        if (!q.veh || !(q.ewb || q.lr)) return send(res, 200, { ok: false });   // both numbers always needed
        return send(res, 200, await eng.find(q), null, { 'Access-Control-Allow-Origin': '*' });
      }

      const mj = p.match(/^\/api\/j\/([A-Za-z]{10})$/);
      if (mj) {
        if (limited(ip, 120)) return send(res, 429, { ok: false, err: 'busy' });
        const v = await eng.view(mj[1].toUpperCase());
        return send(res, 200, v || { ok: false });
      }

      const code = p.slice(1).toUpperCase();
      if (CODE_RX.test(code)) return send(res, 200, PAGE);

      return send(res, 404, '<!doctype html><meta charset="utf-8"><p style="font-family:Arial;padding:30px">Page not found · Best Roadways</p>');
    } catch (e) {
      eng.log('error', p + ' · ' + (e.stack || e));
      return send(res, 500, { ok: false, err: 'server' });
    }
  });
}

async function main() {
  const cfg = loadCfg();
  const db = await open(cfg);
  await db.setup();
  const eng = new Engine(db, cfg);
  makeServer(eng, cfg).listen(cfg.port, '127.0.0.1', () => console.log('BRL Track on 127.0.0.1:' + cfg.port + ' → ' + cfg.public_base));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { makeServer, loadCfg };
