const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const levels = require('../services/levels');
const { profileEmbed } = require('../services/levels/messages');

module.exports = {
  data: new SlashCommandBuilder().setName('level').setDescription('Show your level, XP and progress to the next level'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const profile = levels.profile(interaction.guildId, interaction.user.id);
    if (profile.level >= 1) await levels.grantRewards(interaction.guild, interaction.member, profile.level);
    await interaction.editReply({ embeds: [profileEmbed(interaction.user, profile)] });
  },
};
