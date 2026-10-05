const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Collection, ComponentType, MessageFlags, TextInputStyle } = require('discord.js');
const database = require('../src/database');
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
const fetched = [];

test.before(() => {
  database.open(tempDatabase());
  jsonImport.configure({
    fetch: async (url) => {
      fetched.push(url);
      throw new Error('Paste JSON must never download anything');
    },
  });
});
test.after(() => {
  jsonImport.configure();
  database.close();
});

const open = async (options = { prefix: 'embed' }) => {
  const start = { id: snowflake(), user: { id: OWNER }, reply: async (payload) => (start.panel = payload) };
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

const pasted = (prefix, id, json, props = {}) => click(prefix, id, 'pastejson', { values: { json }, props });

const paste = async (id, json, prefix = 'embed') => {
  const interaction = pasted(prefix, id, json);
  await embedBuilder.handle(interaction);
  return interaction.calls;
};

const failure = (calls) => calls.reply[0]?.embeds[0].toJSON().description;

const stateOf = (id) => sessions.get(id, OWNER).state;

const buttonsOf = (message) => message.components.flatMap((row) => row.toJSON().components).map((button) => [button.custom_id, button.label]);

const textChannel = () => ({
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
});

test('Paste JSON sits next to Import JSON and opens a 4000-character JSON box', async () => {
  const { id, panel } = await open();
  const rows = panel.components.map((row) => row.toJSON().components.map((component) => component.label));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[3], ['Import JSON', 'Paste JSON']);
  assert.deepEqual(rows[2], ['Preview', 'Clear', 'Send', 'Cancel']);

  const press = click('embed', id, 'paste');
  await embedBuilder.handle(press);
  const modal = press.calls.modal[0].toJSON();
  assert.deepEqual([modal.custom_id, modal.title], [`embed:${id}:pastejson`, 'Paste Embed JSON']);
  const [label] = modal.components;
  assert.equal(label.label, 'JSON');
  assert.match(label.description, /Paste the raw JSON object, up to 4000 characters\. For larger JSON, use Import JSON\./);
  const input = label.component;
  assert.deepEqual(
    [input.type, input.custom_id, input.style, input.max_length, input.required],
    [ComponentType.TextInput, 'json', TextInputStyle.Paragraph, jsonImport.MAX_PASTE, true],
  );
  assert.equal(jsonImport.MAX_PASTE, 4000, 'the Discord limit for a modal text input');
  assert.equal(jsonImport.MAX_BYTES, 64 * 1024, 'the file limit is unchanged');

  const upload = click('embed', id, 'import');
  await embedBuilder.handle(upload);
  assert.equal(upload.calls.modal[0].toJSON().components[0].component.type, ComponentType.FileUpload, 'Import JSON still opens the file upload');
});

test('a complete paste fills the editor and its preview, can be edited and is sent only on Send', async () => {
  const { id } = await open();
  const calls = await paste(id, EXAMPLE);
  assert.equal(calls.reply.length, 0);
  const [panel] = calls.update;
  assert.match(panel.content, /✅ Imported the pasted JSON\. Review and edit it below, then press \*\*Send\*\*\. Nothing has been sent yet\./);
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
  assert.equal(fetched.length, 0, 'image, thumbnail and icon URLs are never requested');

  const preview = click('embed', id, 'preview');
  await embedBuilder.handle(preview);
  assert.equal(preview.calls.reply[0].embeds[0].toJSON().title, 'Título');
  assert.equal(preview.calls.reply[0].content, 'Mensagem fora do embed (opcional)');

  await embedBuilder.handle(click('embed', id, 'modal:body', { values: { title: 'Editado', description: 'Nova descrição', color: '#ff0000' } }));
  await embedBuilder.handle(click('embed', id, 'field:new', { values: { name: 'Novo', value: 'Campo' }, props: { fields: { getTextInputValue: (key) => ({ name: 'Novo', value: 'Campo' })[key], getStringSelectValues: () => ['yes'] } } }));

  const channel = textChannel();
  await embedBuilder.handle(click('embed', id, 'channel', { props: { values: [channel.id], member: {}, guild: { channels: { fetch: async () => channel } } } }));
  const [message] = channel.sent;
  assert.equal(message.content, 'Mensagem fora do embed (opcional)');
  const sent = message.embeds[0].toJSON();
  assert.deepEqual([sent.title, sent.description, sent.color, sent.fields.length, sent.fields[3]], ['Editado', 'Nova descrição', 0xff0000, 4, { name: 'Novo', value: 'Campo', inline: true }]);
  assert.equal(message.components, undefined);
});

test('a minimal paste uses the editor defaults and colors, content and fields are read like Import JSON', async () => {
  const { id } = await open();
  await embedBuilder.handle(click('embed', id, 'modal:body', { values: { title: 'Old', description: 'Old text', color: '#123456' } }));
  await paste(id, '{"embed":{"title":"Olá"}}');
  assert.deepEqual(stateOf(id), { ...sessions.emptyState(), title: 'Olá' });

  await paste(id, JSON.stringify({ content: ' Hi ', embed: { description: 'Numbers', color: 65280, fields: [{ name: 'a', value: 'b', inline: true }, { name: 'c', value: 'd' }] } }));
  assert.deepEqual(stateOf(id), { ...sessions.emptyState(), content: 'Hi', description: 'Numbers', color: '#00ff00', fields: [{ name: 'a', value: 'b', inline: true }, { name: 'c', value: 'd', inline: false }] });
  await paste(id, '\n  { "embed": { "title": "Spaced", "color": "ABCDEF" } }  \n');
  assert.deepEqual([stateOf(id).title, stateOf(id).color], ['Spaced', '#ABCDEF']);

  for (const json of [EXAMPLE, '{"embed":{"title":"a","fields":[{"name":"x","value":"y","inline":true}]},"content":"c"}']) {
    assert.deepEqual(jsonImport.paste(json).state, jsonImport.parse(json), 'Paste JSON and Import JSON produce the same editor state');
  }
});

test('invalid pastes are refused privately and leave the editor untouched', async () => {
  const { id } = await open();
  await embedBuilder.handle(click('embed', id, 'modal:body', { values: { title: 'Keep', description: 'Mine' } }));
  const before = { ...stateOf(id) };
  const cut = EXAMPLE.slice(0, EXAMPLE.length / 2);
  const cases = [
    ['', /Nothing was pasted/],
    ['   \n\t  ', /Nothing was pasted/],
    ['{ "embed": { "title": "x", } }', /The pasted JSON is not valid JSON/],
    [cut, /The pasted JSON is not valid JSON/],
    ["{ embed: { title: 'x' } }", /The pasted JSON is not valid JSON/],
    ['[{"embed":{"title":"x"}}]', /The pasted JSON must contain a JSON object/],
    ['"just text"', /The pasted JSON must contain a JSON object/],
    ['42', /The pasted JSON must contain a JSON object/],
    ['null', /The pasted JSON must contain a JSON object/],
    ['true', /The pasted JSON must contain a JSON object/],
    ['{"embed":"text"}', /embed must be an object/],
    ['{"embed":{"title":5,"timestamp":"now","fields":{}}}', /embed\.title must be text.*\n.*embed\.timestamp must be true or false.*\n.*embed\.fields must be a list/],
    ['{"embed":{"title":"a","fields":[{"name":"a","value":"b","inline":"yes"}]}}', /embed\.fields\[0\]\.inline must be true or false/],
    ['{"embed":{"fields":[{"name":"a"}]}}', /Field 1 needs both a name and a value/],
    ['{"embed":{"title":"a"},"buttons":[{"label":"Verify","style":"primary","customId":"verify:start"}]}', /Buttons cannot be imported/],
    ['{"embed":{"title":"a"},"components":[{"type":1,"components":[{"type":2,"custom_id":"ticket:open"}]}]}', /Components cannot be imported/],
    ['{"embeds":[{"title":"a"}]}', /Only one embed is supported/],
    ['{"embed":{"title":"a","footer":{"text":"f","icon_url":"https://example.com/a.png"}}}', /Unknown property "embed\.footer\.icon_url"/],
    ['{"embed":{"title":"a"},"permissions":"Administrator"}', /Unknown property "permissions"/],
    [JSON.stringify({ content: 'a'.repeat(2001), embed: { title: 'a' } }), /The message content must be at most 2000 characters/],
    [JSON.stringify({ embed: { title: 'a'.repeat(257) } }), /The title must be at most 256 characters/],
    [JSON.stringify({ embed: { footer: { text: 'a'.repeat(2049) } } }), /The footer text must be at most 2048 characters/],
    [JSON.stringify({ embed: { fields: [{ name: 'a'.repeat(257), value: 'b' }] } }), /The name of field 1 must be at most 256 characters/],
    [JSON.stringify({ embed: { fields: [{ name: 'a', value: 'b'.repeat(1025) }] } }), /The value of field 1 must be at most 1024 characters/],
    [JSON.stringify({ embed: { fields: Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' })) } }), /has 26 fields; an embed can have at most 25/],
    ['{"embed":{"title":"a","url":"javascript:alert(1)"}}', /The title URL must be a valid URL/],
    ['{"embed":{"title":"a","image":"file:///etc/passwd"}}', /The main image must be a valid URL/],
    ['{"embed":{"author":{"iconURL":"https://example.com/a.png"}}}', /Set an author name before adding an author icon/],
    ['{"embed":{"title":"a","color":"blue"}}', /embed\.color must be a hex color/],
    ['{"embed":{"title":"a","color":-1}}', /embed\.color must be a hex color/],
    ['{"content":"only content"}', /The embed is empty/],
    ['{}', /The embed is empty/],
  ];
  for (const [json, reason] of cases) {
    const calls = await paste(id, json);
    assert.match(failure(calls) ?? '', reason, json.slice(0, 80));
    assert.equal(calls.reply[0].flags, MessageFlags.Ephemeral, 'errors are only shown to the user');
    assert.equal(calls.update.length, 0, 'the editor message is not replaced');
    assert.deepEqual(stateOf(id), before, 'the editor keeps its contents');
  }

  const many = JSON.stringify({ embed: Object.fromEntries(['title', 'description', 'url', 'thumbnail', 'image'].map((key) => [key, 1])), a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
  const listed = failure(await paste(id, many)).split('\n');
  assert.equal(listed.length, 12, 'the same ten-problem limit as Import JSON, plus the heading and the remainder');
  assert.match(listed.at(-1), /…and 1 more\./);
  assert.throws(() => jsonImport.parse(many), (error) => error.message.split('\n').length === 12);

  const fixed = await paste(id, '{"embed":{"title":"Fixed"}}');
  assert.equal(fixed.update.length, 1, 'the user can try again right away');
  assert.equal(stateOf(id).title, 'Fixed');
});

test('JSON that does not fit in a Discord modal is refused, never cut, and points to Import JSON', async () => {
  const { id } = await open();
  await embedBuilder.handle(click('embed', id, 'modal:body', { values: { title: 'Keep' } }));
  const large = JSON.stringify({ embed: { description: 'a'.repeat(3900), fields: [{ name: 'n', value: 'v'.repeat(1024) }] } });
  assert.ok(large.length > jsonImport.MAX_PASTE);
  let calls = await paste(id, large);
  assert.match(failure(calls), new RegExp(`The pasted JSON is too large \\(${large.length} characters\\)\\. Discord modals accept at most 4000 characters\\. For larger JSON, use Import JSON`));
  assert.equal(stateOf(id).title, 'Keep');

  const clipped = large.slice(0, jsonImport.MAX_PASTE);
  calls = await paste(id, clipped);
  assert.match(failure(calls), /reached the 4000-character limit and was probably cut off by Discord\. .*use Import JSON/);
  assert.equal(stateOf(id).title, 'Keep');

  const exact = JSON.stringify({ embed: { title: 'Exact', description: 'x' } });
  const fitting = `${exact.slice(0, -1)}${' '.repeat(jsonImport.MAX_PASTE - exact.length)}}`;
  assert.equal(fitting.length, jsonImport.MAX_PASTE);
  calls = await paste(id, fitting);
  assert.equal(calls.update.length, 1, 'valid JSON of exactly 4000 characters is accepted');
  assert.equal(stateOf(id).title, 'Exact');

  const asFile = jsonImport.parse(large);
  assert.deepEqual([asFile.description.length, asFile.fields[0].value.length], [3900, 1024], 'the same JSON imports fine as a file, which keeps its 64 KB limit');
});

test('pasted JSON is only data: no prototype changes, code, SQL, files, processes or URL requests', async () => {
  const { id } = await open();
  const blocked = [];
  const originals = {
    readFileSync: fs.readFileSync,
    openSync: fs.openSync,
    readFile: fs.promises.readFile,
    exec: childProcess.exec,
    execSync: childProcess.execSync,
    spawn: childProcess.spawn,
  };
  fs.readFileSync = fs.openSync = (...args) => blocked.push(['fs', args[0]]);
  fs.promises.readFile = async (...args) => blocked.push(['fs', args[0]]);
  childProcess.exec = childProcess.execSync = childProcess.spawn = (...args) => blocked.push(['process', args[0]]);
  try {
    const payloads = [
      '${process.exit(1)}',
      "require('child_process').execSync('rm -rf /')",
      "eval('globalThis.pwned = true')",
      'new Function("globalThis.pwned = true")()',
      '<script>alert(1)</script>',
      "'; DROP TABLE punishments; --",
      '../../../../etc/passwd',
    ];
    await paste(id, JSON.stringify({ content: '@everyone', embed: { title: 'Code', description: payloads.join('\n'), image: 'http://169.254.169.254/latest/meta-data/', thumbnail: 'http://127.0.0.1:11434/api/tags', fields: payloads.map((value, index) => ({ name: `p${index}`, value })) } }));
    assert.equal(stateOf(id).description, payloads.join('\n'));
    assert.deepEqual(stateOf(id).fields.map((field) => field.value), payloads);
    assert.equal(stateOf(id).image, 'http://169.254.169.254/latest/meta-data/');

    for (const json of [
      '{"embed":{"title":"a"},"__proto__":{"polluted":true}}',
      '{"embed":{"title":"a","__proto__":{"polluted":true}}}',
      '{"embed":{"title":"a","constructor":{"prototype":{"polluted":true}}}}',
      '{"embed":{"title":"a","author":{"name":"x","__proto__":{"polluted":true}}}}',
      '{"embed":{"title":"a","fields":[{"name":"a","value":"b","constructor":{"prototype":{"polluted":true}}}]}}',
      '{"constructor":{"prototype":{"polluted":true}},"embed":{"title":"a"}}',
    ]) {
      const calls = await paste(id, json);
      assert.match(failure(calls), /Unknown property "(?:[a-z.\[\]0-9]+\.)?(?:__proto__|constructor)"/, json);
    }
    const nested = `{"embed":{"title":"a","fields":${'['.repeat(1900)}${']'.repeat(1900)}}}`;
    assert.match(failure(await paste(id, nested)), /embed\.fields\[0\] must be an object/);
    const nestedObjects = `{"embed":{"title":"a","author":${'{"name":'.repeat(400)}"x"${'}'.repeat(400)}}}`;
    assert.match(failure(await paste(id, nestedObjects)), /embed\.author\.name must be text/);
  } finally {
    Object.assign(fs, { readFileSync: originals.readFileSync, openSync: originals.openSync });
    fs.promises.readFile = originals.readFile;
    Object.assign(childProcess, { exec: originals.exec, execSync: originals.execSync, spawn: originals.spawn });
  }
  assert.deepEqual(blocked, []);
  assert.equal(fetched.length, 0);
  assert.equal(globalThis.pwned, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(database.get().prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE name = 'punishments'").get().total, 1);
});

test('random malformed pastes only ever produce a clear private error', async () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const compact = JSON.stringify(JSON.parse(EXAMPLE));
  const { id } = await open();
  for (let round = 0; round < 300; round++) {
    const characters = [...compact];
    for (let edits = 1 + Math.floor(random() * 5); edits > 0; edits--) {
      const at = Math.floor(random() * characters.length);
      const action = random();
      if (action < 0.4) characters.splice(at, 1);
      else if (action < 0.7) characters.splice(at, 0, '{}[]",:\\0x9e'[Math.floor(random() * 12)]);
      else characters[at] = String.fromCharCode(Math.floor(random() * 0xffff));
    }
    const text = characters.join('');
    try {
      jsonImport.paste(text);
    } catch (error) {
      assert.ok(error instanceof UserError, `unexpected ${error.name}: ${error.message}`);
    }
    if (round % 20 === 0) {
      const calls = await paste(id, text);
      assert.equal(calls.update.length + calls.reply.length, 1);
      if (calls.reply.length) assert.equal(calls.reply[0].flags, MessageFlags.Ephemeral);
    }
  }
});

test('/createverify custom accepts pasted JSON and always keeps the real verify button', async () => {
  const guild = makeGuild();
  const channel = await guild.channels.create({ name: 'verify' });
  const owner = makeMember(ROLES.CREATOR);
  const opened = [];
  const interaction = { ...makeInteraction({ guild, member: owner }), options: { getChannel: () => ({ id: channel.id }), getString: () => 'custom' }, reply: async (payload) => opened.push(payload) };
  await createverify.execute(interaction);
  assert.ok(opened[0].components.flatMap((row) => row.toJSON().components).some((button) => button.custom_id === `createverify:${interaction.id}:paste`));

  for (const forged of [
    { embed: { title: 'Fake' }, buttons: [{ label: 'Free admin', style: 'primary', customId: 'ticket:open' }] },
    { embed: { title: 'Fake' }, components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Phish', url: 'https://evil.example' }] }] },
    { embed: { title: 'Fake', customId: 'verify:start' } },
  ]) {
    const calls = [];
    await createverify.handleComponent({ ...pasted('createverify', interaction.id, JSON.stringify(forged), { user: owner.user }), reply: async (payload) => calls.push(payload) });
    assert.match(calls[0].embeds[0].toJSON().description, /cannot be imported|Unknown property "embed\.customId"/);
  }

  const shown = [];
  await createverify.handleComponent({ ...pasted('createverify', interaction.id, JSON.stringify({ content: 'Verify below', embed: { title: 'Welcome', color: '#00ff00' } }), { user: owner.user }), update: async (payload) => shown.push(payload) });
  assert.equal(shown[0].embeds[0].toJSON().title, 'Welcome');
  assert.match(shown[0].content, /Verify with Roblox\*\* button is added automatically/);
  assert.equal(channel.sent.length, 0, 'pasting never sends');

  await createverify.handleComponent({ ...click('createverify', interaction.id, 'send'), user: owner.user, member: owner, guild, update: async () => {} });
  const [message] = channel.sent;
  assert.equal(message.content, 'Verify below');
  assert.equal(message.embeds[0].toJSON().title, 'Welcome');
  assert.deepEqual(buttonsOf(message), [['verify:start', 'Verify with Roblox']]);
  assert.equal(verificationPanels.findByMessage(message.id).type, 'custom');
});

test('/ticketcreate accepts pasted JSON and always keeps the real Open Ticket button', async () => {
  const guild = makeGuild();
  const category = addCategory(guild);
  const channel = await guild.channels.create({ name: 'tickets' });
  const admin = makeMember(ROLES.ADMINISTRATOR);
  const interaction = { ...makeInteraction({ guild, member: admin }), options: { getChannel: () => channel, getString: () => category.id }, reply: async () => {} };
  await ticketcreate.execute(interaction);

  const refused = [];
  await ticketcreate.handleComponent({ ...pasted('ticketcreate', interaction.id, '{"embed":{"title":"x"},"buttons":[{"label":"Close all","customId":"ticket:close:1"}]}', { user: admin.user }), reply: async (payload) => refused.push(payload) });
  assert.match(refused[0].embeds[0].toJSON().description, /Buttons cannot be imported/);

  const shown = [];
  await ticketcreate.handleComponent({ ...pasted('ticketcreate', interaction.id, JSON.stringify({ embed: { title: 'Support', fields: [{ name: 'Hours', value: '24/7' }] } }), { user: admin.user }), update: async (payload) => shown.push(payload) });
  assert.equal(shown[0].embeds[0].toJSON().title, 'Support');

  await ticketcreate.handleComponent({ ...click('ticketcreate', interaction.id, 'send'), user: admin.user, member: admin, guild, update: async () => {} });
  const [message] = channel.sent;
  assert.deepEqual(message.embeds[0].toJSON().fields, [{ name: 'Hours', value: '24/7', inline: false }]);
  assert.deepEqual(buttonsOf(message), [['ticket:open', 'Open Ticket']]);
  assert.equal(database.get().prepare('SELECT category_id FROM ticket_panels WHERE message_id = ?').get(message.id).category_id, category.id);
});

test('only the editor owner with the command permission can paste, and closed editors stay closed', async () => {
  const { id } = await open();
  await assert.rejects(embedBuilder.handle(pasted('embed', id, '{"embed":{"title":"Mine now"}}', { user: { id: '222222222222222222' } })), /Only the person who started this builder can use it/);
  await assert.rejects(embedBuilder.handle({ ...click('embed', id, 'paste'), user: { id: '222222222222222222' } }), /Only the person/);
  assert.equal(stateOf(id).title, '');

  const guild = makeGuild();
  for (const [prefix, command, role] of [['embed', embedCommand, ROLES.SUPPORT], ['createverify', createverify, ROLES.ADMINISTRATOR], ['ticketcreate', ticketcreate, ROLES.SENIOR_MODERATOR]]) {
    const member = makeMember(role);
    const replies = [];
    await interactionCreate.execute({
      ...pasted(prefix, id, '{"embed":{"title":"x"}}', { user: member.user }),
      guild,
      member,
      client: { commands: new Collection([[prefix, command]]), components: new Collection() },
      isChatInputCommand: () => false,
      isMessageComponent: () => false,
      isModalSubmit: () => true,
      inCachedGuild: () => true,
      reply: async (payload) => replies.push(payload),
    });
    assert.match(replies[0].embeds[0].toJSON().description, /You do not have permission to use this command/, prefix);
  }
  assert.equal(stateOf(id).title, '');

  await embedBuilder.handle(click('embed', id, 'cancel'));
  await assert.rejects(embedBuilder.handle(pasted('embed', id, '{"embed":{"title":"Too late"}}')), /This builder session has expired/);
});
