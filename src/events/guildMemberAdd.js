const { Events } = require('discord.js');
const automod = require('../services/automod');

module.exports = {
  name: Events.GuildMemberAdd,
  execute: (member) => automod.handleJoin(member),
};
