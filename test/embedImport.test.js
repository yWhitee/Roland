const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Collection, ComponentType } = require('discord.js');
const database = require('../src/database');
const ticketPanels = require('../src/database/ticketPanels');
const verificationPanels = require('../src/database/verificationPanels');
const createverify = require('../src/commands/createverify');
const embedCommand = require('../src/commands/embed');
const ticketcreate = require('../src/commands/ticketcreate');
const interactionCreate = require('../src/events/interactionCreate');
const embedBuilder = require('../src/services/embedBuilder');
const jsonImport = require('../src/services/embedBuilder/jsonImport');
const sessions = require('../src/services/embedBuilder/sessions');
const { ROLES } = require('../src/permissions');
const { UserError } = require('../src/utils/errors');
const { addCategory, makeGuild, makeInteraction, makeMember, snowflake, tempDatabase } = require('./helpers/discord');

const OWNER = '111111111111111111';
const EXAMPLE = fs.readFileSync(path.join(__dirname, '../docs/embed-example.json'), 'utf8');

const served = new Map();
const fetched = [];

test.before(() => {
  database.open(tempDatabase());
  jsonImport.configure({
    fetch: async (url) => {
      fetched.push(url);
      const body = served.get(url);
      if (body instanceof Error) throw body;
      if (typeof body === 'number') return new Response('not here', { status: body });
      return new Response(body, { status: 200 });
    },
  });
});
test.after(() => {
  jsonImport.configure();
  database.close();
});

const file = (body, { name = 'embed.json', size } = {}) => {
  const url = `https://cdn.discordapp.com/attachments/1/${snowflake()}/${encodeURIComponent(name)}`;
  served.set(url, body);
  const bytes = typeof body === 'string' || Buffer.isBuffer(body) ? Buffer.byteLength(body) : 10;
  return { id: snowflake(), name, url, size: size ?? bytes, contentType: 'application/json' };
};

const uploads = (...files) => new Collection(files.map((entry) => [entry.id, entry]));

const open = async (options = { prefix: 'embed' }, user = OWNER) => {
  const start = { id: snowflake(), user: { id: user }, reply: async (payload) => (start.panel = payload) };
  await embedBuilder.start(start, options);
  return start;
};

const click = (prefix, id, action, extra = {}) => {
  const calls = { update: [], modal: [], reply: [] };
  return {
    calls,
    customId: `${prefix}:${id}:${action}`,
    user: { id: OWNER },
    fields: { getTextInputValue: (key) => extra.values?.[key] ?? '', getStringSelectValues: () => [] },
    values: [],
    update: async (payload) => calls.update.push(payload),
    showModal: async (modal) => calls.modal.push(modal),
    reply: async (payload) => calls.reply.push(payload),
    ...extra.props,
  };
};

const submit = (prefix, id, files, extra = {}) => {
  const calls = { deferred: 0, edits: [], followUps: [] };
  return {
    calls,
    customId: `${prefix}:${id}:importfile`,
    user: { id: OWNER },
    fields: { getUploadedFiles: () => files },
    deferUpdate: async () => calls.deferred++,
    editReply: async (payload) => calls.edits.push(payload),
    followUp: async (payload) => calls.followUps.push(payload),
    ...extra,
  };
};

const importInto = async (prefix, id, body, options) => {
  const interaction = submit(prefix, id, uploads(file(body, options)));
  await embedBuilder.handle(interaction);
  return interaction.calls;
};

const failure = (calls) => calls.followUps[0]?.embeds[0].toJSON().description;

const stateOf = (id) => sessions.get(id, OWNER).state;

const textChannel = (extra = {}) => ({
  id: snowflake(),
  isTextBased: () => true,
  toString() {
    return `<#${this.id}>`;
  },
  permissionsFor: () => ({ has: () => true }),
  sent: [],
  async send(payload) {
    this.sent.push(payload);
    return { id: snowflake() };
  },
  ...extra,
});

test('the Import JSON button opens a modal with one required file upload', async () => {
  const { id, panel } = await open();
  const labels = panel.components.flatMap((row) => row.toJSON().components.map((component) => component.label));
  assert.ok(labels.includes('Import JSON'));
  const press = click('embed', id, 'import');
  await embedBuilder.handle(press);
  const modal = press.calls.modal[0].toJSON();
  assert.equal(modal.custom_id, `embed:${id}:importfile`);
  const [label] = modal.components;
  assert.match(label.description, /\.json file up to 64 KB/);
  assert.deepEqual([label.component.type, label.component.custom_id, label.component.min_values, label.component.max_values, label.component.required], [ComponentType.FileUpload, 'file', 1, 1, true]);
});

test('a complete file fills the editor and its preview, can be edited and is sent only on Send', async () => {
  const { id } = await open();
  const calls = await importInto('embed', id, EXAMPLE, { name: 'embed-example.json' });
  assert.equal(calls.deferred, 1);
  assert.equal(calls.followUps.length, 0);
  const [panel] = calls.edits;
  assert.match(panel.content, /✅ Imported `embed-example.json`\. Review and edit it below, then press \*\*Send\*\*\. Nothing has been sent yet\./);
  assert.match(panel.content, /Mensagem fora do embed/);
  assert.deepEqual(panel.allowedMentions, { parse: [] });

  const embed = panel.embeds[0].toJSON();
  assert.equal(embed.title, 'Título');
  assert.equal(embed.url, 'https://example.com');
  assert.equal(embed.description, 'Descrição com **markdown** do Discord.');
  assert.equal(embed.color, 0xff7b00);
  assert.deepEqual(embed.author, { name: 'Autor', url: 'https://example.com', icon_url: 'https://example.com/author.png' });
  assert.equal(embed.thumbnail.url, 'https://example.com/thumbnail.png');
  assert.equal(embed.image.url, 'https://example.com/image.png');
  assert.deepEqual(embed.footer, { text: 'Footer', icon_url: 'https://example.com/footer.png' });
  assert.deepEqual(embed.fields, [
    { name: 'Campo 1', value: 'Valor 1', inline: true },
    { name: 'Campo 2', value: 'Valor 2', inline: true },
    { name: 'Campo 3', value: 'Valor 3', inline: false },
  ]);
  assert.ok(embed.timestamp);

  const preview = click('embed', id, 'preview');
  await embedBuilder.handle(preview);
  assert.equal(preview.calls.reply[0].embeds[0].toJSON().title, 'Título');
  assert.equal(preview.calls.reply[0].content, 'Mensagem fora do embed (opcional)');

  const edit = click('embed', id, 'section:body');
  await embedBuilder.handle(edit);
  const inputs = edit.calls.modal[0].toJSON().components.map((entry) => [entry.component.custom_id, entry.component.value]);
  assert.deepEqual(inputs.slice(0, 2), [['title', 'Título'], ['url', 'https://example.com']], 'the normal modals open with the imported values');
  await embedBuilder.handle(click('embed', id, 'modal:body', { values: { title: 'Editado', url: '', description: 'Nova descrição', color: '#ff0000' } }));
  await embedBuilder.handle(click('embed', id, 'pickremove', { props: { values: ['2'] } }));

  const channel = textChannel();
  const send = click('embed', id, 'channel', { props: { values: [channel.id], member: {}, guild: { channels: { fetch: async () => channel } } } });
  await embedBuilder.handle(send);
  assert.equal(channel.sent.length, 1);
  const [message] = channel.sent;
  assert.equal(message.content, 'Mensagem fora do embed (opcional)');
  const sent = message.embeds[0].toJSON();
  assert.deepEqual([sent.title, sent.description, sent.color, sent.fields.length, sent.image.url], ['Editado', 'Nova descrição', 0xff0000, 2, 'https://example.com/image.png']);
  assert.equal(message.components, undefined, 'the plain embed builder never adds components');
});

test('a minimal file uses the editor defaults and colors, nulls and spaces are normalized', async () => {
  const { id } = await open();
  await embedBuilder.handle(click('embed', id, 'modal:body', { values: { title: 'Old', description: 'Old text', color: '#123456' } }));
  await embedBuilder.handle(click('embed', id, 'timestamp'));
  await importInto('embed', id, '{ "embed": { "title": "Olá" } }');
  assert.deepEqual(stateOf(id), { ...sessions.emptyState(), title: 'Olá' }, 'the import replaces everything, like Clear plus the file');

  await importInto('embed', id, JSON.stringify({ content: null, embed: { title: '  Spaced  ', color: 16711680, description: null, author: null, fields: [{ name: ' a ', value: ' b ' }] } }));
  assert.deepEqual(stateOf(id), { ...sessions.emptyState(), title: 'Spaced', color: '#ff0000', fields: [{ name: 'a', value: 'b', inline: false }] });
  await importInto('embed', id, '﻿{ "embed": { "description": "BOM", "color": "00ff00" } }');
  assert.deepEqual([stateOf(id).description, stateOf(id).color], ['BOM', '#00ff00']);
});

test('broken uploads are rejected with a clear reason and leave the editor untouched', async () => {
  const { id } = await open();
  await embedBuilder.handle(click('embed', id, 'modal:body', { values: { title: 'Keep' } }));
  const before = fetched.length;
  const big = 'x'.repeat(jsonImport.MAX_BYTES + 1);
  const cases = [
    [null, /No file was uploaded/],
    [uploads(), /No file was uploaded/],
    [uploads(file('{}'), file('{}')), /Upload only one \.json file/],
    [uploads(file('{"embed":{"title":"x"}}', { name: 'embed.txt' })), /"embed\.txt" is not a \.json file/],
    [uploads(file('{"embed":{"title":"x"}}', { name: '../../etc/passwd' })), /is not a \.json file/],
    [uploads(file('', { size: 0 })), /"embed\.json" is empty/],
    [uploads(file('{}', { size: jsonImport.MAX_BYTES + 1 })), /larger than 64 KB/],
    [uploads(file(big, { size: 10 })), /larger than 64 KB/],
    [uploads(file('   \n  ')), /is empty/],
    [uploads(file('{ "embed": { "title": "x", } }')), /The file is not valid JSON/],
    [uploads(file('function () { return 1 }')), /The file is not valid JSON/],
    [uploads(file(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))), /not UTF-8 text/],
    [uploads(file('[1, 2, 3]')), /must contain a JSON object/],
    [uploads(file('"just text"')), /must contain a JSON object/],
    [uploads(file(404)), /Discord did not return the file \(HTTP 404\)/],
    [uploads({ ...file('{}'), url: 'http://127.0.0.1:11434/api/tags' }), /must be uploaded to Discord/],
    [uploads({ ...file('{}'), url: 'https://cdn.discordapp.com.evil.example/a.json' }), /must be uploaded to Discord/],
    [uploads({ ...file('{}'), url: 'file:///etc/passwd' }), /must be uploaded to Discord/],
  ];
  for (const [files, reason] of cases) {
    const interaction = submit('embed', id, files);
    await embedBuilder.handle(interaction);
    assert.match(failure(interaction.calls), reason);
    assert.equal(interaction.calls.edits.length, 0);
    assert.equal(stateOf(id).title, 'Keep');
  }
  assert.ok(fetched.slice(before).every((url) => url.startsWith('https://cdn.discordapp.com/attachments/')), 'nothing else is ever downloaded');

  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const interaction = submit('embed', id, uploads(file(new TypeError('getaddrinfo ENOTFOUND'))));
    await embedBuilder.handle(interaction);
    assert.match(failure(interaction.calls), /could not be downloaded from Discord/);
    assert.match(logged.join('\n'), /ENOTFOUND/);

    const stalled = file('{}');
    served.set(stalled.url, new ReadableStream({ pull: (controller) => controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) }));
    const slow = submit('embed', id, uploads(stalled));
    await embedBuilder.handle(slow);
    assert.match(failure(slow.calls), /Downloading the file took too long/);
    assert.equal(stateOf(id).title, 'Keep');
  } finally {
    console.error = original;
  }
});

test('structure, types and Discord limits are validated with the exact property', () => {
  const rejects = (data, reason) => assert.throws(() => jsonImport.toState(data), (error) => error instanceof UserError && reason.test(error.message));
  rejects({ embed: 'text' }, /embed must be an object/);
  rejects({ embed: { title: 5 } }, /embed\.title must be text/);
  rejects({ embed: { title: 'a', fields: {} } }, /embed\.fields must be a list/);
  rejects({ embed: { fields: [{ name: 'a' }] } }, /Field 1 needs both a name and a value/);
  rejects({ embed: { fields: ['a'] } }, /embed\.fields\[0\] must be an object/);
  rejects({ embed: { title: 'a', fields: [{ name: 'a', value: 'b', inline: 'yes' }] } }, /embed\.fields\[0\]\.inline must be true or false/);
  rejects({ embed: { title: 'a', color: 'blue' } }, /embed\.color must be a hex color/);
  rejects({ embed: { title: 'a', color: 0x1000000 } }, /embed\.color must be a hex color/);
  rejects({ embed: { title: 'a', timestamp: 'now' } }, /embed\.timestamp must be true or false/);
  rejects({ embed: { title: 'a'.repeat(257) } }, /The title must be at most 256 characters \(it has 257\)/);
  rejects({ embed: { description: 'a'.repeat(4001) } }, /The description must be at most 4000 characters/);
  rejects({ embed: { footer: { text: 'a'.repeat(2049) } } }, /The footer text must be at most 2048 characters/);
  rejects({ embed: { author: { name: 'a'.repeat(257) } } }, /The author name must be at most 256 characters/);
  rejects({ content: 'a'.repeat(2001), embed: { title: 'a' } }, /The message content must be at most 2000 characters/);
  rejects({ embed: { fields: [{ name: 'a'.repeat(257), value: 'b' }] } }, /The name of field 1 must be at most 256 characters/);
  rejects({ embed: { fields: [{ name: 'a', value: 'b'.repeat(1025) }] } }, /The value of field 1 must be at most 1024 characters/);
  rejects({ embed: { fields: Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' })) } }, /has 26 fields; an embed can have at most 25/);
  rejects({ embed: { author: { iconURL: 'https://example.com/a.png' } } }, /Set an author name before adding an author icon/);
  rejects({ embed: { title: 'a', url: 'javascript:alert(1)' } }, /The title URL must be a valid URL starting with http/);
  rejects({ embed: { title: 'a', image: 'ftp://example.com/a.png' } }, /The main image must be a valid URL/);
  rejects({ embed: { title: 'a', thumbnail: `https://example.com/${'a'.repeat(2000)}` } }, /The thumbnail must be a valid URL .*at most 2000 characters/);
  rejects({ embed: { description: 'a'.repeat(4000), fields: [{ name: 'n', value: 'v'.repeat(1024) }, { name: 'n', value: 'v'.repeat(1024) }] } }, /exceeds the Discord limit of 6000 characters/);
  rejects({ content: 'only content' }, /The embed is empty/);
  rejects({}, /The embed is empty/);

  const many = { embed: Object.fromEntries(['title', 'description', 'url', 'thumbnail', 'image'].map((key) => [key, 1])), a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
  assert.throws(() => jsonImport.toState(many), (error) => error.message.split('\n').length === 12 && /…and 1 more\./.test(error.message));
  assert.throws(() => sessions.update(sessions.create('limits', OWNER, { prefix: 'embed' }), { title: 'a'.repeat(257) }), /at most 256/, 'the manual editor shares the same limits');
});

test('buttons, components, embed lists, raw API names and unknown properties are refused', () => {
  const rejects = (data, reason) => assert.throws(() => jsonImport.toState(data), reason);
  rejects({ embed: { title: 'a' }, buttons: [{ label: 'Verify', style: 'primary', customId: 'verify:start' }] }, /Buttons cannot be imported: the embed editor does not create buttons/);
  rejects({ embed: { title: 'a' }, components: [{ type: 1, components: [] }] }, /Components cannot be imported/);
  rejects({ embeds: [{ title: 'a' }, { title: 'b' }] }, /Only one embed is supported/);
  rejects({ embed: { title: 'a' }, permissions: 'Administrator' }, /Unknown property "permissions"\. Supported: content, embed\./);
  rejects({ embed: { title: 'a', footer: { text: 'f', icon_url: 'https://example.com/a.png' } } }, /Unknown property "embed\.footer\.icon_url"\. Supported: text, iconURL\./);
  rejects({ embed: { title: 'a', thumbnail: { url: 'https://example.com/a.png' } } }, /embed\.thumbnail must be text/);
  rejects({ embed: { title: 'a', fields: [{ name: 'a', value: 'b', customId: 'ticket:open' }] } }, /Unknown property "embed\.fields\[0\]\.customId"/);
  rejects({ embed: { title: 'a', ownerId: '1', token: 'x' } }, /Unknown property "embed\.ownerId".*\n.*Unknown property "embed\.token"/);
});

test('file contents are only data: code stays text, prototypes stay clean and nothing is executed', async () => {
  const payloads = [
    '${process.exit(1)}',
    "require('child_process').execSync('rm -rf /')",
    "eval('globalThis.pwned = true')",
    'new Function("globalThis.pwned = true")()',
    '<script>alert(1)</script>',
    '{{constructor.constructor("globalThis.pwned = true")()}}',
    "'; DROP TABLE punishments; --",
    '@everyone <@&123456789012345678>',
  ];
  const state = jsonImport.toState({ content: payloads[7], embed: { title: 'Code', description: payloads.join('\n'), fields: payloads.slice(0, 7).map((value, index) => ({ name: `p${index}`, value })) } });
  assert.equal(state.description, payloads.join('\n'));
  assert.deepEqual(state.fields.map((field) => field.value), payloads.slice(0, 7));
  assert.equal(globalThis.pwned, undefined);
  assert.equal(database.get().prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE name = 'punishments'").get().total, 1);

  assert.throws(() => jsonImport.parse('{"embed":{"title":"a"},"__proto__":{"polluted":true}}'), /Unknown property "__proto__"/);
  assert.throws(() => jsonImport.parse('{"embed":{"title":"a","constructor":{"prototype":{"polluted":true}}}}'), /Unknown property "embed\.constructor"/);
  assert.throws(() => jsonImport.parse('{"embed":{"title":"a","fields":[{"name":"a","value":"b","__proto__":{"polluted":true}}]}}'), /Unknown property "embed\.fields\[0\]\.__proto__"/);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);

  const { id } = await open();
  const before = fetched.length;
  const calls = await importInto('embed', id, JSON.stringify({ content: payloads[7], embed: { title: 'Links', image: 'http://169.254.169.254/latest/meta-data/', thumbnail: 'http://127.0.0.1:11434/api/tags' } }));
  assert.equal(fetched.length - before, 1, 'URLs inside the file are never requested');
  assert.deepEqual(calls.edits[0].allowedMentions, { parse: [] }, 'the editor never pings while reviewing');
  assert.equal(stateOf(id).content, payloads[7]);

  const nested = `{"embed":{"title":"a","fields":${'['.repeat(20000)}${']'.repeat(20000)}}}`;
  assert.throws(() => jsonImport.parse(nested), /embed\.fields\[0\] must be an object/);
});

test('random malformed files only ever produce a clear error', async () => {
  let seed = 42;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const { id } = await open();
  for (let round = 0; round < 300; round++) {
    const characters = [...EXAMPLE];
    for (let edits = 1 + Math.floor(random() * 5); edits > 0; edits--) {
      const at = Math.floor(random() * characters.length);
      const action = random();
      if (action < 0.4) characters.splice(at, 1);
      else if (action < 0.7) characters.splice(at, 0, '{}[]",:\\0x9e'[Math.floor(random() * 12)]);
      else characters[at] = String.fromCharCode(Math.floor(random() * 0xffff));
    }
    const text = characters.join('');
    try {
      jsonImport.parse(text);
    } catch (error) {
      assert.ok(error instanceof UserError, `unexpected ${error.name}: ${error.message}`);
    }
    if (round % 30 === 0) {
      const calls = await importInto('embed', id, text);
      assert.equal(calls.edits.length + calls.followUps.length, 1);
    }
  }
});

test('/createverify custom imports into the same editor and always keeps the real verify button', async () => {
  const guild = makeGuild();
  const channel = await guild.channels.create({ name: 'verify' });
  const owner = makeMember(ROLES.CREATOR);
  const opened = [];
  const interaction = { ...makeInteraction({ guild, member: owner }), options: { getChannel: () => ({ id: channel.id }), getString: () => 'custom' }, reply: async (payload) => opened.push(payload) };
  await createverify.execute(interaction);
  assert.ok(opened[0].components.flatMap((row) => row.toJSON().components).some((button) => button.custom_id === `createverify:${interaction.id}:import`));

  const forged = submit('createverify', interaction.id, uploads(file(JSON.stringify({ embed: { title: 'Fake' }, buttons: [{ label: 'Free admin', style: 'primary', customId: 'ticket:open' }] }))), { user: owner.user });
  await createverify.handleComponent(forged);
  assert.match(failure(forged.calls), /Buttons cannot be imported/);

  const imported = submit('createverify', interaction.id, uploads(file(JSON.stringify({ content: 'Verify below', embed: { title: 'Welcome', color: '#00ff00' } }))), { user: owner.user });
  await createverify.handleComponent(imported);
  assert.equal(imported.calls.edits[0].embeds[0].toJSON().title, 'Welcome');
  assert.match(imported.calls.edits[0].content, /Verify with Roblox\*\* button is added automatically/);
  assert.equal(channel.sent.length, 0, 'importing never sends');

  const sent = [];
  await createverify.handleComponent({ ...click('createverify', interaction.id, 'send'), user: owner.user, member: owner, guild, update: async (payload) => sent.push(payload) });
  const [message] = channel.sent;
  assert.equal(message.content, 'Verify below');
  assert.equal(message.embeds[0].toJSON().title, 'Welcome');
  assert.deepEqual(message.components.flatMap((row) => row.toJSON().components).map((button) => [button.custom_id, button.label]), [['verify:start', 'Verify with Roblox']]);
  assert.equal(verificationPanels.findByMessage(message.id).type, 'custom');
});

test('/ticketcreate imports into the same editor and always keeps the real Open Ticket button', async () => {
  const guild = makeGuild();
  const category = addCategory(guild);
  const channel = await guild.channels.create({ name: 'tickets' });
  const admin = makeMember(ROLES.ADMINISTRATOR);
  const opened = [];
  const interaction = { ...makeInteraction({ guild, member: admin }), options: { getChannel: () => channel, getString: () => category.id }, reply: async (payload) => opened.push(payload) };
  await ticketcreate.execute(interaction);

  const imported = submit('ticketcreate', interaction.id, uploads(file(JSON.stringify({ embed: { title: 'Support', description: 'Open a ticket', fields: [{ name: 'Hours', value: '24/7' }] } }))), { user: admin.user });
  await ticketcreate.handleComponent(imported);
  assert.equal(imported.calls.edits[0].embeds[0].toJSON().title, 'Support');

  await ticketcreate.handleComponent({ ...click('ticketcreate', interaction.id, 'send'), user: admin.user, member: admin, guild, update: async () => {} });
  const [message] = channel.sent;
  assert.deepEqual(message.embeds[0].toJSON().fields, [{ name: 'Hours', value: '24/7', inline: false }]);
  assert.deepEqual(message.components.flatMap((row) => row.toJSON().components).map((button) => [button.custom_id, button.label]), [['ticket:open', 'Open Ticket']]);
  const panel = ticketPanels.findByMessage?.(message.id) ?? database.get().prepare('SELECT * FROM ticket_panels WHERE message_id = ?').get(message.id);
  assert.equal(panel.category_id, category.id);
});

test('only the builder owner with the command permission can import, and a session closed mid-import stays closed', async () => {
  const { id } = await open();
  const stranger = submit('embed', id, uploads(file('{"embed":{"title":"Mine now"}}')), { user: { id: '222222222222222222' } });
  await assert.rejects(embedBuilder.handle(stranger), /Only the person who started this builder can use it/);
  assert.equal(stranger.calls.deferred, 0);
  assert.equal(stateOf(id).title, '');

  const guild = makeGuild();
  const member = makeMember(ROLES.SUPPORT);
  const replies = [];
  await interactionCreate.execute({
    ...submit('embed', id, uploads(file('{"embed":{"title":"x"}}')), { user: member.user }),
    guild,
    member,
    client: { commands: new Collection([['embed', embedCommand]]), components: new Collection() },
    isChatInputCommand: () => false,
    isMessageComponent: () => false,
    isModalSubmit: () => true,
    inCachedGuild: () => true,
    reply: async (payload) => replies.push(payload),
  });
  assert.match(replies[0].embeds[0].toJSON().description, /You do not have permission to use this command/);
  assert.equal(stateOf(id).title, '');

  for (const action of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    await assert.rejects(embedBuilder.handle(click('embed', id, action)), /Unknown action/);
  }

  const closing = file('{"embed":{"title":"Too late"}}');
  const pending = served.get(closing.url);
  served.set(closing.url, new ReadableStream({
    async pull(controller) {
      await embedBuilder.handle(click('embed', id, 'cancel'));
      controller.enqueue(new TextEncoder().encode(pending));
      controller.close();
    },
  }));
  const late = submit('embed', id, uploads(closing));
  await embedBuilder.handle(late);
  assert.match(failure(late.calls), /This builder session has expired/);
  assert.equal(late.calls.edits.length, 0);
  assert.throws(() => sessions.get(id, OWNER), /expired/);
});
