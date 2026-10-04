const database = require('./index');

const findById = (id) => database.get().prepare('SELECT * FROM ticket_panels WHERE id = ?').get(id);

const findByMessage = (messageId) => database.get().prepare('SELECT * FROM ticket_panels WHERE message_id = ?').get(messageId);

const create = ({ guildId, channelId, messageId, categoryId, createdBy, createdAt = Date.now() }) => {
  const { lastInsertRowid } = database.get().prepare(`
    INSERT INTO ticket_panels (guild_id, channel_id, message_id, category_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, channelId, messageId, categoryId, createdBy, createdAt, createdAt);
  return findById(lastInsertRowid);
};

module.exports = { create, findById, findByMessage };
