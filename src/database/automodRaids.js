const database = require('./index');

const get = (guildId) => database.get().prepare('SELECT * FROM automod_raid_state WHERE guild_id = ?').get(guildId);

const active = (guildId, now = Date.now()) => {
  const state = get(guildId);
  return state?.active && state.expires_at > now ? state : null;
};

const activate = (guildId, now, duration) => {
  const db = database.get();
  return db.transaction(() => {
    if (active(guildId, now)) return null;
    db.prepare(`
      INSERT INTO automod_raid_state (guild_id, active, started_at, expires_at) VALUES (?, 1, ?, ?)
      ON CONFLICT (guild_id) DO UPDATE SET active = 1, started_at = excluded.started_at, expires_at = excluded.expires_at
    `).run(guildId, now, now + duration);
    return get(guildId);
  }).immediate();
};

const deactivate = (guildId) => database.get().prepare('UPDATE automod_raid_state SET active = 0 WHERE guild_id = ? AND active = 1').run(guildId).changes;

const expired = (now = Date.now()) => database.get().prepare('SELECT * FROM automod_raid_state WHERE active = 1 AND expires_at <= ?').all(now);

const createLockdown = ({ guildId, channelId, reason, createdAt = Date.now() }) => {
  const { changes, lastInsertRowid } = database.get()
    .prepare('INSERT OR IGNORE INTO automod_lockdowns (guild_id, channel_id, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(guildId, channelId, reason, createdAt);
  return changes ? Number(lastInsertRowid) : null;
};

const addOverwrite = (lockdownId, { targetId, targetType, permission, previous, applied }) =>
  database.get().prepare(`
    INSERT OR IGNORE INTO automod_lockdown_overwrites (lockdown_id, target_id, target_type, permission, previous, applied) VALUES (?, ?, ?, ?, ?, ?)
  `).run(lockdownId, targetId, targetType, permission, previous, applied);

const lockdowns = (guildId) =>
  database.get().prepare('SELECT * FROM automod_lockdowns WHERE guild_id = ? ORDER BY id').all(guildId)
    .map((lockdown) => ({
      ...lockdown,
      overwrites: database.get().prepare('SELECT * FROM automod_lockdown_overwrites WHERE lockdown_id = ? ORDER BY id').all(lockdown.id),
    }));

const lockedGuilds = () => database.get().prepare('SELECT DISTINCT guild_id FROM automod_lockdowns').all().map((row) => row.guild_id);

const removeLockdown = (id) => {
  const db = database.get();
  db.transaction(() => {
    db.prepare('DELETE FROM automod_lockdown_overwrites WHERE lockdown_id = ?').run(id);
    db.prepare('DELETE FROM automod_lockdowns WHERE id = ?').run(id);
  })();
};

module.exports = { get, active, activate, deactivate, expired, createLockdown, addOverwrite, lockdowns, lockedGuilds, removeLockdown };
