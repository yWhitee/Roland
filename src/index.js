const path = require('node:path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const config = require('./config');
const database = require('./database');
const load = require('./loader');
const verification = require('./services/verification');
const web = require('./web/server');

database.open();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration] });

client.commands = new Collection(load(path.join(__dirname, 'commands')).map((command) => [command.data.name, command]));
client.components = new Collection(load(path.join(__dirname, 'components')).map((component) => [component.prefix, component]));

for (const event of load(path.join(__dirname, 'events'))) {
  client[event.once ? 'once' : 'on'](event.name, async (...args) => {
    try {
      await event.execute(...args);
    } catch (error) {
      console.error(`Error in event ${event.name}:`, error);
    }
  });
}

if (verification.configure({ ...config.roblox, client })) {
  web.start({ [verification.callbackPath()]: verification.handleCallback }, config.oauthServer);
} else {
  console.log('Roblox verification is disabled until ROBLOX_CLIENT_ID, ROBLOX_CLIENT_SECRET and ROBLOX_REDIRECT_URI are set.');
}

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

client.login(config.token).catch((error) => {
  console.error(`Failed to connect: ${error.message}`);
  process.exit(1);
});
