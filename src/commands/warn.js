const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const moderation = require('../services/moderation');
const { recordEmbed, withDmStatus } = require('../utils/embeds');
const { context } = require('../utils/interactions');
const options = require('../utils/options');
const { resolveTarget } = require('../utils/users');

module.exports = {
  level: Level.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a user')
    .addStringOption(options.user())
    .addStringOption(options.reason),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { record, dmSent } = await moderation.warn({
      ...context(interaction),
      target: await resolveTarget(interaction.guild, interaction.options.getString('user', true)),
      reason: interaction.options.getString('reason', true),
    });
    await interaction.editReply({ embeds: [withDmStatus(recordEmbed(record, 'Warning issued'), dmSent)] });
  },
};
