const database = require('./index');

const Status = { OPEN: 'OPEN', CLAIMED: 'CLAIMED', CLOSED: 'CLOSED', DELETED: 'DELETED' };

const TRANSITIONS = {
  [Status.CLAIMED]: { from: Status.OPEN, column: 'claimed' },
  [Status.CLOSED]: { from: Status.CLAIMED, column: 'closed' },
  [Status.DELETED]: { from: Status.CLOSED, column: 'deleted' },
};

const findById = (id) => database.get().prepare('SELECT * FROM tickets WHERE id = ?').get(id);

const findByChannel = (channelId) => database.get().prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);

const findActiveByCreator = (guildId, creatorId) =>
  database.get()
    .prepare("SELECT * FROM tickets WHERE guild_id = ? AND creator_id = ? AND status IN ('OPEN', 'CLAIMED')")
    .get(guildId, creatorId);

const reserve = ({ guildId, panelId, creatorId, robloxUsername, reason, createdAt = Date.now() }) => {
  const db = database.get();
  return db.transaction(() => {
    const active = findActiveByCreator(guildId, creatorId);
    if (active) return { ticket: null, active };

    db.prepare(`
      INSERT INTO ticket_counters (guild_id, last_number) VALUES (?, 1)
      ON CONFLICT (guild_id) DO UPDATE SET last_number = last_number + 1
    `).run(guildId);
    const { last_number: number } = db.prepare('SELECT last_number FROM ticket_counters WHERE guild_id = ?').get(guildId);

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO tickets (guild_id, number, panel_id, creator_id, roblox_username, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `).run(guildId, number, panelId, creatorId, robloxUsername, reason, createdAt);

    return { ticket: findById(lastInsertRowid), active: null };
  }).immediate();
};

const setChannel = (id, channelId) => {
  database.get().prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(channelId, id);
  return findById(id);
};

const setControlMessage = (id, messageId) => {
  database.get().prepare('UPDATE tickets SET control_message_id = ? WHERE id = ?').run(messageId, id);
  return findById(id);
};

const discard = (id) => database.get().prepare("DELETE FROM tickets WHERE id = ? AND status = 'OPEN'").run(id).changes;

const transition = (id, status, actorId, at = Date.now()) => {
  const rule = TRANSITIONS[status];
  if (!rule) throw new Error(`Unsupported ticket transition to ${status}`);

  const { changes } = database.get()
    .prepare(`UPDATE tickets SET status = ?, ${rule.column}_by = ?, ${rule.column}_at = ? WHERE id = ? AND status = ?`)
    .run(status, actorId, at, id, rule.from);
  return changes ? findById(id) : null;
};

const markOrphaned = (id, at = Date.now()) =>
  database.get().prepare("UPDATE tickets SET status = 'DELETED', deleted_at = ? WHERE id = ? AND status != 'DELETED'").run(at, id).changes;

module.exports = {
  Status,
  findById,
  findByChannel,
  findActiveByCreator,
  reserve,
  setChannel,
  setControlMessage,
  discard,
  transition,
  markOrphaned,
};
