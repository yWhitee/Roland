const { Events } = require('discord.js');
const chatbot = require('../services/chatbot');

module.exports = {
  name: Events.GuildMemberRemove,
  execute: (member) => chatbot.handleLeave(member),
};
