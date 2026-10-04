const { ChannelType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const logging = require('../services/logging');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  level: Level.ADMINISTRATOR,
  data: new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Enable or disable moderation and ticket logs')
    .addStringOption((option) =>
      option
        .setName('state')
        .setDescription('Turn logs on or off')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel that will receive the logs (required for on)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (interaction.options.getString('state', true) === 'off') {
      logging.disable(interaction.guild);
      return interaction.editReply({ embeds: [successEmbed('Logs disabled.')] });
    }

    const option = interaction.options.getChannel('channel');
    if (!option) throw new UserError('Provide a channel to enable logs, e.g. /logs on #mod-logs');
    const channel = await interaction.guild.channels.fetch(option.id).catch(() => null);
    if (!channel?.isTextBased()) throw new UserError('Invalid channel.');

    await logging.enable(interaction.guild, channel, interaction.member);
    return interaction.editReply({ embeds: [successEmbed(`Logs enabled in ${channel}.`)] });
  },
};
