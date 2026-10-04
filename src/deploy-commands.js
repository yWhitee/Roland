const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { token, clientId, guildId } = require('./config');
const load = require('./loader');

const commands = load(path.join(__dirname, 'commands')).map((command) => command.data.toJSON());

new REST()
  .setToken(token)
  .put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
  .then((data) => console.log(`Registered ${data.length} command(s) in guild ${guildId}`))
  .catch((error) => {
    console.error(`Failed to register commands: ${error.message}`);
    process.exit(1);
  });
