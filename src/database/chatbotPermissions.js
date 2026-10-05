const database = require('./index');

const get = (guildId, userId) => database.get().prepare('SELECT * FROM chatbot_permissions WHERE guild_id = ? AND user_id = ?').get(guildId, userId);

const set = ({ guildId, userId, enabled, updatedBy, now = Date.now() }) => {
  const db = database.get();
  return db.transaction(() => {
    if (Boolean(get(guildId, userId)?.enabled) === enabled) return false;
    db.prepare(`
      INSERT INTO chatbot_permissions (guild_id, user_id, enabled, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(guildId, userId, enabled ? 1 : 0, now, now, updatedBy);
    return true;
  }).immediate();
};

module.exports = { get, set };
