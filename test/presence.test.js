const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ActivityType, Client, GatewayIntentBits } = require('discord.js');
const presence = require('../src/presence');

const NAME = 'Generic Civilization Game ⚔';
const URL = 'https://www.roblox.com/games/138399961471218';

const login = () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds], presence: presence.options() });
  client.options.ws.presence = client.presence._parse(client.options.presence);
  return client;
};

const quietly = (task) => {
  const lines = [];
  const original = { log: console.log, warn: console.warn };
  console.log = (line) => lines.push(line);
  console.warn = (line) => lines.push(line);
  try {
    return { result: task(), lines };
  } finally {
    Object.assign(console, original);
  }
};

test('the activity is exactly Playing Generic Civilization Game ⚔ with the game URL as state', () => {
  assert.deepEqual(presence.ACTIVITY, { type: 0, name: NAME, state: URL });
  assert.equal(presence.ACTIVITY.type, ActivityType.Playing);
  assert.equal(presence.ACTIVITY.name.at(-1).codePointAt(0), 0x2694);
  assert.equal(presence.ACTIVITY.state, URL);
  assert.deepEqual(presence.options(), { status: 'online', activities: [{ type: 0, name: NAME, state: URL }] });
});

test('discord.js sends only type, name and state in the Gateway presence', () => {
  const client = login();
  assert.deepEqual(client.options.ws.presence, {
    activities: [{ type: 0, name: NAME, state: URL, url: undefined }],
    afk: false,
    since: null,
    status: 'online',
  });
  assert.equal(JSON.stringify(client.options.ws.presence.activities), JSON.stringify([{ type: 0, name: NAME, state: URL }]));
  assert.deepEqual(presence.ACTIVITY, { type: 0, name: NAME, state: URL }, 'the shared activity is not mutated');
});

test('the startup report logs the activity without leaking secrets', () => {
  const client = login();
  client.token = 'super-secret-token';
  const { result, lines } = quietly(() => presence.report(client));
  assert.equal(result.name, NAME);
  assert.deepEqual(lines, [`Rich Presence configured successfully: Playing "${NAME}" (${URL}).`]);
  assert.ok(!lines.join('\n').includes('super-secret-token'));
});

test('the report warns when presence was never configured', () => {
  const { result, lines } = quietly(() => presence.report({ options: { ws: {} } }));
  assert.equal(result, null);
  assert.deepEqual(lines, ['Rich Presence was not configured.']);
});

test('presence is set once through the client options with no unsupported fields', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const ready = fs.readFileSync(path.join(__dirname, '..', 'src', 'events', 'ready.js'), 'utf8');
  const module = fs.readFileSync(path.join(__dirname, '..', 'src', 'presence.js'), 'utf8');
  assert.match(index, /new Client\(\{ intents, presence: presence\.options\(\) \}\)/);
  assert.match(ready, /presence\.report\(client\)/);
  assert.doesNotMatch(module, /setInterval|setPresence|setActivity/);
  assert.doesNotMatch(module, /details|assets|buttons|timestamps|party|application_id|_url|url:|StatusDisplayType/);
});
