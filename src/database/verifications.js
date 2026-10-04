const database = require('./index');

const findByDiscord = (discordId) => database.get().prepare('SELECT * FROM verifications WHERE discord_id = ?').get(discordId);

const findByRoblox = (robloxId) => database.get().prepare('SELECT * FROM verifications WHERE roblox_id = ?').get(robloxId);

const link = ({ discordId, robloxId, robloxUsername, robloxDisplayName = null, guildId = null, verifiedAt = Date.now() }) => {
  const db = database.get();
  return db.transaction(() => {
    const existing = findByDiscord(discordId);
    if (existing) return { status: existing.roblox_id === robloxId ? 'already-verified' : 'discord-linked', verification: existing };
    if (findByRoblox(robloxId)) return { status: 'roblox-linked', verification: null };

    db.prepare(`
      INSERT INTO verifications (discord_id, roblox_id, roblox_username, roblox_display_name, guild_id, verified_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(discordId, robloxId, robloxUsername, robloxDisplayName, guildId, verifiedAt);
    return { status: 'linked', verification: findByDiscord(discordId) };
  }).immediate();
};

module.exports = { findByDiscord, findByRoblox, link };
