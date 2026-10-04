const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'roland.db');

const migrations = [
  `CREATE TABLE punishments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    user_id TEXT,
    moderator_id TEXT NOT NULL,
    reason TEXT,
    duration TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    active INTEGER NOT NULL DEFAULT 0,
    channel_id TEXT,
    metadata TEXT
  );
  CREATE INDEX punishments_user ON punishments (guild_id, user_id);
  CREATE INDEX punishments_expiration ON punishments (type, active, expires_at);
  CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    log_channel_id TEXT,
    logs_enabled INTEGER NOT NULL DEFAULT 0
  );`,
];

let db;

const close = () => {
  db?.close();
  db = undefined;
};

const open = (file = DEFAULT_PATH) => {
  close();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');

  const version = db.pragma('user_version', { simple: true });
  migrations.slice(version).forEach((sql, index) => {
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + index + 1}`);
    })();
  });

  return db;
};

const get = () => db ?? open();

module.exports = { open, get, close };
