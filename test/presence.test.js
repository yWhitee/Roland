const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ActivityType, Client, GatewayIntentBits } = require('discord.js');
const presence = require('../src/presence');

const APPLICATION_ID = '100000000000000001';
const STARTED_AT = 1_800_000_000_000;
const GAME_URL = 'https://www.roblox.com/games/138399961471218';

const login = () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds], presence: presence.configure({ applicationId: APPLICATION_ID, startedAt: STARTED_AT }) });
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

test('the activity contains every Rich Presence field we want to test', () => {
  const activity = presence.buildActivity({ applicationId: APPLICATION_ID, startedAt: STARTED_AT });
  assert.equal(activity.type, ActivityType.Playing);
  assert.equal(activity.name, 'Slime Odyssey: Anime Realms');
  assert.equal(activity.details, 'Exploring the world');
  assert.equal(activity.state, 'Development build');
  assert.equal(activity.application_id, APPLICATION_ID);
  assert.deepEqual(activity.timestamps, { start: STARTED_AT });
  assert.deepEqual(activity.assets, {
    large_image: 'slime_odyssey_large',
    large_text: 'Slime Odyssey: Anime Realms',
    large_url: GAME_URL,
    small_image: 'roland_small',
    small_text: 'Roland',
    small_url: GAME_URL,
  });
  assert.deepEqual(activity.buttons, [{ label: 'Play on Roblox', url: GAME_URL }], 'one button: no invite is configured in the project');
  assert.ok(activity.buttons.length <= 2);
  for (const url of [activity.url, activity.details_url, activity.state_url]) assert.equal(url, GAME_URL);
  assert.equal(activity.secrets, undefined, 'no join or spectate secrets');
  assert.equal(activity.timestamps.end, undefined);
});

test('discord.js only serializes type, name, state and url for the bot Gateway presence', () => {
  const client = login();
  assert.deepEqual(client.options.ws.presence, {
    activities: [{ type: ActivityType.Playing, name: 'Slime Odyssey: Anime Realms', state: 'Development build', url: GAME_URL }],
    afk: false,
    since: null,
    status: 'online',
  });
});

test('the startup report lists what was sent and what was omitted without leaking secrets', () => {
  const client = login();
  client.token = 'super-secret-token';
  const { result, lines } = quietly(() => presence.report(client));

  assert.deepEqual(result.sent, ['type', 'name', 'state', 'url']);
  assert.deepEqual(result.omitted, [
    'details',
    'details_url',
    'state_url',
    'application_id',
    'status_display_type',
    'platform',
    'instance',
    'timestamps.start',
    'party.id',
    'party.size',
    'assets.large_image',
    'assets.large_text',
    'assets.large_url',
    'assets.small_image',
    'assets.small_text',
    'assets.small_url',
    'buttons',
  ]);
  assert.match(lines[0], /^Rich Presence configured successfully: Playing "Slime Odyssey: Anime Realms" \(sent: type, name, state, url\)\.$/);
  assert.match(lines[1], /Rich Presence fields not sent: details, details_url/);
  assert.match(lines[2], /url is only used by Discord for Streaming activities/);
  assert.ok(!lines.join('\n').includes('super-secret-token'));
});

test('the report warns when presence was never configured', () => {
  const { result, lines } = quietly(() => presence.report({ options: { ws: {} } }));
  assert.equal(result, null);
  assert.deepEqual(lines, ['Rich Presence was not configured.']);
});

test('presence is set through the client options once, without an interval', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const ready = fs.readFileSync(path.join(__dirname, '..', 'src', 'events', 'ready.js'), 'utf8');
  const module = fs.readFileSync(path.join(__dirname, '..', 'src', 'presence.js'), 'utf8');
  assert.match(index, /new Client\(\{ intents, presence: presence\.configure\(\{ applicationId: config\.clientId \}\) \}\)/);
  assert.match(ready, /presence\.report\(client\)/);
  assert.doesNotMatch(module, /setInterval|setPresence|setActivity/);
});
