const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { Collection, REST, Routes } = require('discord.js');
const database = require('../src/database');
const interactionCreate = require('../src/events/interactionCreate');
const load = require('../src/loader');
const { ROLES } = require('../src/permissions');
const { makeMember, tempDatabase } = require('./helpers/discord');

const commands = load(path.join(__dirname, '..', 'src', 'commands'));
const components = load(path.join(__dirname, '..', 'src', 'components'));
const EXPECTED = ['ban', 'clear', 'embed', 'kick', 'logs', 'modlog', 'mute', 'ping', 'ticketcreate', 'unban', 'unmute', 'warn'];

test.before(() => database.open(tempDatabase()));
test.after(() => database.close());

test('every command loads and builds valid JSON', () => {
  const names = commands.map((command) => command.data.toJSON().name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), EXPECTED);
  for (const command of commands) {
    assert.equal(typeof command.execute, 'function', command.data.name);
    if (command.data.name !== 'ping') assert.ok(command.level > 0, command.data.name);
  }
});

test('/ping is intact', () => {
  const ping = commands.find((command) => command.data.name === 'ping');
  assert.deepEqual(JSON.parse(JSON.stringify(ping.data.toJSON())), { options: [], name: 'ping', description: 'Check the bot connection', type: 1 });
});

test('/ticketcreate takes a channel and a category ID', () => {
  const json = commands.find((command) => command.data.name === 'ticketcreate').data.toJSON();
  assert.deepEqual(json.options.map((option) => [option.name, option.required]), [['channel', true], ['categoryid', true]]);
});

test('slash commands are registered as guild commands', async () => {
  const body = commands.map((command) => command.data.toJSON());
  const received = await new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      let data = '';
      request.on('data', (chunk) => (data += chunk));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(data);
        server.close();
        resolve({ method: request.method, url: request.url, body: JSON.parse(data) });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      new REST({ api: `http://127.0.0.1:${server.address().port}` })
        .setToken('test')
        .put(Routes.applicationGuildCommands('100000000000000001', '100000000000000002'), { body })
        .catch(reject);
    });
  });

  assert.equal(received.method, 'PUT');
  assert.equal(received.url, '/v10/applications/100000000000000001/guilds/100000000000000002/commands');
  assert.deepEqual(received.body.map((command) => command.name).sort(), EXPECTED);
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
  assert.deepEqual(await route({ member: makeMember(), customId: 'other:thing' }), []);
});
