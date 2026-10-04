const database = require('./index');

const toRecord = (row) => row && { ...row, active: Boolean(row.active), metadata: row.metadata ? JSON.parse(row.metadata) : null };

const findById = (id) => toRecord(database.get().prepare('SELECT * FROM punishments WHERE id = ?').get(id));

const create = (data) => {
  const { lastInsertRowid } = database.get().prepare(`
    INSERT INTO punishments (type, guild_id, user_id, moderator_id, reason, duration, created_at, expires_at, active, channel_id, metadata)
    VALUES (@type, @guildId, @userId, @moderatorId, @reason, @duration, @createdAt, @expiresAt, @active, @channelId, @metadata)
  `).run({
    type: data.type,
    guildId: data.guildId,
    userId: data.userId ?? null,
    moderatorId: data.moderatorId,
    reason: data.reason ?? null,
    duration: data.duration ?? null,
    createdAt: data.createdAt ?? Date.now(),
    expiresAt: data.expiresAt ?? null,
    active: data.active ? 1 : 0,
    channelId: data.channelId ?? null,
    metadata: data.metadata ? JSON.stringify(data.metadata) : null,
  });

  return findById(lastInsertRowid);
};

const listByUser = (guildId, userId, limit, offset = 0) =>
  database.get()
    .prepare('SELECT * FROM punishments WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(guildId, userId, limit, offset)
    .map(toRecord);

const countByUser = (guildId, userId) =>
  database.get().prepare('SELECT COUNT(*) AS total FROM punishments WHERE guild_id = ? AND user_id = ?').get(guildId, userId).total;

const dueBans = (now = Date.now()) =>
  database.get()
    .prepare("SELECT * FROM punishments WHERE type = 'ban' AND active = 1 AND expires_at <= ? ORDER BY expires_at")
    .all(now)
    .map(toRecord);

const deactivateBans = (guildId, userId) =>
  database.get()
    .prepare("UPDATE punishments SET active = 0 WHERE type = 'ban' AND active = 1 AND guild_id = ? AND user_id = ?")
    .run(guildId, userId).changes;

module.exports = { create, findById, listByUser, countByUser, dueBans, deactivateBans };
