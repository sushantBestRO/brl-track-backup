'use strict';
/* BRL Track engine: one journey per LR + vehicle, one permanent code, positions with a physics check,
 * and the public view of a journey (never the source, never a driver number, never own / market). */
const crypto = require('crypto');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';            // no I / O — easy to read on a phone
const norm = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const clean = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n || 200) : null; };
const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? null : n; };

/* any date the robots send: epoch ms, ISO, or "dd/mm/yyyy hh:mm" → epoch ms */
function ms(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : (v > 1e9 ? v * 1000 : null);
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return ms(Number(s));
  const iso = Date.parse(s); if (!isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(s)) return iso;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return Date.UTC(y, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) - 330 * 6e4; }
  const any = Date.parse(s); return isNaN(any) ? null : any;
}

function newCode() { const b = crypto.randomBytes(10); let c = ''; for (let i = 0; i < 10; i++) c += ALPHA[b[i] % ALPHA.length]; return c; }

function km(lat1, lng1, lat2, lng2) {
  const R = 6371, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

class Engine {
  constructor(db, cfg) { this.db = db; this.cfg = cfg; }

  async log(kind, msg) { try { await this.db.query('INSERT INTO track_log (at, kind, msg) VALUES (?,?,?)', [Date.now(), kind, String(msg).slice(0, 4000)]); } catch (e) { /* never block */ } }

  link(code) { return this.cfg.public_base.replace(/\/$/, '') + '/' + code; }

  /* robot 45 → rows from every sheet. Returns [{lr, vehicle, link}] */
  async sync(rows, sheet) {
    const out = [];
    let made = 0, moved = 0, dropped = 0;
    for (const r of rows || []) {
      const lr = clean(r.lr, 60), veh = norm(r.vehicle);
      if (!lr || veh.length < 6) continue;
      const jkey = norm(lr) + '|' + veh, now = Date.now();
      let j = (await this.db.query('SELECT * FROM journeys WHERE jkey = ?', [jkey]))[0];
      if (!j) {
        let code; for (let t = 0; t < 5; t++) { code = newCode(); if (!(await this.db.query('SELECT id FROM journeys WHERE code = ?', [code])).length) break; }
        const ins = await this.db.query('INSERT INTO journeys (code, jkey, lr, vehicle, created_at, updated_at) VALUES (?,?,?,?,?,?)', [code, jkey, lr, veh, now, now]);
        j = (await this.db.query('SELECT * FROM journeys WHERE id = ?', [ins.insertId]))[0]; made++;
      }
      // fields: a non-empty value from the sheet wins; an empty one never wipes what we have
      const f = {
        ewb: clean(String(r.ewb || '').replace(/\D/g, ''), 20), lr_date: ms(r.lr_date), from_place: clean(r.from), to_place: clean(r.to),
        client: clean(r.client), consignee: clean(r.consignee), sheet: clean(sheet || r.sheet, 120),
        dispatched_at: ms(r.dispatched), eta: ms(r.eta), promise: ms(r.promise), reached_at: ms(r.reached), delivered_at: ms(r.delivered)
      };
      const sets = [], vals = [];
      Object.keys(f).forEach(k => { if (f[k] != null && f[k] !== j[k]) { sets.push(k + ' = ?'); vals.push(f[k]); } });
      const cancelled = r.cancelled ? 1 : 0; if (cancelled !== Number(j.cancelled || 0)) { sets.push('cancelled = ?'); vals.push(cancelled); }
      // position
      const at = ms(r.at), lat = num(r.lat), lng = num(r.lng), place = clean(r.place), kmLeft = num(r.km);
      if (at && (place || lat != null) && (!j.last_at || at > Number(j.last_at)) && at <= now + 10 * 6e4) {
        let ok = true;
        if (lat != null && lng != null && j.last_lat != null && j.last_at) {
          const d = km(Number(j.last_lat), Number(j.last_lng), lat, lng), hrs = Math.max((at - Number(j.last_at)) / 36e5, 0.05);
          ok = d <= this.cfg.max_speed_kmh * hrs + this.cfg.position_error_km;
        }
        if (ok) {
          await this.db.query('INSERT INTO positions (journey_id, src, place, lat, lng, at, km) VALUES (?,?,?,?,?,?,?)',
            [j.id, clean(r.src, 30), place, lat, lng, at, kmLeft == null ? null : Math.round(kmLeft)]);
          sets.push('last_place = ?', 'last_lat = ?', 'last_lng = ?', 'last_at = ?', 'km_to_go = ?');
          vals.push(place, lat, lng, at, kmLeft == null ? null : Math.round(kmLeft)); moved++;
        } else dropped++;
      }
      if (sets.length) { sets.push('updated_at = ?'); vals.push(now, j.id); await this.db.query('UPDATE journeys SET ' + sets.join(', ') + ' WHERE id = ?', vals); }
      out.push({ lr, vehicle: veh, link: this.link(j.code) });
    }
    await this.log('sync', (sheet || '') + ' · ' + (rows || []).length + ' rows · ' + made + ' new journeys · ' + moved + ' positions · ' + dropped + ' dropped (physics)');
    return out;
  }

  /* GPS push from any source: attaches to the newest open journey of that vehicle */
  async push(src, p) {
    const veh = norm(p.vehicle), at = ms(p.time) || Date.now(), lat = num(p.lat), lng = num(p.lng);
    if (veh.length < 6 || lat == null || lng == null) return { ok: false, err: 'vehicle, lat, lng needed' };
    const j = (await this.db.query('SELECT * FROM journeys WHERE vehicle = ? AND delivered_at IS NULL AND cancelled = 0 ORDER BY created_at DESC LIMIT 1', [veh]))[0];
    if (!j) return { ok: true, attached: false };
    const r = await this.sync([{ lr: j.lr, vehicle: veh, lat, lng, at, place: p.place || null, src }], 'push ' + src);
    return { ok: true, attached: true, link: r[0] && r[0].link };
  }

  status(j, now) {
    if (j.cancelled) return 'CANCELLED';
    if (j.delivered_at) return 'DELIVERED';
    if (j.reached_at) return 'REACHED';
    if (j.dispatched_at || j.last_at) return 'IN_TRANSIT';
    return 'BOOKED';
  }

  /* the public view — what the customer's page shows */
  async view(code) {
    const j = (await this.db.query('SELECT * FROM journeys WHERE code = ?', [String(code || '').toUpperCase()]))[0];
    if (!j) return null;
    const now = Date.now(), st = this.status(j, now), closeMs = this.cfg.close_days_after_delivery * 864e5;
    if (j.delivered_at && now - Number(j.delivered_at) > closeMs) return { closed: true, lr: j.lr };
    const pos = await this.db.query('SELECT place, lat, lng, at FROM positions WHERE journey_id = ? ORDER BY at ASC', [j.id]);
    const passed = []; let lastPlace = '';
    pos.forEach(p => { if (p.place && p.place !== lastPlace) { passed.push({ place: p.place, at: Number(p.at) }); lastPlace = p.place; } });
    const stale = j.last_at ? (now - Number(j.last_at)) > this.cfg.stale_hours * 36e5 : true;
    const done = st === 'DELIVERED' || st === 'REACHED';
    return {
      ok: true, code: j.code, lr: j.lr, lrDate: j.lr_date ? Number(j.lr_date) : null, vehicle: j.vehicle,
      from: j.from_place, to: j.to_place, consignee: j.consignee, status: st,
      dispatchedAt: j.dispatched_at ? Number(j.dispatched_at) : null,
      place: done ? (j.to_place || 'Destination') : (j.last_place || null),
      placeLabel: done ? 'Reached' : (stale ? 'Last confirmed location' : 'Current location'),
      updatedAt: j.last_at ? Number(j.last_at) : null,
      kmToGo: done ? 0 : (j.km_to_go == null ? null : Number(j.km_to_go)),
      eta: done ? null : (j.eta ? Number(j.eta) : null),
      reachedAt: j.reached_at ? Number(j.reached_at) : null, deliveredAt: j.delivered_at ? Number(j.delivered_at) : null,
      track: pos.filter(p => p.lat != null).slice(-200).map(p => [Number(p.lat), Number(p.lng)]),
      passed: passed.slice(-12)
    };
  }

  /* robots (40t): by LR → link + status for the in-transit mail */
  async byLr(lr) {
    const rows = await this.db.query('SELECT code FROM journeys WHERE lr = ? ORDER BY updated_at DESC LIMIT 1', [clean(lr, 60)]);
    if (!rows.length) return null;
    const v = await this.view(rows[0].code); if (!v || v.closed) return null;
    return { ok: true, link: this.link(v.code), status: v.status, place: v.place, kmToGo: v.kmToGo, eta: v.eta ? new Date(v.eta).toISOString() : null };
  }

  /* website Track page: e-way bill + vehicle, or LR → link (only when both numbers match one journey) */
  async find(q) {
    let rows = [];
    if (q.lr) rows = await this.db.query('SELECT code, vehicle FROM journeys WHERE lr = ? ORDER BY updated_at DESC LIMIT 1', [clean(q.lr, 60)]);
    else if (q.ewb && q.veh) rows = await this.db.query('SELECT code, vehicle FROM journeys WHERE ewb = ? AND vehicle = ? ORDER BY updated_at DESC LIMIT 1',
      [String(q.ewb).replace(/\D/g, ''), norm(q.veh)]);
    if (q.lr && q.veh && rows.length && rows[0].vehicle !== norm(q.veh)) rows = [];
    return rows.length ? { ok: true, link: this.link(rows[0].code) } : { ok: false };
  }
}

module.exports = { Engine, norm, ms, km };
