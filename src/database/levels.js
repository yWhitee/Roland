const database = require('./index');

const MAX_XP = 19_999;
const MAX_LEVEL_XP = 19_900;

const statements = new WeakMap();

const prepare = (sql) => {
  const db = database.get();
  if (!statements.has(db)) statements.set(db, new Map());
  const cache = statements.get(db);
  if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
  return cache.get(sql);
};

const get = (guildId, userId) => prepare('SELECT * FROM levels WHERE guild_id = ? AND user_id = ?').get(guildId, userId);

const addXp = (guildId, userId, amount, now = Date.now()) =>
  database.get().transaction(() => {
    const previous = get(guildId, userId)?.xp ?? 0;
    const xp = previous >= MAX_LEVEL_XP ? previous : Math.min(previous + amount, MAX_XP);
    const { messages } = prepare(`
      INSERT INTO levels (guild_id, user_id, xp, messages, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp, messages = messages + 1, updated_at = excluded.updated_at
      RETURNING messages
    `).get(guildId, userId, xp, now, now);
    return { previous, xp, gained: xp - previous, messages };
  }).immediate();

const setXp = (guildId, userId, xp, now = Date.now()) =>
  database.get().transaction(() => {
    const previous = get(guildId, userId)?.xp ?? 0;
    const value = Math.min(Math.max(xp, 0), MAX_XP);
    prepare(`
      INSERT INTO levels (guild_id, user_id, xp, messages, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp, updated_at = excluded.updated_at
    `).run(guildId, userId, value, now, now);
    return { previous, xp: value };
  }).immediate();

const ranked = (guildId, limit, offset = 0) =>
  prepare('SELECT * FROM levels WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, length(user_id), user_id LIMIT ? OFFSET ?').all(guildId, limit, offset);

const atLeast = (guildId, xp) => prepare('SELECT * FROM levels WHERE guild_id = ? AND xp >= ? ORDER BY xp DESC').all(guildId, xp);

module.exports = { MAX_XP, MAX_LEVEL_XP, get, addXp, setXp, ranked, atLeast };
