const { Events } = require('discord.js');
const chatbot = require('../services/chatbot');

module.exports = {
  name: Events.GuildUpdate,
  execute: (oldGuild, newGuild) => chatbot.handleOwnerChange(oldGuild, newGuild),
};
