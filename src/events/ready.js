const { Events } = require('discord.js');
const automod = require('../services/automod');
const levels = require('../services/levels');
const presence = require('../presence');
const tempBans = require('../services/tempBans');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`Logged in as ${client.user.tag}`);
    presence.report(client);
    tempBans.start(client);
    automod.start(client);
    levels.start();
  },
};
