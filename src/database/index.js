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
  `CREATE TABLE ticket_panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    category_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE ticket_counters (
    guild_id TEXT PRIMARY KEY,
    last_number INTEGER NOT NULL
  );
  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    panel_id INTEGER REFERENCES ticket_panels (id),
    channel_id TEXT,
    control_message_id TEXT,
    creator_id TEXT NOT NULL,
    roblox_username TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLAIMED', 'CLOSED', 'DELETED')),
    created_at INTEGER NOT NULL,
    claimed_by TEXT,
    claimed_at INTEGER,
    closed_by TEXT,
    closed_at INTEGER,
    deleted_by TEXT,
    deleted_at INTEGER,
    UNIQUE (guild_id, number)
  );
  CREATE UNIQUE INDEX tickets_one_active_per_creator ON tickets (guild_id, creator_id) WHERE status IN ('OPEN', 'CLAIMED');
  CREATE INDEX tickets_channel ON tickets (channel_id);`,
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

module.exports = { migrations, open, get, close };
