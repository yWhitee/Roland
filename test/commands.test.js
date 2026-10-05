const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { ButtonStyle, Collection, MessageFlags, REST } = require('discord.js');
const database = require('../src/database');
const interactionCreate = require('../src/events/interactionCreate');
const { registerCommands } = require('../src/commandRegistration');
const load = require('../src/loader');
const { ROLES } = require('../src/permissions');
const { makeMember, tempDatabase } = require('./helpers/discord');

const commands = load(path.join(__dirname, '..', 'src', 'commands'));
const components = load(path.join(__dirname, '..', 'src', 'components'));
const EXPECTED = [
  'automod', 'automodlist', 'automodwhitelist', 'ban', 'clear', 'createverify', 'embed', 'kick', 'leaderboard', 'level',
  'levelset', 'levelsystem', 'logs', 'modlog', 'mute', 'nomessages', 'ping', 'ticketcreate', 'unban', 'unmute', 'verify', 'verifyinfo', 'warn',
];

test.before(() => database.open(tempDatabase()));
test.after(() => database.close());

test('every command loads and builds valid JSON', () => {
  const names = commands.map((command) => command.data.toJSON().name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), [...EXPECTED, 'play'].sort());
  for (const command of commands) {
    assert.equal(typeof command.execute, 'function', command.data.name);
    if (!['ping', 'verify', 'level', 'leaderboard', 'play'].includes(command.data.name)) assert.ok(command.level > 0, command.data.name);
  }
});

test('/ping is intact', () => {
  const ping = commands.find((command) => command.data.name === 'ping');
  assert.deepEqual(JSON.parse(JSON.stringify(ping.data.toJSON())), { options: [], name: 'ping', description: 'Check the bot connection', type: 1 });
});

test('/createverify takes a channel picker and a standard/custom choice', () => {
  const json = commands.find((command) => command.data.name === 'createverify').data.toJSON();
  assert.deepEqual(json.options.map((option) => [option.name, option.type, option.required]), [['channel', 7, true], ['type', 3, true]]);
  assert.deepEqual(json.options[1].choices.map((choice) => choice.value), ['standard', 'custom']);
});

test('AutoMod commands use the central Function ID list', () => {
  const { FUNCTIONS } = require('../src/services/automod/functions');
  const ids = FUNCTIONS.map((fn) => fn.id);
  assert.deepEqual(ids.sort(), ['antiduplicate', 'antiemojispam', 'antiflood', 'antiinvite', 'antimassping', 'antiraid', 'antispam']);
  for (const name of ['automod', 'automodwhitelist']) {
    const json = commands.find((command) => command.data.name === name).data.toJSON();
    assert.deepEqual(json.options.find((option) => option.name === 'function').choices.map((choice) => choice.value).sort(), ids);
  }
  const whitelist = commands.find((command) => command.data.name === 'automodwhitelist').data.toJSON();
  assert.deepEqual(whitelist.options.map((option) => [option.name, option.type, Boolean(option.required)]), [['target', 9, true], ['function', 3, true], ['state', 3, false]]);
});

test('/ticketcreate takes a channel and a category ID', () => {
  const json = commands.find((command) => command.data.name === 'ticketcreate').data.toJSON();
  assert.deepEqual(json.options.map((option) => [option.name, option.required]), [['channel', true], ['categoryid', true]]);
});

test('existing commands are registered as guild commands and /play as a global command', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body: JSON.parse(data) });
      response.setHeader('content-type', 'application/json');
      response.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const rest = new REST({ api: `http://127.0.0.1:${server.address().port}` }).setToken('test');
    const registered = await registerCommands(rest, { clientId: '100000000000000001', guildId: '100000000000000002', commands });
    assert.deepEqual({ guild: registered.guild.sort(), global: registered.global }, { guild: EXPECTED, global: ['play'] });
  } finally {
    server.close();
  }

  const guild = requests.find((request) => request.url === '/v10/applications/100000000000000001/guilds/100000000000000002/commands');
  const global = requests.find((request) => request.url === '/v10/applications/100000000000000001/commands');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.method === 'PUT'));
  assert.deepEqual(guild.body.map((command) => command.name).sort(), EXPECTED, 'existing commands stay guild commands');
  assert.ok(!guild.body.some((command) => command.name === 'play'), 'no duplicate /play guild command');
  assert.deepEqual(global.body.map((command) => command.name), ['play'], 'only /play is global');
  assert.deepEqual(global.body[0], { options: [], name: 'play', description: 'Play Slime Odyssey: Anime Realms on Roblox', contexts: [0, 1], integration_types: [0], type: 1 });
  assert.equal(global.body[0].default_member_permissions, undefined, 'no permission restriction');
});

const route = async ({ member, customId, commandName }) => {
  const replies = [];
  await interactionCreate.execute({
    client: {
      commands: new Collection(commands.map((command) => [command.data.name, command])),
      components: new Collection(components.map((component) => [component.prefix, component])),
    },
    customId,
    commandName,
    member,
    user: member.user,
    message: { id: 'unknown-panel' },
    deferred: false,
    replied: false,
    isChatInputCommand: () => Boolean(commandName),
    isMessageComponent: () => !commandName,
    isModalSubmit: () => false,
    inCachedGuild: () => true,
    reply: async (payload) => replies.push(payload.embeds[0].data.description),
  });
  return replies;
};

test('the router applies command levels and leaves ticket buttons open to everyone', async () => {
  assert.match((await route({ member: makeMember(ROLES.MODERATOR), commandName: 'ticketcreate' }))[0], /do not have permission/);
  assert.match((await route({ member: makeMember(ROLES.SENIOR_MODERATOR), customId: 'ticketcreate:1:send' }))[0], /do not have permission/);
  assert.match((await route({ member: makeMember(), customId: 'ticket:open' }))[0], /no longer active/);
  assert.match((await route({ member: makeMember(), customId: 'ticket:unknown' }))[0], /no longer supported/);
  assert.match((await route({ member: makeMember(ROLES.ADMINISTRATOR), commandName: 'createverify' }))[0], /do not have permission/);
  assert.match((await route({ member: makeMember(ROLES.ADMINISTRATOR), customId: 'createverify:1:send' }))[0], /do not have permission/);
  assert.match((await route({ member: makeMember(), customId: 'verify:other' }))[0], /no longer supported/);
  assert.deepEqual(await route({ member: makeMember(), customId: 'other:thing' }), []);
});

const play = async (interaction) => {
  const replies = [];
  const sent = [];
  await interactionCreate.execute({
    client: { commands: new Collection(commands.map((command) => [command.data.name, command])), components: new Collection() },
    commandName: 'play',
    channel: { send: async (payload) => sent.push(payload) },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isMessageComponent: () => false,
    isModalSubmit: () => false,
    reply: async (payload) => replies.push(payload),
    ...interaction,
  });
  return { reply: replies[0], sent };
};

test('/play answers anyone privately with a Play on Roblox link button', async () => {
  const contexts = {
    'member without roles': { member: makeMember(), inCachedGuild: () => true },
    Member: { member: makeMember('1555596685462479048'), inCachedGuild: () => true },
    Owner: { member: makeMember(ROLES.CREATOR), inCachedGuild: () => true },
    'direct message': { member: null, user: { id: '123456789012345678' }, inCachedGuild: () => false },
  };

  for (const [name, context] of Object.entries(contexts)) {
    const { reply, sent } = await play(context);
    assert.ok(reply, `${name}: replied`);
    assert.equal(reply.flags, MessageFlags.Ephemeral, `${name}: ephemeral`);
    assert.match(reply.content, /Go play \*\*Slime Odyssey: Anime Realms\*\*!/);
    const [button] = reply.components[0].toJSON().components;
    assert.deepEqual([button.style, button.label, button.url], [ButtonStyle.Link, 'Play on Roblox', 'https://www.roblox.com/games/138399961471218']);
    assert.equal(sent.length, 0, `${name}: nothing is sent publicly`);
  }
});
