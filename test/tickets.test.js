const test = require('node:test');
const assert = require('node:assert/strict');
const database = require('../src/database');
const guildSettings = require('../src/database/guildSettings');
const ticketStore = require('../src/database/tickets');
const tickets = require('../src/services/tickets');
const { ROLES } = require('../src/permissions');
const { UserError } = require('../src/utils/errors');
const { addCategory, canView, makeGuild, makeInteraction, makeMember, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
const ALL_ROLES = Object.values(ROLES);

test.before(() => database.open(file));
test.after(() => database.close());

const restart = () => {
  database.close();
  database.open(file);
};

const setup = ({ roles = ALL_ROLES } = {}) => {
  const guild = makeGuild({ roles });
  const category = addCategory(guild);
  guildSettings.enableLogs(guild.id, guild.logChannel.id);
  return { guild, category };
};

const publish = async (guild, category) => {
  const channel = await guild.channels.create({ name: 'create-a-ticket' });
  const panel = await tickets.publishPanel(channel, { embeds: [] }, { categoryId: category.id, createdBy: 'admin' });
  return { panel, message: channel.sent.at(-1) };
};

const openTicket = async (guild, panel, member, fields = { roblox: 'ExamplePlayer', reason: 'I need help with my purchase.' }) => {
  const interaction = makeInteraction({ guild, member, customId: `ticket:form:${panel.id}`, fields });
  const ticket = await tickets.open(interaction, String(panel.id));
  return { ticket, channel: guild.channels.cache.get(ticket.channel_id), interaction };
};

const act = (action, guild, member, ticket) => tickets[action](makeInteraction({ guild, member }), String(ticket.id));

const controlMessage = (channel) => channel.sent[0];
const buttons = (message) => message.components.flatMap((row) => row.toJSON().components.map((component) => component.label));
const fields = (message) => Object.fromEntries(message.embeds[0].toJSON().fields.map((field) => [field.name, field.value]));
const logTitles = (guild) => guild.logChannel.sent.map((message) => message.embeds[0].toJSON().title);

test('opening a ticket creates a private, numbered channel in the panel category', async () => {
  const { guild, category } = setup();
  const { panel, message } = await publish(guild, category);
  assert.deepEqual(buttons(message), ['Open Ticket']);

  const creator = makeMember();
  const prompt = makeInteraction({ guild, member: creator, customId: 'ticket:open', message });
  await tickets.promptOpen(prompt);
  const modal = prompt.calls.modals[0].toJSON();
  assert.equal(modal.custom_id, `ticket:form:${panel.id}`);
  assert.deepEqual(modal.components.map((label) => label.label), ['Roblox Username', 'Reason']);

  const { ticket, channel, interaction } = await openTicket(guild, panel, creator);
  assert.equal(channel.name, 'ticket-0001');
  assert.equal(channel.parentId, category.id);
  assert.equal(ticket.status, 'OPEN');
  assert.equal(ticket.number, 1);
  assert.equal(ticket.creator_id, creator.id);
  assert.equal(ticket.roblox_username, 'ExamplePlayer');
  assert.equal(ticket.reason, 'I need help with my purchase.');
  assert.equal(ticket.panel_id, panel.id);
  assert.match(interaction.calls.replies[0].embeds[0].data.description, /Your ticket has been created/);

  assert.ok(canView(channel, creator), 'creator');
  for (const role of ALL_ROLES) assert.ok(canView(channel, makeMember(role)), role);
  assert.ok(!canView(channel, makeMember()), 'other members cannot see the ticket');

  const control = controlMessage(channel);
  assert.equal(ticket.control_message_id, control.id);
  assert.equal(control.content, `<@&${ROLES.SUPPORT}> <@${creator.id}>`);
  assert.deepEqual(control.allowedMentions, { users: [creator.id], roles: [ROLES.SUPPORT] });
  assert.deepEqual(buttons(control), ['Claim', 'Close']);
  const embed = control.embeds[0].toJSON();
  assert.equal(embed.title, 'Ticket Opened');
  assert.match(embed.description, /Please explain what happened/);
  assert.deepEqual(Object.keys(fields(control)), ['Ticket', 'Opened by', 'Roblox Username', 'Reason', 'Created']);
  assert.equal(fields(control).Ticket, '`ticket-0001`');
  assert.equal(fields(control)['Roblox Username'], '`ExamplePlayer`');

  assert.deepEqual(logTitles(guild), ['Tickets • Ticket Created']);
});

test('a member can only have one open ticket, even with simultaneous submissions', async () => {
  const { guild, category } = setup();
  const { panel, message } = await publish(guild, category);
  const creator = makeMember();

  const results = await Promise.allSettled([openTicket(guild, panel, creator), openTicket(guild, panel, creator)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  const { channel } = results.find((result) => result.status === 'fulfilled').value;

  const again = makeInteraction({ guild, member: creator, customId: 'ticket:open', message });
  await assert.rejects(tickets.promptOpen(again), (error) => error instanceof UserError && error.message.includes(`<#${channel.id}>`));
  assert.equal(again.calls.modals.length, 0);
  await assert.rejects(openTicket(guild, panel, creator), /already have an open ticket/);
  assert.equal([...guild.channels.cache.values()].filter((item) => item.name?.startsWith('ticket-')).length, 1);
});

test('simultaneous users receive different sequential numbers that survive restarts', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);

  const opened = await Promise.all([1, 2, 3].map(() => openTicket(guild, panel, makeMember())));
  assert.deepEqual(opened.map(({ ticket }) => ticket.number).sort(), [1, 2, 3]);
  assert.deepEqual(opened.map(({ channel }) => channel.name).sort(), ['ticket-0001', 'ticket-0002', 'ticket-0003']);

  restart();
  const { channel } = await openTicket(guild, panel, makeMember());
  assert.equal(channel.name, 'ticket-0004');
});

test('invalid input, missing categories and missing panels are rejected cleanly', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);

  await assert.rejects(openTicket(guild, panel, makeMember(), { roblox: 'no spaces allowed', reason: 'r' }), /Invalid Roblox username/);
  await assert.rejects(openTicket(guild, panel, makeMember(), { roblox: 'Player', reason: '   ' }), /provide a reason/);
  await assert.rejects(tickets.open(makeInteraction({ guild, member: makeMember(), fields: { roblox: 'Player', reason: 'r' } }), '999999'), /no longer active/);
  await assert.rejects(tickets.promptOpen(makeInteraction({ guild, member: makeMember(), message: { id: 'gone' } })), /no longer active/);

  guild.channels.cache.delete(category.id);
  const member = makeMember();
  await assert.rejects(openTicket(guild, panel, member), /category for this ticket panel no longer exists/);
  assert.equal(ticketStore.findActiveByCreator(guild.id, member.id), undefined);
});

test('tickets still work when the Support role is missing', async () => {
  const { guild, category } = setup({ roles: [ROLES.MODERATOR, ROLES.SENIOR_MODERATOR, ROLES.ADMINISTRATOR, ROLES.CREATOR] });
  const { panel } = await publish(guild, category);
  const creator = makeMember();
  const { channel } = await openTicket(guild, panel, creator);

  assert.equal(controlMessage(channel).content, `<@${creator.id}>`);
  assert.ok(!channel.overwrites.some((overwrite) => overwrite.id === ROLES.SUPPORT));
  assert.ok(canView(channel, makeMember(ROLES.MODERATOR)));
});

test('every staff rank can claim, normal members cannot', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);

  const { ticket } = await openTicket(guild, panel, makeMember());
  await assert.rejects(act('claim', guild, makeMember(), ticket), /Only ticket staff/);
  assert.equal(ticketStore.findById(ticket.id).status, 'OPEN');

  for (const role of [ROLES.SUPPORT, ROLES.MODERATOR, ROLES.SENIOR_MODERATOR, ROLES.ADMINISTRATOR, ROLES.CREATOR]) {
    const { ticket: next } = await openTicket(guild, panel, makeMember());
    const staff = makeMember(role);
    const claimed = await act('claim', guild, staff, next);
    assert.equal(claimed.status, 'CLAIMED', role);
    assert.equal(claimed.claimed_by, staff.id, role);
  }
});

test('claiming renames the channel, updates the controls and restricts access', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);
  const creator = makeMember();
  const { ticket, channel } = await openTicket(guild, panel, creator);

  const claimant = makeMember(ROLES.SUPPORT);
  const before = Date.now();
  await act('claim', guild, claimant, ticket);

  assert.equal(channel.name, '⚞ticket-0001');
  const control = controlMessage(channel);
  assert.deepEqual(buttons(control), ['Close']);
  assert.equal(fields(control)['Claimed by'], `<@${claimant.id}>`);
  assert.equal(channel.sent[1].embeds[0].toJSON().description, `<@${claimant.id}> has claimed this ticket. This ticket is now their responsibility.`);

  const stored = ticketStore.findById(ticket.id);
  assert.equal(stored.status, 'CLAIMED');
  assert.equal(stored.claimed_by, claimant.id);
  assert.ok(stored.claimed_at >= before);

  assert.ok(canView(channel, creator), 'creator keeps access');
  assert.ok(canView(channel, claimant), 'claimant keeps access');
  assert.ok(!canView(channel, makeMember(ROLES.SUPPORT)), 'other Support loses access');
  assert.ok(!canView(channel, makeMember(ROLES.MODERATOR)), 'other Moderators lose access');
  assert.ok(canView(channel, makeMember(ROLES.SENIOR_MODERATOR)), 'Senior Moderator keeps access');
  assert.ok(canView(channel, makeMember(ROLES.ADMINISTRATOR)), 'Administrator keeps access');
  assert.ok(canView(channel, makeMember(ROLES.CREATOR)), 'Owner keeps access');
  assert.ok(!canView(channel, makeMember()), 'members still cannot see it');

  await assert.rejects(act('claim', guild, makeMember(ROLES.MODERATOR), ticket), /already been claimed/);
  assert.deepEqual(logTitles(guild), ['Tickets • Ticket Created', 'Tickets • Ticket Claimed']);
});

test('a Moderator claimant keeps access while other Moderators lose it', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);
  const { ticket, channel } = await openTicket(guild, panel, makeMember());

  const claimant = makeMember(ROLES.MODERATOR);
  await act('claim', guild, claimant, ticket);
  assert.ok(canView(channel, claimant));
  assert.ok(!canView(channel, makeMember(ROLES.MODERATOR)));
  assert.ok(!canView(channel, makeMember(ROLES.SUPPORT)));
});

test('two staff members cannot claim the same ticket at the same time', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);
  const { ticket, channel } = await openTicket(guild, panel, makeMember());

  const results = await Promise.allSettled([
    act('claim', guild, makeMember(ROLES.SUPPORT), ticket),
    act('claim', guild, makeMember(ROLES.MODERATOR), ticket),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(channel.edits, 1);

  const raced = await Promise.allSettled([act('close', guild, makeMember(ROLES.ADMINISTRATOR), ticket), act('claim', guild, makeMember(ROLES.SUPPORT), ticket)]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(ticketStore.findById(ticket.id).status, 'CLOSED');
});

test('closing requires a claim and the claimant or an Administrator', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);
  const creator = makeMember();
  const { ticket, channel } = await openTicket(guild, panel, creator);

  await assert.rejects(act('close', guild, makeMember(ROLES.ADMINISTRATOR), ticket), /must be claimed before it can be closed/);
  assert.equal(ticketStore.findById(ticket.id).status, 'OPEN');

  const claimant = makeMember(ROLES.SUPPORT);
  await act('claim', guild, claimant, ticket);
  for (const role of [null, ROLES.SUPPORT, ROLES.MODERATOR, ROLES.SENIOR_MODERATOR]) {
    await assert.rejects(act('close', guild, makeMember(role), ticket), /Only the staff member who claimed this ticket/, String(role));
  }
  await assert.rejects(act('close', guild, creator, ticket), /Only the staff member/);

  const before = Date.now();
  const closed = await act('close', guild, claimant, ticket);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.closed_by, claimant.id);
  assert.ok(closed.closed_at >= before);
  assert.equal(channel.name, 'closed-ticket-0001');
  assert.deepEqual(buttons(controlMessage(channel)), []);

  const notice = channel.sent.at(-1);
  assert.equal(notice.embeds[0].toJSON().title, 'Ticket Closed');
  assert.equal(notice.embeds[0].toJSON().description, `This ticket was closed by <@${claimant.id}>.`);
  assert.deepEqual(Object.keys(fields(notice)), ['Closed']);
  assert.deepEqual(buttons(notice), ['Delete Ticket']);

  assert.ok(!canView(channel, creator), 'creator loses access');
  assert.ok(!canView(channel, claimant), 'Support claimant loses access');
  assert.ok(!canView(channel, makeMember(ROLES.MODERATOR)));
  assert.ok(!canView(channel, makeMember(ROLES.SENIOR_MODERATOR)));
  assert.ok(canView(channel, makeMember(ROLES.ADMINISTRATOR)));
  assert.ok(canView(channel, makeMember(ROLES.CREATOR)));

  await assert.rejects(act('claim', guild, makeMember(ROLES.SUPPORT), ticket), /closed and can no longer be claimed/);
  await assert.rejects(act('close', guild, claimant, ticket), /already closed/);
  assert.ok(ticketStore.findActiveByCreator(guild.id, creator.id) === undefined, 'the creator can open a new ticket');
});

test('Administrators and the Owner can close tickets claimed by someone else', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);

  for (const role of [ROLES.ADMINISTRATOR, ROLES.CREATOR]) {
    const { ticket, channel } = await openTicket(guild, panel, makeMember());
    await act('claim', guild, makeMember(ROLES.MODERATOR), ticket);
    const closer = makeMember(role);
    await act('close', guild, closer, ticket);
    assert.equal(ticketStore.findById(ticket.id).closed_by, closer.id);
    assert.match(channel.name, /^closed-ticket-/);
  }
});

test('an Administrator claimant keeps access after closing through their role', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);
  const { ticket, channel } = await openTicket(guild, panel, makeMember());

  const admin = makeMember(ROLES.ADMINISTRATOR);
  await act('claim', guild, admin, ticket);
  await act('close', guild, admin, ticket);
  assert.ok(canView(channel, admin));
});

test('only Administrators and the Owner can delete closed tickets', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);
  const creator = makeMember();
  const { ticket, channel } = await openTicket(guild, panel, creator);

  const claimant = makeMember(ROLES.SENIOR_MODERATOR);
  await assert.rejects(act('remove', guild, makeMember(ROLES.ADMINISTRATOR), ticket), /Only closed tickets/);
  await act('claim', guild, claimant, ticket);
  await act('close', guild, claimant, ticket);

  for (const member of [creator, claimant, makeMember(ROLES.SUPPORT), makeMember(ROLES.MODERATOR), makeMember()]) {
    await assert.rejects(act('remove', guild, member, ticket), /Only Administrators can delete tickets/);
  }
  assert.ok(guild.channels.cache.has(channel.id));

  const admin = makeMember(ROLES.ADMINISTRATOR);
  const deleted = await act('remove', guild, admin, ticket);
  assert.equal(deleted.status, 'DELETED');
  assert.equal(deleted.deleted_by, admin.id);
  assert.ok(channel.deleted);
  assert.ok(!guild.channels.cache.has(channel.id));

  tickets.handleChannelDelete(channel);
  assert.equal(ticketStore.findById(ticket.id).deleted_by, admin.id);

  for (const action of ['claim', 'close', 'remove']) {
    await assert.rejects(act(action, guild, makeMember(ROLES.CREATOR), ticket), /no longer exists/, action);
  }
  assert.deepEqual(logTitles(guild), ['Tickets • Ticket Created', 'Tickets • Ticket Claimed', 'Tickets • Ticket Closed', 'Tickets • Ticket Deleted']);
  const log = guild.logChannel.sent.at(-1).embeds[0].toJSON();
  const logFields = Object.fromEntries(log.fields.map((field) => [field.name, field.value]));
  assert.equal(logFields.Ticket, '`ticket-0001`');
  assert.equal(logFields.Staff, `<@${admin.id}>`);
  assert.equal(logFields.Transition, 'CLOSED → DELETED');
  assert.equal(logFields['Roblox Username'], '`ExamplePlayer`');

  const second = await openTicket(guild, panel, makeMember());
  const owner = makeMember(ROLES.CREATOR);
  await act('claim', guild, owner, second.ticket);
  await act('close', guild, owner, second.ticket);
  await act('remove', guild, owner, second.ticket);
  assert.ok(second.channel.deleted);
});

test('ticket and panel state survive a restart', async () => {
  const { guild, category } = setup();
  const { panel, message } = await publish(guild, category);
  const creator = makeMember();
  const { ticket, channel } = await openTicket(guild, panel, creator);
  const claimant = makeMember(ROLES.MODERATOR);
  await act('claim', guild, claimant, ticket);

  restart();

  const stored = ticketStore.findById(ticket.id);
  assert.equal(stored.status, 'CLAIMED');
  assert.equal(stored.claimed_by, claimant.id);
  await assert.rejects(tickets.promptOpen(makeInteraction({ guild, member: creator, message })), /already have an open ticket/);

  const other = makeInteraction({ guild, member: makeMember(), message });
  await tickets.promptOpen(other);
  assert.equal(other.calls.modals[0].toJSON().custom_id, `ticket:form:${panel.id}`);

  await act('close', guild, claimant, ticket);
  assert.equal(channel.name, 'closed-ticket-0001');
});

test('a manually deleted ticket channel frees the creator and old buttons fail gracefully', async () => {
  const { guild, category } = setup();
  const { panel, message } = await publish(guild, category);
  const creator = makeMember();
  const { ticket, channel } = await openTicket(guild, panel, creator);

  await channel.delete();
  tickets.handleChannelDelete(channel);
  assert.equal(ticketStore.findById(ticket.id).status, 'DELETED');
  await assert.rejects(act('claim', guild, makeMember(ROLES.SUPPORT), ticket), /no longer exists/);

  const prompt = makeInteraction({ guild, member: creator, message });
  await tickets.promptOpen(prompt);
  assert.equal(prompt.calls.modals.length, 1);

  const { ticket: second, channel: secondChannel } = await openTicket(guild, panel, creator);
  guild.channels.cache.delete(secondChannel.id);
  await assert.rejects(act('claim', guild, makeMember(ROLES.SUPPORT), second), /channel for this ticket no longer exists/);
  assert.equal(ticketStore.findById(second.id).status, 'DELETED');
});

test('a failed channel creation does not leave a ticket behind', async () => {
  const { guild, category } = setup();
  const { panel } = await publish(guild, category);
  const member = makeMember();
  guild.channels.create = async () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013 }));

  await assert.rejects(openTicket(guild, panel, member), { code: 50013 });
  assert.equal(ticketStore.findActiveByCreator(guild.id, member.id), undefined);
});
