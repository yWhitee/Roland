const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const chatbot = require('../services/chatbot');
const chatbotAccess = require('../services/chatbotPermissions');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chatbot')
    .setDescription('Start or stop your private chatbot session in this channel')
    .addStringOption((option) =>
      option
        .setName('state')
        .setDescription('Turn the chatbot on or off in this channel')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const access = chatbotAccess.assertChatbotAccess(interaction);
    const channel = interaction.channel ?? (await interaction.guild.channels.fetch(interaction.channelId));
    if (!channel?.isTextBased() || channel.guild?.id !== interaction.guild.id) throw new UserError('The chatbot can only be used in a text channel of this server.');
    const now = interaction.createdTimestamp;

    if (interaction.options.getString('state', true) === 'off') {
      const current = chatbot.sessionIn(channel.id);
      if (current && current.ownerId !== interaction.user.id && access !== chatbotAccess.ACCESS.SERVER_OWNER) {
        throw new UserError(`This session belongs to <@${current.ownerId}>. Only they or the server owner can end it.`);
      }
      const session = await chatbot.disable({ guild: interaction.guild, channel, now });
      if (!session) throw new UserError(`The chatbot is already disabled in ${channel}.`);
      return interaction.editReply({ embeds: [successEmbed(`The chatbot session of <@${session.owner_user_id}> in ${channel} has ended.`)] });
    }

    if (!chatbot.canReply(channel)) throw new UserError(`I cannot send messages in ${channel}.`);
    const { status, session } = chatbot.enable({ guild: interaction.guild, channel, ownerId: interaction.user.id, now });
    if (status === 'already-enabled') throw new UserError(`Your chatbot session is already active in ${channel}.`);
    if (status === 'other-owner') {
      throw new UserError(`${channel} already has a chatbot session owned by <@${session.owner_user_id}>. Run /chatbot off here first to end it.`);
    }
    return interaction.editReply({
      embeds: [successEmbed(`The chatbot is now enabled in ${channel}. I will only answer your messages here; everyone else is ignored.`)],
    });
  },
  handleComponent: (interaction) => {
    const [, decision, id] = interaction.customId.split(':');
    return chatbot.handleDecision(interaction, decision, id);
  },
};
