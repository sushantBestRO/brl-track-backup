'use strict';
/* One tiny DB layer: MySQL on the server, node:sqlite for tests. All times are epoch milliseconds (BIGINT). */

const SCHEMA = {
  mysql: [
    `CREATE TABLE IF NOT EXISTS journeys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(12) NOT NULL UNIQUE,
      jkey VARCHAR(100) NOT NULL UNIQUE,
      lr VARCHAR(60) NOT NULL, vehicle VARCHAR(20) NOT NULL, ewb VARCHAR(20) NULL,
      lr_date BIGINT NULL, from_place VARCHAR(200) NULL, to_place VARCHAR(200) NULL,
      client VARCHAR(200) NULL, consignee VARCHAR(200) NULL, sheet VARCHAR(120) NULL,
      dispatched_at BIGINT NULL, eta BIGINT NULL, promise BIGINT NULL,
      reached_at BIGINT NULL, delivered_at BIGINT NULL, cancelled TINYINT NOT NULL DEFAULT 0,
      last_place VARCHAR(200) NULL, last_lat DOUBLE NULL, last_lng DOUBLE NULL, last_at BIGINT NULL, km_to_go INT NULL,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      INDEX (vehicle), INDEX (lr), INDEX (ewb)
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS positions (
      id INT AUTO_INCREMENT PRIMARY KEY, journey_id INT NOT NULL,
      src VARCHAR(30) NULL, place VARCHAR(200) NULL, lat DOUBLE NULL, lng DOUBLE NULL, at BIGINT NOT NULL, km INT NULL,
      INDEX (journey_id, at)
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS track_log (
      id INT AUTO_INCREMENT PRIMARY KEY, at BIGINT NOT NULL, kind VARCHAR(30) NOT NULL, msg TEXT NULL, INDEX (at)
    ) CHARACTER SET utf8mb4`
  ],
  sqlite: [
    `CREATE TABLE IF NOT EXISTS journeys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, jkey TEXT NOT NULL UNIQUE,
      lr TEXT NOT NULL, vehicle TEXT NOT NULL, ewb TEXT, lr_date INTEGER, from_place TEXT, to_place TEXT,
      client TEXT, consignee TEXT, sheet TEXT, dispatched_at INTEGER, eta INTEGER, promise INTEGER,
      reached_at INTEGER, delivered_at INTEGER, cancelled INTEGER NOT NULL DEFAULT 0,
      last_place TEXT, last_lat REAL, last_lng REAL, last_at INTEGER, km_to_go INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, journey_id INTEGER NOT NULL, src TEXT, place TEXT,
      lat REAL, lng REAL, at INTEGER NOT NULL, km INTEGER)`,
    `CREATE TABLE IF NOT EXISTS track_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, msg TEXT)`
  ]
};

async function open(cfg) {
  const c = cfg.db || {};
  if (c.driver === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(c.file || ':memory:');
    return {
      driver: 'sqlite',
      async query(sql, params) {
        const st = db.prepare(sql);
        if (/^\s*select/i.test(sql)) return st.all(...(params || []));
        const r = st.run(...(params || []));
        return { insertId: Number(r.lastInsertRowid), affectedRows: r.changes };
      },
      async setup() { for (const s of SCHEMA.sqlite) db.exec(s); },
      async close() { db.close(); }
    };
  }
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({ host: c.host, port: c.port || 3306, user: c.user, password: c.password, database: c.database,
    connectionLimit: 8, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: false });
  return {
    driver: 'mysql',
    async query(sql, params) { const [rows] = await pool.execute(sql, params || []); return rows; },
    async setup() { for (const s of SCHEMA.mysql) await pool.query(s); },
    async close() { await pool.end(); }
  };
}

module.exports = { open };
