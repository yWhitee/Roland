const path = require('node:path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const { token } = require('./config');
const database = require('./database');
const load = require('./loader');

database.open();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration] });

client.commands = new Collection(load(path.join(__dirname, 'commands')).map((command) => [command.data.name, command]));

for (const event of load(path.join(__dirname, 'events'))) {
  client[event.once ? 'once' : 'on'](event.name, async (...args) => {
    try {
      await event.execute(...args);
    } catch (error) {
      console.error(`Erro no evento ${event.name}:`, error);
    }
  });
}

process.on('unhandledRejection', (error) => console.error('Erro não tratado:', error));

client.login(token).catch((error) => {
  console.error(`Falha ao conectar: ${error.message}`);
  process.exit(1);
});
