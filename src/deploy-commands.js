const path = require('node:path');
const { REST } = require('discord.js');
const { registerCommands } = require('./commandRegistration');
const { token, clientId, guildId } = require('./config');
const load = require('./loader');

registerCommands(new REST().setToken(token), { clientId, guildId, commands: load(path.join(__dirname, 'commands')) })
  .then(({ guild, global }) => console.log(`Registered ${guild} guild command(s) in guild ${guildId} and ${global} global command(s)`))
  .catch((error) => {
    console.error(`Failed to register commands: ${error.message}`);
    process.exit(1);
  });
