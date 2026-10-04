const { Events } = require('discord.js');
const punishments = require('../database/punishments');

module.exports = {
  name: Events.GuildBanRemove,
  execute(ban) {
    punishments.deactivateBans(ban.guild.id, ban.user.id);
  },
};
