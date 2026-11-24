'use strict';
/* node test/test.js — whole server on in-memory SQLite: sync, physics check, page data, privacy, keys, find, push, close. */
const assert = require('assert');
const { open } = require('../src/db');
const { Engine } = require('../src/engine');
const { makeServer } = require('../server');

const cfg = { port: 0, public_base: 'https://bestroadways.com/t', db: { driver: 'sqlite' }, internal_key: 'K'.repeat(32), push_secret: 'P'.repeat(32),
  close_days_after_delivery: 15, stale_hours: 6, max_speed_kmh: 90, position_error_km: 30 };

(async () => {
  const db = await open(cfg); await db.setup();
  const eng = new Engine(db, cfg), srv = makeServer(eng, cfg);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { code: r.status, body: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() }; };
  const post = (p, body, key) => j(p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, key ? { 'x-key': key } : {}), body: JSON.stringify(body) });
  const H = 36e5, t0 = Date.now() - 10 * H;
  let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓ ' + m); };

  // 1 · sync needs the key
  ok((await post('/api/sync', { rows: [] })).code === 403, 'sync without key is refused');

  // 2 · first sync makes a journey and a link on our domain
  const row = { lr: 'GDM0019015', vehicle: 'RJ 04 GB 3189', ewb: '1234 5678 9012', from: 'Samakhiyali, Gujarat', to: 'Hisar, Haryana', client: 'Waaree Energies',
    consignee: 'Poonia Trading', lr_date: t0, dispatched: t0 + H, eta: Date.now() + 30 * H, place: 'Palanpur, Gujarat', lat: 24.17, lng: 72.43, at: t0 + 3 * H, km: 780, src: 'ROADO' };
  let r = await post('/api/sync', { sheet: 'KAM — Suresh', rows: [row] }, cfg.internal_key);
  ok(r.body.ok && r.body.links.length === 1, 'sync returns one link');
  const link = r.body.links[0].link, code = link.split('/').pop();
  ok(/^https:\/\/bestroadways\.com\/t\/[A-Z]{10}$/.test(link), 'link is bestroadways.com/t/<10 letters>: ' + link);
  ok(!/[IO]/.test(code), 'code has no I / O');

  // 3 · same LR again → same link; a possible move is kept
  r = await post('/api/sync', { rows: [Object.assign({}, row, { place: 'Jaipur, Rajasthan', lat: 26.91, lng: 75.79, at: t0 + 8 * H, km: 260 })] }, cfg.internal_key);
  ok(r.body.links[0].link === link, 'same LR + vehicle keeps the same link');
  // 4 · physics: a 1,500 km jump in 30 minutes is dropped
  await post('/api/sync', { rows: [Object.assign({}, row, { place: 'Kolkata, West Bengal', lat: 22.57, lng: 88.36, at: t0 + 8.5 * H, km: 1500 })] }, cfg.internal_key);
  let v = (await j('/api/j/' + code)).body;
  ok(v.place === 'Jaipur, Rajasthan' && v.kmToGo === 260, 'impossible jump dropped; page shows Jaipur, 260 km to go');
  ok(v.status === 'IN_TRANSIT' && v.track.length === 2, 'status in transit, 2 points on the map');

  // 5 · privacy: page data never names a source, own / market, client or a phone number
  const txt = JSON.stringify(v);
  ok(!/ROADO|FLEETX|GTROPY|INTANGLES|FASTAG|market|own vehicle|Waaree|(^|[^\d])[6-9]\d{9}([^\d]|$)/i.test(txt), 'page data has no source, client name or phone number');

  // 6 · the page itself
  r = await j('/' + code);
  ok(r.code === 200 && /CONSIGNMENT TRACKING/.test(r.body) && /noindex/.test(r.body), 'client page served, noindex');
  ok((await j('/api/j/ZZZZZZZZZZ')).body.ok === false, 'unknown code → not found');
  ok((await j('/abc')).code === 404, 'junk path → 404');

  // 7 · robots: /api/lr needs the key
  ok((await j('/api/lr?lr=GDM0019015')).code === 403, '/api/lr without key refused');
  r = await j('/api/lr?lr=GDM0019015&k=' + cfg.internal_key);
  ok(r.body.ok && r.body.link === link && r.body.status === 'IN_TRANSIT', '/api/lr gives link + status');

  // 8 · website find: both numbers must match
  ok((await j('/find?ewb=123456789012&veh=RJ04GB3189')).body.link === link, 'find by e-way bill + vehicle');
  ok((await j('/find?ewb=123456789012&veh=MH01AB1234')).body.ok === false, 'find with wrong vehicle → nothing');
  ok((await j('/find?lr=GDM0019015')).body.ok === false, 'find by LR alone → nothing');
  ok((await j('/find?lr=GDM0019015&veh=RJ04GB3189')).body.link === link, 'find by LR + vehicle');

  // 9 · GPS push attaches to the open journey
  ok((await post('/push/INTANGLES/wrong', { vehicle: 'RJ04GB3189', lat: 27, lng: 75.9 })).code === 403, 'push with wrong secret refused');
  r = await post('/push/INTANGLES/' + cfg.push_secret, { vehicle: 'RJ04GB3189', lat: 27.6, lng: 75.6, time: t0 + 9 * H, place: 'Ringas, Rajasthan' });
  ok(r.body.results[0].attached === true, 'push attached to the journey');
  v = (await j('/api/j/' + code)).body;
  ok(v.place === 'Ringas, Rajasthan', 'pushed position shown');

  // 10 · empty sheet cells never wipe data; delivered → status + page shows destination
  await post('/api/sync', { rows: [{ lr: 'GDM0019015', vehicle: 'RJ04GB3189', from: '', to: '', delivered: Date.now() - H }] }, cfg.internal_key);
  v = (await j('/api/j/' + code)).body;
  ok(v.status === 'DELIVERED' && v.from === 'Samakhiyali, Gujarat' && v.place === 'Hisar, Haryana' && v.kmToGo === 0, 'delivered; blanks did not wipe the lane');

  // 11 · closes 15 days after delivery
  await db.query('UPDATE journeys SET delivered_at = ? WHERE code = ?', [Date.now() - 16 * 864e5, code]);
  v = (await j('/api/j/' + code)).body;
  ok(v.closed === true, 'page closes 16 days after delivery');

  // 12 · log needs the key and has the sync lines
  r = await j('/api/log?k=' + cfg.internal_key);
  ok(Array.isArray(r.body) && r.body.some(x => x.kind === 'sync'), 'log readable with key');

  srv.close(); await db.close();
  console.log('\nAll ' + pass + ' checks passed.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
