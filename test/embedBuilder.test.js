const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const database = require('../src/database');
const ticketPanels = require('../src/database/ticketPanels');
const sessions = require('../src/services/embedBuilder/sessions');
const embedBuilder = require('../src/services/embedBuilder');
const tickets = require('../src/services/tickets');
const { UserError } = require('../src/utils/errors');
const { addCategory, makeGuild, tempDatabase } = require('./helpers/discord');

const OWNER = '111111111111111111';

test.before(() => database.open(tempDatabase()));
test.after(() => database.close());

const interaction = (prefix, sessionId, action, extra = {}) => {
  const calls = { update: [], modal: [], reply: [] };
  return {
    calls,
    customId: `${prefix}:${sessionId}:${action}`,
    user: { id: OWNER },
    fields: {
      getTextInputValue: (id) => extra.values?.[id] ?? '',
      getStringSelectValues: () => extra.select ?? [],
    },
    values: extra.selected ?? [],
    update: async (payload) => calls.update.push(payload),
    showModal: async (modal) => calls.modal.push(modal),
    reply: async (payload) => calls.reply.push(payload),
    ...extra.props,
  };
};

const newSession = async (options = { prefix: 'embed' }) => {
  const start = { id: String(Date.now() + Math.random()), user: { id: OWNER }, reply: async (payload) => (start.panel = payload) };
  await embedBuilder.start(start, options);
  return start;
};

const channelWithPermissions = (granted, extra = {}) => ({
  id: 'channel',
  isTextBased: () => true,
  toString: () => '<#channel>',
  permissionsFor: () => ({ has: (permissions) => [].concat(permissions).every((permission) => granted.includes(permission)) }),
  sent: [],
  async send(payload) {
    this.sent.push(payload);
    return { id: `message-${Math.random()}` };
  },
  ...extra,
});

test('embed validation', () => {
  const session = sessions.create('validation', OWNER, { prefix: 'embed' });
  assert.throws(() => sessions.update(session, { image: 'not-a-url' }), /valid URL/);
  assert.throws(() => sessions.update(session, { color: 'blue' }), /Invalid color/);
  assert.throws(() => sessions.update(session, { authorIcon: 'https://a.com/i.png' }), /author name/);
  assert.throws(() => sessions.update(session, { footerIcon: 'https://a.com/i.png' }), /footer text/);
  assert.throws(() => sessions.update(session, { url: 'https://a.com' }), /title/);
  assert.throws(() => sessions.update(session, { description: 'a'.repeat(4000), fields: [{ name: 'n', value: 'v'.repeat(1024) }, { name: 'n', value: 'v'.repeat(1024) }] }), /6000/);
  assert.throws(() => sessions.assertNotEmpty(session.state), /empty/);

  sessions.update(session, {
    title: 'Title',
    url: 'https://example.com',
    description: 'Description',
    color: '#5865F2',
    authorName: 'Author',
    authorIcon: 'https://example.com/a.png',
    authorUrl: 'https://example.com',
    thumbnail: 'https://example.com/t.png',
    image: 'https://example.com/i.png',
    footer: 'Footer',
    footerIcon: 'https://example.com/f.png',
    timestamp: true,
    fields: [{ name: 'Field', value: 'Value', inline: true }],
  });
  const json = sessions.toEmbed(session.state, 1_000).toJSON();
  assert.equal(json.color, 0x5865f2);
  assert.equal(json.author.url, 'https://example.com');
  assert.equal(json.footer.icon_url, 'https://example.com/f.png');
  assert.equal(json.timestamp, new Date(1_000).toISOString());
  assert.equal(json.fields.length, 1);
  sessions.remove(session);
});

test('builder flow: sections, fields, timestamp and cancel', async () => {
  const { id, panel } = await newSession();
  assert.match(panel.content, /Embed Builder/);
  const labels = panel.components.flatMap((row) => row.toJSON().components.map((component) => component.label));
  assert.deepEqual(labels, [
    'Title & description', 'Author', 'Images', 'Footer', 'Message content',
    'Add field', 'Edit field', 'Remove field', 'Timestamp: off',
    'Preview', 'Clear', 'Send', 'Cancel',
  ]);

  const open = interaction('embed', id, 'section:body');
  await embedBuilder.handle(open);
  assert.equal(open.calls.modal[0].toJSON().custom_id, `embed:${id}:modal:body`);

  await embedBuilder.handle(interaction('embed', id, 'modal:body', { values: { title: ' Hello ', description: 'World', color: '#ff0000' } }));
  await embedBuilder.handle(interaction('embed', id, 'field:new', { values: { name: 'A', value: '1' }, select: ['yes'] }));
  await embedBuilder.handle(interaction('embed', id, 'field:new', { values: { name: 'B', value: '2' }, select: ['no'] }));
  await embedBuilder.handle(interaction('embed', id, 'field:0', { values: { name: 'A2', value: '1b' }, select: ['no'] }));
  await embedBuilder.handle(interaction('embed', id, 'timestamp'));

  const remove = interaction('embed', id, 'pickremove', { selected: ['1'] });
  await embedBuilder.handle(remove);
  const embed = remove.calls.update[0].embeds[0].toJSON();
  assert.equal(embed.title, 'Hello');
  assert.equal(embed.color, 0xff0000);
  assert.deepEqual(embed.fields, [{ name: 'A2', value: '1b', inline: false }]);
  assert.ok(embed.timestamp);

  const preview = interaction('embed', id, 'preview');
  await embedBuilder.handle(preview);
  assert.equal(preview.calls.reply[0].embeds[0].toJSON().title, 'Hello');

  await assert.rejects(embedBuilder.handle({ ...interaction('embed', id, 'reset'), user: { id: '222222222222222222' } }), /Only the person/);

  const cancel = interaction('embed', id, 'cancel');
  await embedBuilder.handle(cancel);
  assert.deepEqual(cancel.calls.update[0].components, []);
  assert.match(cancel.calls.update[0].content, /cancelled/);
  await assert.rejects(embedBuilder.handle(interaction('embed', id, 'preview')), /expired/);
});

test('sending requires channel permission and restricts mentions', async () => {
  const { id } = await newSession();
  await embedBuilder.handle(interaction('embed', id, 'modal:content', { values: { content: '@everyone news' } }));
  await assert.rejects(embedBuilder.handle(interaction('embed', id, 'send')), /empty/);
  await embedBuilder.handle(interaction('embed', id, 'modal:body', { values: { title: 'Notice' } }));

  let target;
  const deliver = (granted) => {
    target = channelWithPermissions(granted);
    return interaction('embed', id, 'channel', { selected: ['channel'], props: { member: {}, guild: { channels: { fetch: async () => target } } } });
  };

  await assert.rejects(embedBuilder.handle(deliver([PermissionFlagsBits.ViewChannel])), /permission/);
  assert.equal(target.sent.length, 0);

  const ok = deliver([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  await embedBuilder.handle(ok);
  assert.equal(target.sent.length, 1);
  assert.equal(target.sent[0].content, '@everyone news');
  assert.deepEqual(target.sent[0].allowedMentions, { parse: ['users'] });
  assert.match(ok.calls.update[0].content, /sent to/);
  await assert.rejects(embedBuilder.handle(interaction('embed', id, 'preview')), UserError);
});

test('/ticketcreate reuses the builder and publishes a panel with an Open Ticket button', async () => {
  const guild = makeGuild();
  const category = addCategory(guild);
  const target = channelWithPermissions([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], { guild });

  const { id, panel } = await newSession({
    prefix: 'ticketcreate',
    title: 'Ticket Panel Builder',
    channel: target,
    note: 'note',
    deliver: (channel, payload) => tickets.publishPanel(channel, payload, { categoryId: category.id, createdBy: OWNER }),
  });
  assert.match(panel.content, /Ticket Panel Builder/);
  assert.ok(panel.components[0].toJSON().components[0].custom_id.startsWith(`ticketcreate:${id}:`));

  await embedBuilder.handle(interaction('ticketcreate', id, 'modal:body', { values: { title: 'Support', description: 'Click below', color: '#00ff00' } }));
  const send = interaction('ticketcreate', id, 'send', { props: { member: {}, guild: { channels: { fetch: async () => target } } } });
  await embedBuilder.handle(send);

  const [message] = target.sent;
  assert.equal(message.embeds[0].toJSON().title, 'Support');
  assert.equal(message.embeds[0].toJSON().description, 'Click below');
  assert.deepEqual(message.components[0].toJSON().components.map((button) => [button.custom_id, button.label]), [['ticket:open', 'Open Ticket']]);
  assert.match(send.calls.update[0].content, /Ticket Panel Builder: sent/);

  assert.equal(tickets.resolveCategory(guild, category.id), category);
  assert.throws(() => tickets.resolveCategory(guild, 'abc'), /Invalid category ID/);
  assert.throws(() => tickets.resolveCategory(guild, '123456789012345678'), /Category not found/);
  assert.throws(() => tickets.resolveCategory(guild, guild.logChannel.id), /Category not found/);

  const stored = ticketPanels.findById(1);
  assert.equal(stored.category_id, category.id);
  assert.equal(stored.guild_id, guild.id);
});
