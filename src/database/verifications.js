const database = require('./index');

const findByDiscord = (discordId) => database.get().prepare('SELECT * FROM verifications WHERE discord_id = ?').get(discordId);

const findByRoblox = (robloxId) => database.get().prepare('SELECT * FROM verifications WHERE roblox_id = ?').get(robloxId);

const link = ({ discordId, robloxId, robloxUsername, robloxDisplayName = null, guildId = null, verifiedAt = Date.now(), replace = false }) => {
  const db = database.get();
  return db.transaction(() => {
    const existing = findByDiscord(discordId);
    const owner = findByRoblox(robloxId);
    if (owner && owner.discord_id !== discordId) return { status: 'roblox-linked', verification: existing ?? null };

    if (existing?.roblox_id === robloxId) {
      if (replace) {
        db.prepare('UPDATE verifications SET roblox_username = ?, roblox_display_name = ? WHERE discord_id = ?').run(robloxUsername, robloxDisplayName, discordId);
      }
      return { status: 'already-verified', verification: findByDiscord(discordId) };
    }
    if (existing && !replace) return { status: 'discord-linked', verification: existing };

    if (existing) {
      db.prepare(`
        UPDATE verifications SET roblox_id = ?, roblox_username = ?, roblox_display_name = ?, guild_id = ?, verified_at = ? WHERE discord_id = ?
      `).run(robloxId, robloxUsername, robloxDisplayName, guildId, verifiedAt, discordId);
      return { status: 'relinked', verification: findByDiscord(discordId), previous: existing };
    }

    db.prepare(`
      INSERT INTO verifications (discord_id, roblox_id, roblox_username, roblox_display_name, guild_id, verified_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(discordId, robloxId, robloxUsername, robloxDisplayName, guildId, verifiedAt);
    return { status: 'linked', verification: findByDiscord(discordId) };
  }).immediate();
};

module.exports = { findByDiscord, findByRoblox, link };
