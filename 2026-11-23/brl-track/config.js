/**
 * BRL Track — config. Copy to config.js, fill in, then: chmod 600 config.js
 * NEVER mail or WhatsApp config.js. Keys only on a call / password manager.
 */
module.exports = {
  port:4106 ,                                   // nginx: location /t/ { proxy_pass http://127.0.0.1:3090/; }
  public_base: 'https://track.auto-pilot.best/',    // links look like https://bestroadways.com/t/ABCDEFGHJK

  db: {
    driver: 'mysql',                            // 'mysql' on the server · 'sqlite' only for tests
    host: '127.0.0.1', port: 3306,
    user: 'brl_track', password: 'Bestroadways@77', database: 'brl_track'
  },

  // Two long random strings (node cli.js keys prints fresh ones).
  internal_key: 'Jpbm4EmuhdjipG0CBVC2kuz3mZDFvudW',      // robots (Apps Script robot 45 → /api/sync, KAM 40t → /api/lr)
  push_secret: 'aelln-cCsIbl12CKppzTv1v0OLaAkGbr',       // GPS pushes: /push/<SOURCE>/<push_secret>

  close_days_after_delivery: 15,                // client page closes this many days after delivery
  stale_hours: 6,                               // older position → "Last confirmed location"
  max_speed_kmh: 90,                            // physics check: a jump faster than this (+ error) is dropped
  position_error_km: 30
};
