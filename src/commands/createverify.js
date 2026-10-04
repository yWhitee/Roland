const { ChannelType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const embedBuilder = require('../services/embedBuilder');
const verification = require('../services/verification');
const { PANEL, panelEmbed } = require('../services/verification/messages');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

const NOT_CONFIGURED = '\nNote: Roblox OAuth is not configured yet, so the button will not work until ROBLOX_CLIENT_ID, ROBLOX_CLIENT_SECRET and ROBLOX_REDIRECT_URI are set.';

module.exports = {
  level: Level.CREATOR,
  data: new SlashCommandBuilder()
    .setName('createverify')
    .setDescription('Create a Roblox verification panel')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel where the verification panel will be sent')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Send the standard panel or customize it first')
        .setRequired(true)
        .addChoices({ name: 'standard', value: 'standard' }, { name: 'custom', value: 'custom' }),
    ),
  async execute(interaction) {
    const channel = interaction.guild.channels.cache.get(interaction.options.getChannel('channel', true).id);
    if (!channel?.isTextBased()) throw new UserError('Invalid channel.');
    const createdBy = interaction.user.id;

    if (interaction.options.getString('type', true) === 'custom') {
      return embedBuilder.start(interaction, {
        prefix: 'createverify',
        title: 'Verification Panel Builder',
        channel,
        initial: PANEL,
        note: `The panel will be sent to ${channel}. The **Verify with Roblox** button is added automatically.`,
        deliver: (target, payload) => verification.publishPanel(target, payload, { type: 'custom', createdBy }),
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await verification.publishPanel(channel, { embeds: [panelEmbed()] }, { type: 'standard', createdBy });
    const note = verification.isConfigured() ? '' : NOT_CONFIGURED;
    return interaction.editReply({ embeds: [successEmbed(`Verification panel sent to ${channel}.${note}`)] });
  },
  handleComponent: embedBuilder.handle,
};
