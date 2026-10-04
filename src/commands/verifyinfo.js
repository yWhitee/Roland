const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const verifications = require('../database/verifications');
const { Level } = require('../permissions');
const { infoEmbed } = require('../services/verification/messages');
const options = require('../utils/options');
const { resolveUser } = require('../utils/users');

module.exports = {
  level: Level.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('verifyinfo')
    .setDescription("Show a user's linked Roblox account")
    .addStringOption(options.user()),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = await resolveUser(interaction.client, interaction.options.getString('user', true));
    await interaction.editReply({ embeds: [infoEmbed(user, verifications.findByDiscord(user.id))] });
  },
};
