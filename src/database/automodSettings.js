const database = require('./index');

const enabledFunctions = (guildId) =>
  new Set(database.get().prepare('SELECT function_id FROM automod_settings WHERE guild_id = ? AND enabled = 1').all(guildId).map((row) => row.function_id));

const set = (guildId, functionId, enabled, updatedBy, updatedAt = Date.now()) =>
  database.get().prepare(`
    INSERT INTO automod_settings (guild_id, function_id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, function_id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(guildId, functionId, enabled ? 1 : 0, updatedBy, updatedAt);

module.exports = { enabledFunctions, set };
