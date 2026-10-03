const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { token, clientId, guildId } = require('./config');
const load = require('./loader');

const commands = load(path.join(__dirname, 'commands')).map((command) => command.data.toJSON());

new REST()
  .setToken(token)
  .put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
  .then((data) => console.log(`${data.length} comando(s) registrado(s) no servidor ${guildId}`))
  .catch((error) => {
    console.error(`Falha ao registrar comandos: ${error.message}`);
    process.exit(1);
  });
