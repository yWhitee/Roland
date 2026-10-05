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
  `CREATE TABLE verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL UNIQUE,
    roblox_id TEXT NOT NULL UNIQUE,
    roblox_username TEXT NOT NULL,
    roblox_display_name TEXT,
    guild_id TEXT,
    verified_at INTEGER NOT NULL
  );
  CREATE TABLE verification_panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('standard', 'custom')),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY NOT NULL,
    discord_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    panel_id INTEGER REFERENCES verification_panels (id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX oauth_states_discord ON oauth_states (discord_id);
  CREATE INDEX oauth_states_expiration ON oauth_states (expires_at);`,
  `ALTER TABLE punishments ADD COLUMN source TEXT NOT NULL DEFAULT 'moderator';
  ALTER TABLE punishments ADD COLUMN automod_function TEXT;
  CREATE TABLE automod_settings (
    guild_id TEXT NOT NULL,
    function_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    updated_by TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, function_id)
  );
  CREATE TABLE automod_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    function_id TEXT NOT NULL,
    channel_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX automod_flags_active ON automod_flags (guild_id, user_id, function_id, expires_at);
  CREATE INDEX automod_flags_expiration ON automod_flags (expires_at);
  CREATE TABLE automod_whitelist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    function_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('user', 'role')),
    target_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (guild_id, function_id, target_type, target_id)
  );
  CREATE TABLE automod_raid_state (
    guild_id TEXT PRIMARY KEY NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    expires_at INTEGER
  );
  CREATE TABLE automod_lockdowns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (guild_id, channel_id)
  );
  CREATE TABLE automod_lockdown_overwrites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lockdown_id INTEGER NOT NULL REFERENCES automod_lockdowns (id),
    target_id TEXT NOT NULL,
    target_type INTEGER NOT NULL,
    permission TEXT NOT NULL,
    previous TEXT NOT NULL CHECK (previous IN ('allow', 'deny', 'inherit')),
    applied TEXT NOT NULL CHECK (applied IN ('allow', 'deny')),
    UNIQUE (lockdown_id, target_id, permission)
  );`,
  `ALTER TABLE oauth_states ADD COLUMN mode TEXT NOT NULL DEFAULT 'link';`,
  `CREATE TABLE levels (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
    messages INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX levels_leaderboard ON levels (guild_id, xp DESC);
  CREATE TABLE level_role_rewards (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL CHECK (level >= 1),
    role_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, level)
  );`,
  `UPDATE levels SET xp = 19999 WHERE xp > 19999;`,
  `DROP TABLE oauth_states;
  ALTER TABLE verifications ADD COLUMN expires_at INTEGER;`,
  `ALTER TABLE verifications ADD COLUMN nickname_managed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE verifications ADD COLUMN previous_nickname TEXT;
  UPDATE verifications SET nickname_managed = 1 WHERE expires_at IS NOT NULL;`,
  `ALTER TABLE verifications ADD COLUMN nickname_username TEXT;
  UPDATE verifications SET nickname_username = roblox_username WHERE nickname_managed = 1;`,
  `CREATE TABLE no_messages (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    enabled_at INTEGER,
    updated_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );`,
  `ALTER TABLE punishments ADD COLUMN case_number INTEGER;
  ALTER TABLE punishments ADD COLUMN user_name TEXT;
  ALTER TABLE punishments ADD COLUMN user_display_name TEXT;
  ALTER TABLE punishments ADD COLUMN moderator_name TEXT;
  ALTER TABLE punishments ADD COLUMN moderator_display_name TEXT;
  UPDATE punishments SET case_number = (
    SELECT COUNT(*) FROM punishments earlier
    WHERE earlier.guild_id = punishments.guild_id AND earlier.user_id IS NOT NULL
      AND (earlier.created_at < punishments.created_at OR (earlier.created_at = punishments.created_at AND earlier.id <= punishments.id))
  ) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX punishments_case ON punishments (guild_id, case_number);
  CREATE TABLE case_counters (
    guild_id TEXT PRIMARY KEY,
    last_case INTEGER NOT NULL
  );
  INSERT INTO case_counters (guild_id, last_case)
    SELECT guild_id, MAX(case_number) FROM punishments WHERE case_number IS NOT NULL GROUP BY guild_id;`,
  `ALTER TABLE punishments ADD COLUMN removed_at INTEGER;
  ALTER TABLE punishments ADD COLUMN removed_by TEXT;
  ALTER TABLE punishments ADD COLUMN removed_by_name TEXT;`,
  `CREATE TABLE chatbot_channels (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    enabled_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );
  CREATE INDEX chatbot_channels_owner ON chatbot_channels (guild_id, owner_user_id);`,
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
  db.pragma('secure_delete = ON');

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
