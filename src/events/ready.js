const { Events } = require('discord.js');
const tempBans = require('../services/tempBans');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`Conectado como ${client.user.tag}`);
    tempBans.start(client);
  },
};
