const { ChannelType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const logging = require('../services/logging');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  level: Level.ADMINISTRATOR,
  data: new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Ativa ou desativa as logs de moderação')
    .addStringOption((option) =>
      option
        .setName('estado')
        .setDescription('Ativar ou desativar')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    )
    .addChannelOption((option) =>
      option
        .setName('canal')
        .setDescription('Canal que receberá as logs (obrigatório para on)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (interaction.options.getString('estado', true) === 'off') {
      logging.disable(interaction.guild);
      return interaction.editReply({ embeds: [successEmbed('Logs de moderação desativadas.')] });
    }

    const option = interaction.options.getChannel('canal');
    if (!option) throw new UserError('Informe o canal para ativar as logs. Ex: /logs on #mod-logs');
    const channel = await interaction.guild.channels.fetch(option.id).catch(() => null);
    if (!channel?.isTextBased()) throw new UserError('Canal inválido.');

    await logging.enable(interaction.guild, channel, interaction.member);
    return interaction.editReply({ embeds: [successEmbed(`Logs de moderação ativadas em ${channel}.`)] });
  },
};
