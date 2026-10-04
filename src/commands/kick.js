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
    .setName('kick')
    .setDescription('Expulsa um usuário do servidor')
    .addStringOption(options.user())
    .addStringOption(options.reason),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const record = await moderation.kick({
      ...context(interaction),
      target: await resolveTarget(interaction.guild, interaction.options.getString('usuario', true)),
      reason: interaction.options.getString('motivo', true),
    });
    await interaction.editReply({ embeds: [recordEmbed(record, 'Usuário expulso')] });
  },
};
