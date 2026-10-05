const { Events } = require('discord.js');
const chatbot = require('../services/chatbot');
const tickets = require('../services/tickets');

module.exports = {
  name: Events.ChannelDelete,
  execute(channel) {
    tickets.handleChannelDelete(channel);
    chatbot.handleChannelDelete(channel);
  },
};
