const database = require('./index');

const findById = (id) => database.get().prepare('SELECT * FROM verification_panels WHERE id = ?').get(id);

const findByMessage = (messageId) => database.get().prepare('SELECT * FROM verification_panels WHERE message_id = ?').get(messageId);

const create = ({ guildId, channelId, messageId, type, createdBy, createdAt = Date.now() }) => {
  const { lastInsertRowid } = database.get().prepare(`
    INSERT INTO verification_panels (guild_id, channel_id, message_id, type, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, channelId, messageId, type, createdBy, createdAt);
  return findById(lastInsertRowid);
};

module.exports = { create, findById, findByMessage };
