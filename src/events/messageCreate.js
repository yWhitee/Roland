const { Events } = require('discord.js');
const automod = require('../services/automod');
const levels = require('../services/levels');
const noMessages = require('../services/noMessages');

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    const deleting = noMessages.handleMessage(message);
    const violation = await automod.handleMessage(message).catch((error) => {
      console.error('AutoMod failed to process a message:', error);
      return null;
    });
    if (!violation && !deleting) await levels.handleMessage(message);
    await deleting;
  },
};
