const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const moderation = require('../services/moderation');
const { recordEmbed, withDmStatus } = require('../utils/embeds');
const { context } = require('../utils/interactions');
const options = require('../utils/options');
const { resolveTarget } = require('../utils/users');

module.exports = {
  level: Level.SENIOR_MODERATOR,
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user from the server')
    .addStringOption(options.user())
    .addStringOption(options.duration('Duration: 30s, 30m, 30h, 30d, 30w, 30mm, 30y or forever'))
    .addStringOption(options.reason),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { record, dmSent } = await moderation.ban({
      ...context(interaction),
      target: await resolveTarget(interaction.guild, interaction.options.getString('user', true)),
      duration: interaction.options.getString('duration', true),
      reason: interaction.options.getString('reason', true),
    });
    await interaction.editReply({ embeds: [withDmStatus(recordEmbed(record, 'User banned'), dmSent)] });
  },
};
