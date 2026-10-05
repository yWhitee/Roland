const database = require('./index');

const get = (guildId, channelId) => database.get().prepare('SELECT * FROM no_messages WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId);

const listEnabled = () => database.get().prepare('SELECT channel_id, enabled_at FROM no_messages WHERE enabled = 1').all();

const set = ({ guildId, channelId, enabled, updatedBy, now = Date.now() }) => {
  const db = database.get();
  return db.transaction(() => {
    const current = get(guildId, channelId);
    if (Boolean(current?.enabled) === enabled) return { changed: false, setting: current ?? null };
    db.prepare(`
      INSERT INTO no_messages (guild_id, channel_id, enabled, enabled_at, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, channel_id) DO UPDATE SET
        enabled = excluded.enabled, enabled_at = excluded.enabled_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(guildId, channelId, enabled ? 1 : 0, enabled ? now : null, updatedBy, now, now);
    return { changed: true, setting: get(guildId, channelId) };
  }).immediate();
};

module.exports = { get, listEnabled, set };
