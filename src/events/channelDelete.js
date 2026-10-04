const { Events } = require('discord.js');
const tickets = require('../services/tickets');

module.exports = {
  name: Events.ChannelDelete,
  execute(channel) {
    tickets.handleChannelDelete(channel);
  },
};
