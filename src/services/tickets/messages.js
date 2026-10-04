const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { Status } = require('../../database/tickets');
const { Colors } = require('../../utils/embeds');
const { ticketName } = require('./access');

const fullTime = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;

const button = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

const panelComponents = () => [new ActionRowBuilder().addComponents(button('ticket:open', 'Open Ticket', ButtonStyle.Primary))];

const formModal = (panelId) =>
  new ModalBuilder()
    .setCustomId(`ticket:form:${panelId}`)
    .setTitle('Open a Ticket')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Roblox Username')
        .setDescription('Your exact Roblox username (not your display name).')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('roblox').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(20).setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('Reason')
        .setDescription('Briefly describe why you are opening this ticket.')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true),
        ),
    );

const infoEmbed = (ticket) => {
  const embed = new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Ticket Opened')
    .setDescription('Please explain what happened in as much detail as possible. A member of the support team will assist you as soon as possible.')
    .addFields(
      { name: 'Ticket', value: `\`${ticketName(ticket)}\``, inline: true },
      { name: 'Opened by', value: `<@${ticket.creator_id}>`, inline: true },
      { name: 'Roblox Username', value: `\`${ticket.roblox_username}\``, inline: true },
      { name: 'Reason', value: ticket.reason },
      { name: 'Created', value: fullTime(ticket.created_at) },
    );
  if (ticket.claimed_by) embed.addFields({ name: 'Claimed by', value: `<@${ticket.claimed_by}>` });
  return embed;
};

const controls = (ticket) => {
  const buttons = [];
  if (ticket.status === Status.OPEN) buttons.push(button(`ticket:claim:${ticket.id}`, 'Claim', ButtonStyle.Success));
  if (ticket.status === Status.OPEN || ticket.status === Status.CLAIMED) buttons.push(button(`ticket:close:${ticket.id}`, 'Close', ButtonStyle.Danger));
  return buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
};

const controlMessage = (ticket, supportRoleId) => ({
  content: [supportRoleId && `<@&${supportRoleId}>`, `<@${ticket.creator_id}>`].filter(Boolean).join(' '),
  embeds: [infoEmbed(ticket)],
  components: controls(ticket),
  allowedMentions: { users: [ticket.creator_id], roles: supportRoleId ? [supportRoleId] : [] },
});

const claimedMessage = (ticket) => ({
  embeds: [
    new EmbedBuilder()
      .setColor(Colors.success)
      .setDescription(`<@${ticket.claimed_by}> has claimed this ticket. This ticket is now their responsibility.`),
  ],
});

const closedMessage = (ticket) => ({
  embeds: [
    new EmbedBuilder()
      .setColor(Colors.error)
      .setTitle('Ticket Closed')
      .setDescription(`This ticket was closed by <@${ticket.closed_by}>.`)
      .addFields({ name: 'Closed', value: fullTime(ticket.closed_at) }),
  ],
  components: [new ActionRowBuilder().addComponents(button(`ticket:delete:${ticket.id}`, 'Delete Ticket', ButtonStyle.Danger))],
});

const EVENTS = {
  created: { title: 'Ticket Created', color: Colors.info, transition: 'NEW → OPEN', at: 'created_at' },
  claimed: { title: 'Ticket Claimed', color: Colors.success, transition: 'OPEN → CLAIMED', at: 'claimed_at', staff: 'claimed_by' },
  closed: { title: 'Ticket Closed', color: Colors.warning, transition: 'CLAIMED → CLOSED', at: 'closed_at', staff: 'closed_by' },
  deleted: { title: 'Ticket Deleted', color: Colors.error, transition: 'CLOSED → DELETED', at: 'deleted_at', staff: 'deleted_by' },
};

const logEmbed = (ticket, event) => {
  const { title, color, transition, at, staff } = EVENTS[event];
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`Tickets • ${title}`)
    .addFields(
      { name: 'Ticket', value: `\`${ticketName(ticket)}\``, inline: true },
      { name: 'Channel', value: `<#${ticket.channel_id}> (\`${ticket.channel_id}\`)`, inline: true },
      { name: 'User', value: `<@${ticket.creator_id}>`, inline: true },
    );
  if (staff) embed.addFields({ name: 'Staff', value: `<@${ticket[staff]}>`, inline: true });
  return embed
    .addFields(
      { name: 'Roblox Username', value: `\`${ticket.roblox_username}\``, inline: true },
      { name: 'Transition', value: transition, inline: true },
      { name: 'Reason', value: ticket.reason },
      { name: 'Timestamp', value: fullTime(ticket[at]) },
    )
    .setTimestamp(ticket[at]);
};

module.exports = { panelComponents, formModal, controlMessage, infoEmbed, controls, claimedMessage, closedMessage, logEmbed };
