const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const levels = require('../services/levels');
const { leaderboardEmbed } = require('../services/levels/messages');

module.exports = {
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('Show the 10 members with the most XP'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({ embeds: [leaderboardEmbed(levels.leaderboard(interaction.guild), levels.levelFor)] });
  },
};
