const { Events } = require('discord.js');
const automod = require('../services/automod');

module.exports = {
  name: Events.MessageCreate,
  execute: (message) => automod.handleMessage(message),
};
