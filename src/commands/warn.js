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
    .setName('warn')
    .setDescription('Aplica um aviso a um usuário')
    .addStringOption(options.user())
    .addStringOption(options.reason),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { record, dmSent } = await moderation.warn({
      ...context(interaction),
      target: await resolveTarget(interaction.guild, interaction.options.getString('usuario', true)),
      reason: interaction.options.getString('motivo', true),
    });
    const embed = recordEmbed(record, 'Aviso aplicado').addFields({
      name: 'Mensagem privada',
      value: dmSent ? 'Enviada ao usuário.' : 'Não foi possível enviar (DMs fechadas ou bloqueadas).',
    });
    await interaction.editReply({ embeds: [embed] });
  },
};
