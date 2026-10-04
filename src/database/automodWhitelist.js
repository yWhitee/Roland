const database = require('./index');

const add = ({ guildId, functionId, targetType, targetId, createdBy, createdAt = Date.now() }) =>
  database.get().prepare(`
    INSERT OR IGNORE INTO automod_whitelist (guild_id, function_id, target_type, target_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, functionId, targetType, targetId, createdBy, createdAt).changes;

const remove = ({ guildId, functionId, targetType, targetId }) =>
  database.get()
    .prepare('DELETE FROM automod_whitelist WHERE guild_id = ? AND function_id = ? AND target_type = ? AND target_id = ?')
    .run(guildId, functionId, targetType, targetId).changes;

const list = (guildId) => database.get().prepare('SELECT * FROM automod_whitelist WHERE guild_id = ? ORDER BY id').all(guildId);

const bypasses = (guildId, userId, roleIds = []) =>
  new Set(
    database.get()
      .prepare(`
        SELECT DISTINCT function_id FROM automod_whitelist
        WHERE guild_id = ? AND ((target_type = 'user' AND target_id = ?) OR (target_type = 'role' AND target_id IN (SELECT value FROM json_each(?))))
      `)
      .all(guildId, userId, JSON.stringify(roleIds))
      .map((row) => row.function_id),
  );

module.exports = { add, remove, list, bypasses };
