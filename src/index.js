const path = require('node:path');
const { Client, Collection } = require('discord.js');
const config = require('./config');
const database = require('./database');
const { resolveIntents } = require('./intents');
const load = require('./loader');
const presence = require('./presence');
const automod = require('./services/automod');
const chatbot = require('./services/chatbot');
const verification = require('./services/verification');

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

const start = async () => {
  database.open();

  const { intents, capabilities } = await resolveIntents(config.token);
  automod.configure(capabilities);
  const client = new Client({ intents, presence: presence.options() });

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

  chatbot.configure(config.ollama);
  if (!verification.configure({ apiKey: config.roverApiKey })) console.log('Roblox verification is disabled until ROVER_API_KEY is set.');

  await client.login(config.token);
};

start().catch((error) => {
  console.error(`Failed to connect: ${error.message}`);
  process.exit(1);
});
