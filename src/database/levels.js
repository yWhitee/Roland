const database = require('./index');

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
  prepare(`
    INSERT INTO levels (guild_id, user_id, xp, messages, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = xp + excluded.xp, messages = messages + 1, updated_at = excluded.updated_at
    RETURNING xp, messages
  `).get(guildId, userId, amount, now, now);

const setXp = (guildId, userId, xp, now = Date.now()) => {
  const db = database.get();
  return db.transaction(() => {
    const previous = get(guildId, userId)?.xp ?? 0;
    prepare(`
      INSERT INTO levels (guild_id, user_id, xp, messages, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp, updated_at = excluded.updated_at
    `).run(guildId, userId, xp, now, now);
    return { previous, xp };
  }).immediate();
};

const top = (guildId, limit) =>
  prepare('SELECT * FROM levels WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, length(user_id), user_id LIMIT ?').all(guildId, limit);

module.exports = { get, addXp, setXp, top };
