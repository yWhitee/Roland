const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { Collection, REST } = require('discord.js');

const APPLICATION = '100000000000000001';
const GUILD = '100000000000000002';
Object.assign(process.env, { DISCORD_TOKEN: 'test-token', DISCORD_CLIENT_ID: APPLICATION, DISCORD_GUILD_ID: GUILD });

const config = require('../src/config');
const ready = require('../src/events/ready');
const load = require('../src/loader');
const automod = require('../src/services/automod');
const levels = require('../src/services/levels');
const tempBans = require('../src/services/tempBans');
const verification = require('../src/services/verification');

const commands = load(path.join(__dirname, '..', 'src', 'commands'));
const GUILD_COMMANDS = [
  'automod', 'automodlist', 'automodwhitelist', 'ban', 'case', 'caseremove', 'chatbot', 'chatbotbypass', 'chatbotperm', 'clear', 'createverify', 'embed', 'kick', 'leaderboard', 'level',
  'levelset', 'levelsystem', 'logs', 'modlog', 'mute', 'nomessages', 'ping', 'ticketcreate', 'unban', 'unmute', 'verify', 'verifyinfo', 'warn',
];

const discord = async (respond = (request, body) => [200, body]) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => {
      const body = JSON.parse(data);
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      const [status, payload] = respond(request, body);
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const rest = new REST({ api: `http://127.0.0.1:${server.address().port}`, retries: 0 }).setToken(config.token);
  return { requests, rest, close: () => server.close() };
};

const start = async (rest, applicationId = APPLICATION) => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, starts: [tempBans.start, automod.start, levels.start, verification.startCleanup] };
  console.log = (line) => lines.push(line);
  console.warn = (line) => lines.push(line);
  tempBans.start = automod.start = levels.start = verification.startCleanup = () => {};
  try {
    await ready.execute({
      user: { tag: 'Roland#0001' },
      application: { id: applicationId },
      options: { ws: {} },
      commands: new Collection(commands.map((command) => [command.data.name, command])),
      rest,
    });
    return lines;
  } finally {
    Object.assign(console, { log: original.log, warn: original.warn });
    [tempBans.start, automod.start, levels.start, verification.startCleanup] = original.starts;
  }
};

test('Roland registers its commands on startup: 28 guild commands and /play as the only global command', async () => {
  const { requests, rest, close } = await discord();
  let lines;
  try {
    lines = await start(rest);
  } finally {
    close();
  }

  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    `PUT /v10/applications/${APPLICATION}/guilds/${GUILD}/commands`,
    `PUT /v10/applications/${APPLICATION}/commands`,
  ]);
  assert.ok(requests.every((request) => request.authorization === 'Bot test-token'));
  assert.deepEqual(requests[0].body.map((command) => command.name).sort(), GUILD_COMMANDS);
  assert.deepEqual(requests[1].body, [
    { options: [], name: 'play', description: 'Play Slime Odyssey: Anime Realms on Roblox', contexts: [0, 1], integration_types: [0], type: 1 },
  ]);
  assert.equal(lines.at(-1), `Registered 28 guild command(s) in guild ${GUILD} and 1 global command(s): play`);
});

test('commands are registered to the application the bot logged in as, with a warning when DISCORD_CLIENT_ID differs', async () => {
  const { requests, rest, close } = await discord();
  let lines;
  try {
    lines = await start(rest, '100000000000000009');
  } finally {
    close();
  }
  assert.ok(requests.every((request) => request.url.startsWith('/v10/applications/100000000000000009/')));
  assert.ok(lines.includes(`DISCORD_CLIENT_ID ${APPLICATION} does not match the bot's application 100000000000000009.`));
});

test('a Discord rejection of the global registration is surfaced', async () => {
  const { rest, close } = await discord((request, body) =>
    request.url.endsWith(`/applications/${APPLICATION}/commands`) ? [400, { message: 'Invalid Form Body', code: 50035 }] : [200, body]);
  try {
    await assert.rejects(start(rest), /Invalid Form Body/);
  } finally {
    close();
  }
});
