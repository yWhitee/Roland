const path = require('node:path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const { token } = require('./config');
const load = require('./loader');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.commands = new Collection(load(path.join(__dirname, 'commands')).map((command) => [command.data.name, command]));

for (const event of load(path.join(__dirname, 'events'))) {
  client[event.once ? 'once' : 'on'](event.name, (...args) => event.execute(...args));
}

client.login(token).catch((error) => {
  console.error(`Falha ao conectar: ${error.message}`);
  process.exit(1);
});
