const { Events } = require('discord.js');
const automod = require('../services/automod');
const tempBans = require('../services/tempBans');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`Logged in as ${client.user.tag}`);
    tempBans.start(client);
    automod.start(client);
  },
};
