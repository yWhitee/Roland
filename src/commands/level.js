const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const levels = require('../services/levels');
const { profileEmbed } = require('../services/levels/messages');

module.exports = {
  data: new SlashCommandBuilder().setName('level').setDescription('Show your level and XP'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({ embeds: [profileEmbed(interaction.user, levels.profile(interaction.guildId, interaction.user.id))] });
  },
};
