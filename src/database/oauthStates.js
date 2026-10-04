const database = require('./index');

const create = ({ stateHash, discordId, guildId, panelId = null, mode = 'link', createdAt, expiresAt }) => {
  const db = database.get();
  db.transaction(() => {
    db.prepare('DELETE FROM oauth_states WHERE expires_at <= ? OR discord_id = ?').run(createdAt, discordId);
    db.prepare(`
      INSERT INTO oauth_states (state_hash, discord_id, guild_id, panel_id, mode, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(stateHash, discordId, guildId, panelId, mode, createdAt, expiresAt);
  })();
};

const consume = (stateHash) => database.get().prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING *').get(stateHash);

module.exports = { create, consume };
