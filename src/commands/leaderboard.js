const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const levels = require('../services/levels');
const { leaderboardEmbed } = require('../services/levels/messages');

module.exports = {
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('Show the top 10 members by XP'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({ embeds: [leaderboardEmbed(await levels.leaderboard(interaction.guild))] });
  },
};
