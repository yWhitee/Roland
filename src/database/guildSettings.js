const database = require('./index');

const get = (guildId) => database.get().prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);

const enableLogs = (guildId, channelId) =>
  database.get().prepare(`
    INSERT INTO guild_settings (guild_id, log_channel_id, logs_enabled) VALUES (?, ?, 1)
    ON CONFLICT (guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id, logs_enabled = 1
  `).run(guildId, channelId);

const disableLogs = (guildId) => database.get().prepare('UPDATE guild_settings SET logs_enabled = 0 WHERE guild_id = ?').run(guildId);

module.exports = { get, enableLogs, disableLogs };
