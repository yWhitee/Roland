const { Events } = require('discord.js');
const automod = require('../services/automod');
const levels = require('../services/levels');

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    const violation = await automod.handleMessage(message).catch((error) => {
      console.error('AutoMod failed to process a message:', error);
      return null;
    });
    if (!violation) await levels.handleMessage(message);
  },
};
