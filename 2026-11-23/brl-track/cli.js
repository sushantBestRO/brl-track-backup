'use strict';
/* node cli.js setup        → creates the tables
 * node cli.js keys         → prints two fresh random strings for internal_key / push_secret
 * node cli.js lr <LR>      → status, place and the link of one LR
 * node cli.js stats        → journeys, open journeys, positions, last sync */
const crypto = require('crypto');
const { open } = require('./src/db');
const { Engine } = require('./src/engine');
const { loadCfg } = require('./server');

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'keys') { console.log('internal_key: ' + crypto.randomBytes(24).toString('base64url')); console.log('push_secret:  ' + crypto.randomBytes(24).toString('base64url')); return; }
  const cfg = loadCfg(), db = await open(cfg), eng = new Engine(db, cfg);
  try {
    if (cmd === 'setup') { await db.setup(); console.log('Tables ready in ' + cfg.db.database + ' (' + db.driver + ').'); }
    else if (cmd === 'lr') { const r = await eng.byLr(arg); console.log(r ? JSON.stringify(r, null, 2) : 'LR ' + arg + ' not found (or closed).'); }
    else if (cmd === 'stats') {
      const one = async (sql) => Object.values((await db.query(sql, []))[0] || {})[0];
      console.log('journeys      ' + await one('SELECT COUNT(*) AS n FROM journeys'));
      console.log('open          ' + await one('SELECT COUNT(*) AS n FROM journeys WHERE delivered_at IS NULL AND cancelled = 0'));
      console.log('positions     ' + await one('SELECT COUNT(*) AS n FROM positions'));
      const l = (await db.query("SELECT at, msg FROM track_log WHERE kind = 'sync' ORDER BY id DESC LIMIT 1", []))[0];
      console.log('last sync     ' + (l ? new Date(Number(l.at)).toISOString() + ' · ' + l.msg : 'none yet'));
    }
    else console.log('Commands: setup · keys · lr <LR> · stats');
  } finally { await db.close(); }
})().catch(e => { console.error(e.message || e); process.exit(1); });
