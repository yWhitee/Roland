const database = require('./index');

const countActive = (guildId, userId, functionId, now = Date.now()) =>
  database.get()
    .prepare('SELECT COUNT(*) AS total FROM automod_flags WHERE guild_id = ? AND user_id = ? AND function_id = ? AND expires_at > ?')
    .get(guildId, userId, functionId, now).total;

const add = ({ guildId, userId, functionId, channelId = null, createdAt = Date.now(), duration }) => {
  const db = database.get();
  return db.transaction(() => {
    db.prepare('INSERT INTO automod_flags (guild_id, user_id, function_id, channel_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guildId, userId, functionId, channelId, createdAt, createdAt + duration);
    return countActive(guildId, userId, functionId, createdAt);
  }).immediate();
};

const purgeExpired = (now = Date.now()) => database.get().prepare('DELETE FROM automod_flags WHERE expires_at <= ?').run(now).changes;

module.exports = { add, countActive, purgeExpired };
