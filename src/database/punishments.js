const database = require('./index');

const toRecord = (row) => row && { ...row, active: Boolean(row.active), metadata: row.metadata ? JSON.parse(row.metadata) : null };

const findById = (id) => toRecord(database.get().prepare('SELECT * FROM punishments WHERE id = ?').get(id));

const nextCase = (guildId) =>
  database.get().prepare(`
    INSERT INTO case_counters (guild_id, last_case) VALUES (?, 1)
    ON CONFLICT (guild_id) DO UPDATE SET last_case = last_case + 1
    RETURNING last_case
  `).get(guildId).last_case;

const create = (data) => {
  const db = database.get();
  return db.transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO punishments (
        type, guild_id, user_id, moderator_id, reason, duration, created_at, expires_at, active, channel_id, metadata, source, automod_function,
        case_number, user_name, user_display_name, moderator_name, moderator_display_name
      ) VALUES (
        @type, @guildId, @userId, @moderatorId, @reason, @duration, @createdAt, @expiresAt, @active, @channelId, @metadata, @source, @automodFunction,
        @caseNumber, @userName, @userDisplayName, @moderatorName, @moderatorDisplayName
      )
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
      source: data.source ?? 'moderator',
      automodFunction: data.automodFunction ?? null,
      caseNumber: data.userId ? nextCase(data.guildId) : null,
      userName: data.userName ?? null,
      userDisplayName: data.userDisplayName ?? null,
      moderatorName: data.moderatorName ?? null,
      moderatorDisplayName: data.moderatorDisplayName ?? null,
    });
    return findById(lastInsertRowid);
  }).immediate();
};

const findByCase = (guildId, caseNumber) =>
  toRecord(database.get().prepare('SELECT * FROM punishments WHERE guild_id = ? AND case_number = ?').get(guildId, caseNumber));

const listCases = (guildId, limit, offset = 0) =>
  database.get()
    .prepare('SELECT * FROM punishments WHERE guild_id = ? AND case_number IS NOT NULL ORDER BY case_number DESC LIMIT ? OFFSET ?')
    .all(guildId, limit, offset)
    .map(toRecord);

const countCases = (guildId) =>
  database.get().prepare('SELECT COUNT(*) AS total FROM punishments WHERE guild_id = ? AND case_number IS NOT NULL').get(guildId).total;

const countUserCases = (guildId, userId) =>
  database.get().prepare('SELECT COUNT(*) AS total FROM punishments WHERE guild_id = ? AND user_id = ? AND case_number IS NOT NULL').get(guildId, userId).total;

const removeCase = ({ guildId, userId, caseNumber, removedBy, removedByName, removedAt }) => {
  const db = database.get();
  return db.transaction(() => {
    const record = findByCase(guildId, caseNumber);
    if (!record) return { status: 'missing' };
    if (record.user_id !== userId) return { status: 'other-user' };
    if (record.removed_at) return { status: 'already-removed', record };
    db.prepare('UPDATE punishments SET removed_at = ?, removed_by = ?, removed_by_name = ? WHERE id = ?').run(removedAt, removedBy, removedByName, record.id);
    return { status: 'removed', record: findById(record.id) };
  }).immediate();
};

const removeUserCases = ({ guildId, userId, removedBy, removedByName, removedAt }) =>
  database.get()
    .prepare(`
      UPDATE punishments SET removed_at = ?, removed_by = ?, removed_by_name = ?
      WHERE guild_id = ? AND user_id = ? AND case_number IS NOT NULL AND removed_at IS NULL
      RETURNING case_number
    `)
    .all(removedAt, removedBy, removedByName, guildId, userId)
    .map((row) => row.case_number)
    .sort((a, b) => a - b);

const latestNames = (guildId, userId) =>
  database.get()
    .prepare('SELECT user_name, user_display_name FROM punishments WHERE guild_id = ? AND user_id = ? AND user_name IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(guildId, userId);

const listByUser = (guildId, userId, limit, offset = 0) =>
  database.get()
    .prepare('SELECT * FROM punishments WHERE guild_id = ? AND user_id = ? AND removed_at IS NULL ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(guildId, userId, limit, offset)
    .map(toRecord);

const countByUser = (guildId, userId) =>
  database.get().prepare('SELECT COUNT(*) AS total FROM punishments WHERE guild_id = ? AND user_id = ? AND removed_at IS NULL').get(guildId, userId).total;

const dueBans = (now = Date.now()) =>
  database.get()
    .prepare("SELECT * FROM punishments WHERE type = 'ban' AND active = 1 AND expires_at <= ? ORDER BY expires_at")
    .all(now)
    .map(toRecord);

const deactivateBans = (guildId, userId) =>
  database.get()
    .prepare("UPDATE punishments SET active = 0 WHERE type = 'ban' AND active = 1 AND guild_id = ? AND user_id = ?")
    .run(guildId, userId).changes;

module.exports = {
  create,
  findById,
  findByCase,
  listByUser,
  countByUser,
  listCases,
  countCases,
  countUserCases,
  removeCase,
  removeUserCases,
  latestNames,
  dueBans,
  deactivateBans,
};
