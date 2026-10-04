const { ChannelType, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const embedBuilder = require('../services/embedBuilder');
const tickets = require('../services/tickets');
const { UserError } = require('../utils/errors');

module.exports = {
  level: Level.ADMINISTRATOR,
  data: new SlashCommandBuilder()
    .setName('ticketcreate')
    .setDescription('Create a ticket panel with a customizable embed')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel where the ticket panel will be sent')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addStringOption((option) =>
      option.setName('categoryid').setDescription('ID of the category where ticket channels will be created').setRequired(true).setMaxLength(20),
    ),
  async execute(interaction) {
    const channel = interaction.options.getChannel('channel', true);
    if (!interaction.guild.channels.cache.get(channel.id)?.isTextBased()) throw new UserError('Invalid channel.');
    const category = tickets.resolveCategory(interaction.guild, interaction.options.getString('categoryid', true));

    await embedBuilder.start(interaction, {
      prefix: 'ticketcreate',
      title: 'Ticket Panel Builder',
      channel,
      note: `The panel will be sent to ${channel} with an **Open Ticket** button. Tickets will be created in the **${category.name}** category.`,
      deliver: (target, payload) => tickets.publishPanel(target, payload, { categoryId: category.id, createdBy: interaction.user.id }),
    });
  },
  handleComponent: embedBuilder.handle,
};
