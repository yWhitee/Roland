const { OverwriteType, PermissionFlagsBits } = require('discord.js');
const { Tickets, rolesAtLeast } = require('../../permissions');
const { Status } = require('../../database/tickets');

const MEMBER_ACCESS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

const BOT_ACCESS = [...MEMBER_ACCESS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages];

const STAFF_LEVEL = {
  [Status.OPEN]: Tickets.STAFF,
  [Status.CLAIMED]: Tickets.RETAINED_AFTER_CLAIM,
  [Status.CLOSED]: Tickets.MANAGER,
};

const PREFIX = {
  [Status.OPEN]: 'ticket-',
  [Status.CLAIMED]: '⚞ticket-',
  [Status.CLOSED]: 'closed-ticket-',
};

const number = (ticket) => String(ticket.number).padStart(4, '0');

const ticketName = (ticket) => `ticket-${number(ticket)}`;

const channelName = (ticket) => `${PREFIX[ticket.status]}${number(ticket)}`;

const overwrites = (guild, ticket) => {
  const entries = new Map();
  const allow = (id, type, permissions = MEMBER_ACCESS) => entries.set(id, { id, type, allow: permissions });

  entries.set(guild.id, { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
  for (const roleId of rolesAtLeast(STAFF_LEVEL[ticket.status])) {
    if (guild.roles.cache.has(roleId)) allow(roleId, OverwriteType.Role);
  }
  if (ticket.status !== Status.CLOSED) allow(ticket.creator_id, OverwriteType.Member);
  if (ticket.status === Status.CLAIMED) allow(ticket.claimed_by, OverwriteType.Member);
  allow(guild.client.user.id, OverwriteType.Member, BOT_ACCESS);

  return [...entries.values()];
};

module.exports = { ticketName, channelName, overwrites };
