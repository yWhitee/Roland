const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const chatbot = require('../services/chatbot');
const chatbotAccess = require('../services/chatbotPermissions');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chatbotbypass')
    .setDescription('Run chatbot actions in this channel without confirmation (server owner only)')
    .addStringOption((option) =>
      option
        .setName('state')
        .setDescription('on runs actions without confirmation, off asks first')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    chatbotAccess.assertServerOwner(interaction);
    const enabled = interaction.options.getString('state', true) === 'on';
    const channel = interaction.channel ?? (await interaction.guild.channels.fetch(interaction.channelId));
    if (!channel || channel.guild?.id !== interaction.guild.id) throw new UserError('Use this command in the channel of a chatbot session.');

    const status = chatbot.setBypass({ guild: interaction.guild, channel, enabled, updatedBy: interaction.user.id, now: interaction.createdTimestamp });
    if (status === 'no-session') throw new UserError(`There is no active chatbot session in ${channel}. Start one with /chatbot on first.`);
    if (status === 'unchanged') throw new UserError(`Confirmation bypass is already ${enabled ? 'on' : 'off'} in ${channel}.`);
    return interaction.editReply({
      embeds: [
        successEmbed(
          enabled
            ? `Confirmation bypass is now on in ${channel}: chatbot actions run without confirmation. Permissions, role hierarchy, cases, logs and the kick/ban rule still apply.`
            : `Confirmation bypass is now off in ${channel}: every chatbot change needs confirmation first.`,
        ),
      ],
    });
  },
};
