const database = require('./index');

const get = (guildId, channelId) => database.get().prepare('SELECT * FROM chatbot_channels WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId);

const listEnabled = () => database.get().prepare('SELECT channel_id, owner_user_id FROM chatbot_channels WHERE enabled = 1').all();

const enable = ({ guildId, channelId, ownerId, now = Date.now() }) => {
  const db = database.get();
  return db.transaction(() => {
    const current = get(guildId, channelId);
    if (current?.enabled) return { status: current.owner_user_id === ownerId ? 'already-enabled' : 'other-owner', session: current };
    db.prepare(`
      INSERT INTO chatbot_channels (guild_id, channel_id, owner_user_id, enabled, enabled_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT (guild_id, channel_id) DO UPDATE SET
        owner_user_id = excluded.owner_user_id, enabled = 1, enabled_at = excluded.enabled_at, updated_at = excluded.updated_at
    `).run(guildId, channelId, ownerId, now, now);
    return { status: 'enabled', session: get(guildId, channelId) };
  }).immediate();
};

const disable = ({ guildId, channelId, now = Date.now() }) =>
  database.get().prepare('UPDATE chatbot_channels SET enabled = 0, updated_at = ? WHERE guild_id = ? AND channel_id = ? AND enabled = 1 RETURNING *').get(now, guildId, channelId);

const disableOwnedBy = ({ guildId, ownerId, now = Date.now() }) =>
  database.get()
    .prepare('UPDATE chatbot_channels SET enabled = 0, updated_at = ? WHERE guild_id = ? AND owner_user_id = ? AND enabled = 1 RETURNING channel_id')
    .all(now, guildId, ownerId)
    .map((row) => row.channel_id);

module.exports = { get, listEnabled, enable, disable, disableOwnedBy };
