const { Events } = require('discord.js');
const { registerCommands } = require('../commandRegistration');
const config = require('../config');
const automod = require('../services/automod');
const levels = require('../services/levels');
const presence = require('../presence');
const tempBans = require('../services/tempBans');
const verification = require('../services/verification');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log(`Logged in as ${client.user.tag}`);
    presence.report(client);
    tempBans.start(client);
    automod.start(client);
    levels.start();
    verification.startCleanup(client);

    if (client.application.id !== config.clientId) console.warn(`DISCORD_CLIENT_ID ${config.clientId} does not match the bot's application ${client.application.id}.`);
    const { guild, global } = await registerCommands(client.rest, { clientId: client.application.id, guildId: config.guildId, commands: [...client.commands.values()] });
    console.log(`Registered ${guild.length} guild command(s) in guild ${config.guildId} and ${global.length} global command(s): ${global.join(', ')}`);
  },
};
