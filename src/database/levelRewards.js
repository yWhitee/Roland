const database = require('./index');

const get = (guildId, level) => database.get().prepare('SELECT * FROM level_role_rewards WHERE guild_id = ? AND level = ?').get(guildId, level);

const set = (guildId, level, roleId, createdBy, now = Date.now()) => {
  const db = database.get();
  return db.transaction(() => {
    const previous = get(guildId, level);
    db.prepare(`
      INSERT INTO level_role_rewards (guild_id, level, role_id, created_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, level) DO UPDATE SET role_id = excluded.role_id, created_by = excluded.created_by, updated_at = excluded.updated_at
    `).run(guildId, level, roleId, createdBy, now);
    return previous?.role_id ?? null;
  }).immediate();
};

const upTo = (guildId, level) => database.get().prepare('SELECT * FROM level_role_rewards WHERE guild_id = ? AND level <= ? ORDER BY level').all(guildId, level);

const levelsForRole = (guildId, roleId) =>
  database.get().prepare('SELECT level FROM level_role_rewards WHERE guild_id = ? AND role_id = ? ORDER BY level').all(guildId, roleId).map((row) => row.level);

module.exports = { get, set, upTo, levelsForRole };
