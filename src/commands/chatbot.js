const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Chatbot } = require('../permissions');
const chatbot = require('../services/chatbot');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  level: Chatbot.OWNER,
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
    const channel = interaction.channel ?? (await interaction.guild.channels.fetch(interaction.channelId).catch(() => null));
    if (!channel?.isTextBased() || channel.guild?.id !== interaction.guild.id) throw new UserError('The chatbot can only be used in a text channel of this server.');
    const now = interaction.createdTimestamp;

    if (interaction.options.getString('state', true) === 'off') {
      const session = chatbot.disable({ guild: interaction.guild, channel, now });
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
};
