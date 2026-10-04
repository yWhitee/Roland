const { ChannelType, MessageFlags, RESTJSONErrorCodes } = require('discord.js');
const ticketPanels = require('../../database/ticketPanels');
const tickets = require('../../database/tickets');
const permissions = require('../../permissions');
const logging = require('../logging');
const { successEmbed } = require('../../utils/embeds');
const { UserError } = require('../../utils/errors');
const { ticketName, channelName, overwrites } = require('./access');
const { panelComponents, formModal, controlMessage, infoEmbed, controls, claimedMessage, closedMessage, logEmbed } = require('./messages');

const { Status } = tickets;
const ROBLOX_USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const PENDING_TIMEOUT = 60_000;
const locks = new Set();

const ephemeral = { flags: MessageFlags.Ephemeral };

const withLock = async (id, task) => {
  if (locks.has(id)) throw new UserError('This ticket is already being updated. Please try again in a moment.');
  locks.add(id);
  try {
    return await task();
  } finally {
    locks.delete(id);
  }
};

const resolveCategory = (guild, input) => {
  const id = String(input ?? '').trim();
  if (!/^\d{17,20}$/.test(id)) throw new UserError('Invalid category ID. Provide the numeric ID of a category.');
  const category = guild.channels.cache.get(id);
  if (category?.type !== ChannelType.GuildCategory) throw new UserError('Category not found. Make sure the ID belongs to a category in this server.');
  return category;
};

const publishPanel = async (channel, payload, { categoryId, createdBy }) => {
  resolveCategory(channel.guild, categoryId);
  const message = await channel.send({ ...payload, components: panelComponents() });
  return ticketPanels.create({ guildId: channel.guild.id, channelId: channel.id, messageId: message.id, categoryId, createdBy });
};

const supportRole = (guild) => (guild.roles.cache.has(permissions.ROLES.SUPPORT) ? permissions.ROLES.SUPPORT : null);

const findTicket = (id) => {
  const ticket = tickets.findById(id);
  if (!ticket || ticket.status === Status.DELETED) throw new UserError('This ticket no longer exists.');
  return ticket;
};

const activeTicket = (guild, userId) => {
  const ticket = tickets.findActiveByCreator(guild.id, userId);
  if (!ticket) return null;

  const alive = ticket.channel_id ? guild.channels.cache.has(ticket.channel_id) : Date.now() - ticket.created_at < PENDING_TIMEOUT;
  if (alive) return ticket;

  tickets.markOrphaned(ticket.id);
  return null;
};

const alreadyOpen = (ticket) =>
  new UserError(
    ticket.channel_id
      ? `You already have an open ticket: <#${ticket.channel_id}>. Please use it instead of opening a new one.`
      : 'Your ticket is still being created. Please wait a moment.',
  );

const ticketChannel = async (guild, ticket) => {
  const channel = guild.channels.cache.get(ticket.channel_id) ?? (await guild.channels.fetch(ticket.channel_id).catch(() => null));
  if (channel) return channel;
  tickets.markOrphaned(ticket.id);
  throw new UserError('The channel for this ticket no longer exists.');
};

const refreshControls = async (channel, ticket) => {
  if (!ticket.control_message_id) return;
  try {
    const message = await channel.messages.fetch(ticket.control_message_id);
    await message.edit({ embeds: [infoEmbed(ticket)], components: controls(ticket) });
  } catch (error) {
    if (error.code !== RESTJSONErrorCodes.UnknownMessage) console.error(`Failed to update the controls of ${ticketName(ticket)}: ${error.message}`);
  }
};

const conflict = () => new UserError('This ticket was updated by someone else. Please try again.');

const promptOpen = async (interaction) => {
  const panel = ticketPanels.findByMessage(interaction.message.id);
  if (!panel) throw new UserError('This ticket panel is no longer active.');

  const existing = activeTicket(interaction.guild, interaction.user.id);
  if (existing) throw alreadyOpen(existing);

  await interaction.showModal(formModal(panel.id));
};

const open = async (interaction, panelId) => {
  await interaction.deferReply(ephemeral);
  const { guild, user } = interaction;

  const robloxUsername = interaction.fields.getTextInputValue('roblox').trim();
  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!ROBLOX_USERNAME.test(robloxUsername)) {
    throw new UserError('Invalid Roblox username. Usernames are 3-20 characters long and may only contain letters, numbers and underscores.');
  }
  if (!reason) throw new UserError('Please provide a reason for opening this ticket.');

  const panel = ticketPanels.findById(Number(panelId));
  if (!panel) throw new UserError('This ticket panel is no longer active.');
  const category = guild.channels.cache.get(panel.category_id);
  if (category?.type !== ChannelType.GuildCategory) {
    throw new UserError('The category for this ticket panel no longer exists. Please contact an administrator.');
  }

  activeTicket(guild, user.id);
  const { ticket: reserved, active } = tickets.reserve({ guildId: guild.id, panelId: panel.id, creatorId: user.id, robloxUsername, reason });
  if (active) throw alreadyOpen(active);

  let channel;
  let ticket;
  try {
    channel = await guild.channels.create({
      name: channelName(reserved),
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: overwrites(guild, reserved),
      reason: `Ticket opened by ${user.tag}`,
    });
    tickets.setChannel(reserved.id, channel.id);
    const message = await channel.send(controlMessage(reserved, supportRole(guild)));
    ticket = tickets.setControlMessage(reserved.id, message.id);
  } catch (error) {
    tickets.discard(reserved.id);
    await channel?.delete().catch(() => {});
    throw error;
  }

  await logging.sendEmbed(guild, logEmbed(ticket, 'created'));
  await interaction.editReply({ embeds: [successEmbed(`Your ticket has been created: ${channel}`)] });
  return ticket;
};

const claim = (interaction, id) =>
  withLock(Number(id), async () => {
    await interaction.deferReply(ephemeral);
    const { guild, member } = interaction;
    if (!permissions.isTicketStaff(member)) throw new UserError('Only ticket staff can claim tickets.');

    const ticket = findTicket(Number(id));
    if (ticket.status === Status.CLAIMED) throw new UserError(`This ticket has already been claimed by <@${ticket.claimed_by}>.`);
    if (ticket.status !== Status.OPEN) throw new UserError('This ticket is closed and can no longer be claimed.');

    const channel = await ticketChannel(guild, ticket);
    const next = { ...ticket, status: Status.CLAIMED, claimed_by: member.id };
    await channel.edit({ name: channelName(next), permissionOverwrites: overwrites(guild, next), reason: `Ticket claimed by ${member.user.tag}` });

    const claimed = tickets.transition(ticket.id, Status.CLAIMED, member.id);
    if (!claimed) throw conflict();

    await refreshControls(channel, claimed);
    await channel.send(claimedMessage(claimed));
    await logging.sendEmbed(guild, logEmbed(claimed, 'claimed'));
    await interaction.editReply({ embeds: [successEmbed(`You claimed \`${ticketName(claimed)}\`.`)] });
    return claimed;
  });

const close = (interaction, id) =>
  withLock(Number(id), async () => {
    await interaction.deferReply(ephemeral);
    const { guild, member } = interaction;

    const ticket = findTicket(Number(id));
    if (ticket.status === Status.OPEN) throw new UserError('This ticket must be claimed before it can be closed.');
    if (ticket.status === Status.CLOSED) throw new UserError('This ticket is already closed.');
    if (!permissions.canCloseTicket(member, ticket)) {
      throw new UserError('Only the staff member who claimed this ticket or an Administrator can close it.');
    }

    const channel = await ticketChannel(guild, ticket);
    const next = { ...ticket, status: Status.CLOSED };
    await channel.edit({ name: channelName(next), permissionOverwrites: overwrites(guild, next), reason: `Ticket closed by ${member.user.tag}` });

    const closed = tickets.transition(ticket.id, Status.CLOSED, member.id);
    if (!closed) throw conflict();

    await refreshControls(channel, closed);
    await channel.send(closedMessage(closed));
    await logging.sendEmbed(guild, logEmbed(closed, 'closed'));
    await interaction.editReply({ embeds: [successEmbed(`\`${ticketName(closed)}\` has been closed.`)] });
    return closed;
  });

const remove = (interaction, id) =>
  withLock(Number(id), async () => {
    await interaction.deferReply(ephemeral);
    const { guild, member } = interaction;
    if (!permissions.canDeleteTicket(member)) throw new UserError('Only Administrators can delete tickets.');

    const ticket = findTicket(Number(id));
    if (ticket.status !== Status.CLOSED) throw new UserError('Only closed tickets can be deleted.');

    const channel = guild.channels.cache.get(ticket.channel_id) ?? (await guild.channels.fetch(ticket.channel_id).catch(() => null));
    await channel?.delete(`Ticket deleted by ${member.user.tag}`).catch((error) => {
      if (error.code !== RESTJSONErrorCodes.UnknownChannel) throw error;
    });

    const deleted = tickets.transition(ticket.id, Status.DELETED, member.id);
    if (!deleted) throw conflict();

    await logging.sendEmbed(guild, logEmbed(deleted, 'deleted'));
    await interaction.editReply({ embeds: [successEmbed(`\`${ticketName(deleted)}\` has been deleted.`)] }).catch(() => {});
    return deleted;
  });

const handleChannelDelete = (channel) => {
  const ticket = tickets.findByChannel(channel.id);
  if (ticket && !locks.has(ticket.id)) tickets.markOrphaned(ticket.id);
};

module.exports = { resolveCategory, publishPanel, promptOpen, open, claim, close, remove, handleChannelDelete };
