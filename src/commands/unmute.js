const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const moderation = require('../services/moderation');
const { recordEmbed } = require('../utils/embeds');
const { context } = require('../utils/interactions');
const options = require('../utils/options');
const { resolveTarget } = require('../utils/users');

module.exports = {
  level: Level.SENIOR_MODERATOR,
  data: new SlashCommandBuilder()
    .setName('unmute')
    .setDescription("Remove a user's timeout")
    .addStringOption(options.user())
    .addStringOption(options.reason),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const record = await moderation.unmute({
      ...context(interaction),
      target: await resolveTarget(interaction.guild, interaction.options.getString('user', true)),
      reason: interaction.options.getString('reason', true),
    });
    await interaction.editReply({ embeds: [recordEmbed(record, 'User unmuted')] });
  },
};
