const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const moderation = require('../services/moderation');
const { recordEmbed } = require('../utils/embeds');
const { context } = require('../utils/interactions');
const options = require('../utils/options');
const { resolveTarget } = require('../utils/users');

module.exports = {
  level: Level.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Aplica timeout em um usuário')
    .addStringOption(options.user())
    .addStringOption(options.duration('Duração: 30s, 30m, 30h, 30d, 30w, 30mm, 30y (máximo 28 dias)'))
    .addStringOption(options.reason),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const record = await moderation.mute({
      ...context(interaction),
      target: await resolveTarget(interaction.guild, interaction.options.getString('usuario', true)),
      duration: interaction.options.getString('tempo', true),
      reason: interaction.options.getString('motivo', true),
    });
    await interaction.editReply({ embeds: [recordEmbed(record, 'Usuário mutado')] });
  },
};
