const { ChannelType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const noMessages = require('../services/noMessages');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  level: Level.ADMINISTRATOR,
  data: new SlashCommandBuilder()
    .setName('nomessages')
    .setDescription('Delete every new message sent in a channel')
    .addStringOption((option) =>
      option
        .setName('state')
        .setDescription('Turn no-messages mode on or off')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel where new messages will be deleted')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const enabled = interaction.options.getString('state', true) === 'on';
    const option = interaction.options.getChannel('channel', true);
    const channel = await interaction.guild.channels.fetch(option.id).catch(() => null);
    if (!channel?.isTextBased() || channel.guild?.id !== interaction.guild.id) throw new UserError('Invalid channel.');
    if (enabled && !noMessages.canDelete(channel)) {
      throw new UserError(`I do not have the Manage Messages permission in ${channel}, so I cannot delete messages there.`);
    }

    const changed = noMessages.setEnabled({ guild: interaction.guild, channel, enabled, updatedBy: interaction.user.id, now: interaction.createdTimestamp });
    if (!changed) throw new UserError(`No-messages mode is already ${enabled ? 'enabled' : 'disabled'} in ${channel}.`);
    return interaction.editReply({
      embeds: [
        successEmbed(
          enabled
            ? `No-messages mode is now enabled in ${channel}. New messages sent there will be deleted.`
            : `No-messages mode is now disabled in ${channel}. Messages sent there will no longer be deleted.`,
        ),
      ],
    });
  },
};
