const { Events } = require('discord.js');
const automod = require('../services/automod');
const verification = require('../services/verification');

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    await automod.handleJoin(member);
    await verification.handleJoin(member);
  },
};
