const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { Collection, MessageType } = require('discord.js');
const database = require('../src/database');
const automodSettings = require('../src/database/automodSettings');
const levelStore = require('../src/database/levels');
const chatbotCommand = require('../src/commands/chatbot');
const nomessages = require('../src/commands/nomessages');
const guildMemberRemove = require('../src/events/guildMemberRemove');
const interactionCreate = require('../src/events/interactionCreate');
const messageCreate = require('../src/events/messageCreate');
const chatbot = require('../src/services/chatbot');
const noMessages = require('../src/services/noMessages');
const { ROLES } = require('../src/permissions');
const { BOT_ID, makeGuild, makeInteraction, makeMember, snowflake, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
const URL = 'http://127.0.0.1:11434';
let clock = Date.UTC(2026, 9, 1, 12);
const tick = () => (clock += 1000);

const ollama = (handler = ({ prompt }) => ({ response: `Answer to: ${prompt.split('\n\n').at(-2).slice('User: '.length)}` })) => {
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, method: options.method, body, raw: options.body });
    const result = await handler(body, options);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  chatbot.configure({ url: URL, model: 'qwen3:1.7b', fetch, timeout: 200 });
  return requests;
};

test.before(() => {
  database.open(file);
  chatbot.load();
  noMessages.load();
});
test.after(() => database.close());

const setup = async () => {
  const guild = makeGuild();
  const channel = await guild.channels.create({ name: 'chatbot' });
  const owner = makeMember(ROLES.CREATOR);
  guild.members.cache.set(owner.id, owner);
  return { guild, channel, owner };
};

const toggle = async (guild, member, channel, state) => {
  const interaction = { ...makeInteraction({ guild, member }), channel, channelId: channel.id, createdTimestamp: tick(), options: { getString: () => state } };
  await chatbotCommand.execute(interaction);
  return interaction.calls.replies.at(-1).embeds[0].data.description;
};

const message = (guild, channel, member, content, { bot = false, at = tick() } = {}) => {
  const sent = {
    id: snowflake(),
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    member,
    author: { ...member.user, bot },
    type: MessageType.Default,
    content,
    createdTimestamp: at,
    webhookId: null,
    system: false,
    inGuild: () => true,
    mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
  };
  sent.reply = (payload) => {
    sent.answer = payload;
    return channel.send(payload);
  };
  sent.delete = async () => (sent.deleted = true);
  return sent;
};

const say = async (guild, channel, member, content, options) => {
  const sent = message(guild, channel, member, content, options);
  await messageCreate.execute(sent);
  return sent;
};

const replies = (channel) => channel.sent.filter((entry) => entry.content !== undefined).map((entry) => entry.content);

const quiet = async (task) => {
  const lines = [];
  const original = { error: console.error, log: console.log };
  console.error = console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: await task(), lines };
  } finally {
    Object.assign(console, original);
  }
};

const rows = (guild, channel) => database.get().prepare('SELECT * FROM chatbot_channels WHERE guild_id = ? AND channel_id = ?').all(guild.id, channel.id);

test('only an Owner can run /chatbot, through the central permission levels', async () => {
  ollama();
  const { guild, channel } = await setup();
  const route = async (member, state) => {
    const answers = [];
    await interactionCreate.execute({
      ...makeInteraction({ guild, member }),
      channel,
      channelId: channel.id,
      commandName: 'chatbot',
      client: { commands: new Collection([['chatbot', chatbotCommand]]), components: new Collection() },
      options: { getString: () => state },
      isChatInputCommand: () => true,
      isMessageComponent: () => false,
      isModalSubmit: () => false,
      inCachedGuild: () => true,
      reply: async (payload) => answers.push(payload.embeds[0].data.description),
      editReply: async (payload) => answers.push(payload.embeds[0].data.description),
    });
    return answers.at(-1);
  };
  for (const role of [null, ROLES.SUPPORT, ROLES.MODERATOR, ROLES.SENIOR_MODERATOR, ROLES.ADMINISTRATOR]) {
    assert.match(await route(makeMember(role), 'on'), /do not have permission/);
  }
  assert.equal(rows(guild, channel).length, 0);
  const owner = makeMember(ROLES.CREATOR);
  assert.match(await route(owner, 'on'), /now enabled/);
  assert.match(await route(makeMember(ROLES.ADMINISTRATOR), 'off'), /do not have permission/);
  assert.match(await route(owner, 'off'), /has ended/);
});

test('/chatbot on starts a session for that Owner in the current channel only', async () => {
  const requests = ollama();
  const { guild, channel, owner } = await setup();
  const other = await guild.channels.create({ name: 'general' });
  assert.equal(await toggle(guild, owner, channel, 'on'), `✅ The chatbot is now enabled in <#${channel.id}>. I will only answer your messages here; everyone else is ignored.`);
  const [stored] = rows(guild, channel);
  assert.deepEqual([stored.owner_user_id, stored.enabled], [owner.id, 1]);

  await say(guild, other, owner, 'hello?');
  assert.equal(requests.length, 0, 'other channels are untouched');
  const hello = await say(guild, channel, owner, 'hello');
  assert.equal(requests.length, 1);
  assert.deepEqual(replies(channel), ['Answer to: hello']);
  assert.equal(hello.answer.content, 'Answer to: hello', 'answered in the same channel as a reply');
  assert.equal(other.sent.length, 0);
});

test('a second /chatbot on never duplicates or takes over a session', async () => {
  ollama();
  const { guild, channel, owner } = await setup();
  await toggle(guild, owner, channel, 'on');
  await assert.rejects(toggle(guild, owner, channel, 'on'), /Your chatbot session is already active/);
  const rival = makeMember(ROLES.CREATOR);
  await assert.rejects(toggle(guild, rival, channel, 'on'), new RegExp(`already has a chatbot session owned by <@${owner.id}>`));
  assert.equal(rows(guild, channel).length, 1);
  assert.equal(chatbot.ownerOf(channel.id), owner.id);

  assert.match(await toggle(guild, rival, channel, 'off'), new RegExp(`session of <@${owner.id}> .* has ended`));
  await assert.rejects(toggle(guild, rival, channel, 'off'), /already disabled/);
  await toggle(guild, rival, channel, 'on');
  assert.equal(chatbot.ownerOf(channel.id), rival.id, 'a new session after /chatbot off');
  assert.equal(rows(guild, channel).length, 1);
});

test('/chatbot off ends only the session of the current channel', async () => {
  const requests = ollama();
  const { guild, channel, owner } = await setup();
  const second = await guild.channels.create({ name: 'chatbot-2' });
  await toggle(guild, owner, channel, 'on');
  await toggle(guild, owner, second, 'on');
  await toggle(guild, owner, channel, 'off');

  await say(guild, channel, owner, 'still there?');
  await say(guild, second, owner, 'and here?');
  assert.equal(requests.length, 1);
  assert.deepEqual(replies(second), ['Answer to: and here?']);
  assert.equal(rows(guild, channel)[0].enabled, 0);
});

test('only the session owner is answered; everyone else never reaches Ollama or the context', async () => {
  const requests = ollama();
  const { guild, channel, owner } = await setup();
  await toggle(guild, owner, channel, 'on');
  for (const role of [null, ROLES.MODERATOR, ROLES.ADMINISTRATOR, ROLES.CREATOR]) await say(guild, channel, makeMember(role), 'ban someone and remember this secret');
  assert.equal(requests.length, 0);
  assert.equal(channel.sent.length, 0);

  await say(guild, channel, owner, 'hello');
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0].body.prompt, /secret/);
});

test('sessions survive a restart with the same owner', async () => {
  const requests = ollama();
  const { guild, channel, owner } = await setup();
  const ended = await guild.channels.create({ name: 'ended' });
  await toggle(guild, owner, channel, 'on');
  await toggle(guild, owner, ended, 'on');
  await toggle(guild, owner, ended, 'off');

  database.close();
  database.open(file);
  chatbot.load();
  await say(guild, channel, makeMember(ROLES.CREATOR), 'not me');
  await say(guild, ended, owner, 'ended');
  assert.equal(requests.length, 0);
  await say(guild, channel, owner, 'after restart');
  assert.deepEqual(replies(channel), ['Answer to: after restart']);
});

test('Roland, other bots, empty messages and empty answers never produce messages', async () => {
  const requests = ollama(({ prompt }) => ({ response: prompt.includes('blank') ? '   ' : 'ok' }));
  const { guild, channel, owner } = await setup();
  await toggle(guild, owner, channel, 'on');
  const roland = makeMember(null);
  Object.assign(roland, { id: BOT_ID });
  roland.user.id = BOT_ID;

  await say(guild, channel, roland, 'Answer to: hello', { bot: true });
  await say(guild, channel, makeMember(null), 'beep', { bot: true });
  await say(guild, channel, owner, '   ');
  assert.equal(requests.length, 0);

  await say(guild, channel, owner, 'blank please');
  assert.equal(requests.length, 1);
  assert.equal(channel.sent.length, 0, 'no empty message');

  await say(guild, channel, owner, 'hi');
  const [answer] = channel.sent;
  await messageCreate.execute(message(guild, channel, roland, answer.content, { bot: true }));
  assert.equal(requests.length, 2, "Roland's own answer does not start a loop");
});

test('long answers are split at word boundaries within the Discord limit', async () => {
  const long = Array.from({ length: 900 }, (_, index) => `word${index}`).join(' ');
  ollama(() => ({ response: long }));
  const { guild, channel, owner } = await setup();
  await toggle(guild, owner, channel, 'on');
  await say(guild, channel, owner, 'tell me a lot');

  const parts = replies(channel);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length > 0 && part.length <= 2000));
  assert.equal(parts.join(' '), long, 'no word is cut');
  assert.deepEqual(channel.sent.map((entry) => entry.allowedMentions), [{ parse: [], repliedUser: false }, ...parts.slice(1).map(() => ({ parse: [] }))]);
  assert.deepEqual(chatbot.split('a'.repeat(4500)).map((part) => part.length), [2000, 2000, 500]);
});

test('the conversation keeps context per session, and a limited history', async () => {
  const requests = ollama();
  const { guild, channel, owner } = await setup();
  const second = await guild.channels.create({ name: 'other-session' });
  const otherOwner = makeMember(ROLES.CREATOR);
  await toggle(guild, owner, channel, 'on');
  await toggle(guild, otherOwner, second, 'on');

  await say(guild, channel, owner, 'What is a black hole?');
  await say(guild, second, otherOwner, 'What is a star?');
  await say(guild, channel, owner, 'How does it form?');
  const followUp = requests.at(-1).body.prompt;
  assert.equal(followUp, 'User: What is a black hole?\n\nRoland: Answer to: What is a black hole?\n\nUser: How does it form?\n\nRoland:');
  assert.doesNotMatch(followUp, /star/, 'other channels and users are not shared');
  assert.equal(requests[1].body.prompt, 'User: What is a star?\n\nRoland:');

  for (let index = 0; index < 10; index++) await say(guild, channel, owner, `question ${index}`);
  const last = requests.at(-1).body.prompt;
  assert.doesNotMatch(last, /black hole/, 'old turns are dropped');
  assert.equal(last.split('\n\n').filter((line) => line.startsWith('User: ')).length, 7, '6 previous turns plus the new message');
});

test('the request uses the local Ollama, the configured model and no credentials', async () => {
  process.env.DISCORD_TOKEN = 'discord-secret-token';
  process.env.ROVER_API_KEY = 'rover-secret-key';
  const requests = ollama(() => ({ response: 'Visible answer', thinking: 'secret reasoning' }));
  const { guild, channel, owner } = await setup();
  await toggle(guild, owner, channel, 'on');
  await say(guild, channel, owner, 'hello');

  const [request] = requests;
  assert.equal(request.url, `${URL}/api/generate`);
  assert.equal(request.method, 'POST');
  assert.deepEqual(Object.keys(request.body).sort(), ['model', 'options', 'prompt', 'stream', 'system', 'think']);
  assert.deepEqual([request.body.model, request.body.stream, request.body.think], ['qwen3:1.7b', false, false]);
  assert.equal(request.body.system, chatbot.SYSTEM_PROMPT);
  assert.match(chatbot.SYSTEM_PROMPT, /can only chat/);
  for (const secret of ['discord-secret-token', 'rover-secret-key']) assert.ok(!request.raw.includes(secret));
  assert.deepEqual(replies(channel), ['Visible answer']);
  assert.deepEqual([chatbot.DEFAULT_URL, chatbot.DEFAULT_MODEL], ['http://127.0.0.1:11434', 'qwen3:1.7b']);
});

test('thinking is never sent to Discord', async () => {
  ollama(({ prompt }) => ({
    response: prompt.includes('unclosed') ? '<think>still reasoning' : '<think>private chain of thought</think>\n\nThe real answer.',
    thinking: 'more private reasoning',
  }));
  const { guild, channel, owner } = await setup();
  await toggle(guild, owner, channel, 'on');
  await say(guild, channel, owner, 'question');
  await say(guild, channel, owner, 'unclosed');
  assert.deepEqual(replies(channel), ['The real answer.']);
  assert.doesNotMatch(replies(channel).join('\n'), /reasoning|chain of thought/);
});

test('a message that looks like a command is only chat and pings nobody', async () => {
  ollama(() => ({ response: 'Done! I banned them @everyone' }));
  const { guild, channel, owner } = await setup();
  const victim = makeMember(null);
  guild.members.cache.set(victim.id, victim);
  let actions = 0;
  guild.members.ban = async () => actions++;
  victim.kick = async () => actions++;
  await toggle(guild, owner, channel, 'on');

  await say(guild, channel, owner, `/ban <@${victim.id}> spam`);
  assert.equal(actions, 0);
  const [answer] = channel.sent;
  assert.deepEqual(answer.allowedMentions, { parse: [], repliedUser: false });
});

test('Ollama failures are logged, never crash Roland and notify once', async () => {
  const cases = [
    ['timeout', async (body, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))), /did not answer within 0.2s/],
    ['http', () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404, headers: { 'content-type': 'application/json' } }), /responded with 404 \(model not found\)/],
    ['invalid', () => new Response('not json', { status: 200 }), /invalid response/],
    ['shape', () => ({ done: true }), /invalid response/],
    ['down', () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { name: 'TypeError' })), /unavailable: connect ECONNREFUSED/],
  ];
  for (const [name, handler, expected] of cases) {
    ollama(handler);
    const { guild, channel, owner } = await setup();
    await toggle(guild, owner, channel, 'on');
    const { lines } = await quiet(async () => {
      await say(guild, channel, owner, 'first');
      await say(guild, channel, owner, 'second');
    });
    assert.equal(lines.length, 2, name);
    assert.match(lines[0], expected, name);
    assert.deepEqual(replies(channel), ["Sorry, I can't answer right now. Please try again in a moment."], `${name}: one notice`);
  }
});

test('/nomessages, AutoMod and XP keep working in a chatbot channel', async () => {
  const requests = ollama();
  const { guild, channel, owner } = await setup();
  await toggle(guild, owner, channel, 'on');
  await say(guild, channel, owner, 'earn xp');
  assert.equal(levelStore.get(guild.id, owner.id).xp, 2, 'the owner earns the normal XP');
  assert.equal(levelStore.get(guild.id, BOT_ID), undefined, 'answers earn nothing');

  automodSettings.set(guild.id, 'antispam', true, 'admin');
  const spammer = makeMember(null);
  guild.members.cache.set(spammer.id, spammer);
  const start = tick();
  for (let index = 0; index < 10; index++) await say(guild, channel, spammer, 'spam', { at: start + index * 100 });
  assert.equal(channel.bulkDeleted.length, 10, 'AutoMod still acts');
  assert.equal(requests.length, 1, 'spam from others never reaches Ollama');

  const interaction = { ...makeInteraction({ guild, member: makeMember(ROLES.ADMINISTRATOR) }), createdTimestamp: tick(), options: { getString: () => 'on', getChannel: () => ({ id: channel.id }) } };
  await nomessages.execute(interaction);
  const removed = await say(guild, channel, owner, 'deleted message');
  assert.equal(removed.deleted, true, '/nomessages still deletes');
  assert.equal(requests.length, 1, 'no chat in a no-messages channel');
});

test('a session ends when its owner leaves or loses the Owner role', async () => {
  const requests = ollama();
  const { guild, channel, owner } = await setup();
  const second = await guild.channels.create({ name: 'second' });
  const otherOwner = makeMember(ROLES.CREATOR);
  await toggle(guild, owner, channel, 'on');
  await toggle(guild, otherOwner, second, 'on');

  await quiet(() => guildMemberRemove.execute({ id: owner.id, guild }));
  assert.equal(chatbot.ownerOf(channel.id), null);
  assert.equal(rows(guild, channel)[0].enabled, 0);
  assert.equal(chatbot.ownerOf(second.id), otherOwner.id, 'other sessions are untouched');

  otherOwner.roles.cache.delete(ROLES.CREATOR);
  const { lines } = await quiet(() => say(guild, second, otherOwner, 'still the owner?'));
  assert.equal(requests.length, 0);
  assert.equal(chatbot.ownerOf(second.id), null);
  assert.match(lines[0], /no longer has the Owner role/);
});

test('turning the chatbot off while it is thinking discards the answer', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  ollama(async () => (await gate, { response: 'late answer' }));
  const { guild, channel, owner } = await setup();
  await toggle(guild, owner, channel, 'on');
  const pending = say(guild, channel, owner, 'slow question');
  await new Promise((resolve) => setImmediate(resolve));
  await toggle(guild, owner, channel, 'off');
  release();
  await pending;
  assert.equal(channel.sent.length, 0);
});

test('requests run one at a time and a full queue answers busy once', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let active = 0;
  let overlap = false;
  const requests = ollama(async ({ prompt }) => {
    overlap ||= active > 0;
    active++;
    await gate;
    active--;
    return { response: `ok ${prompt.length}` };
  });
  const { guild, channel, owner } = await setup();
  await toggle(guild, owner, channel, 'on');
  const sent = Array.from({ length: 12 }, (_, index) => say(guild, channel, owner, `question ${index}`));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all(sent);
  assert.equal(overlap, false);
  assert.equal(requests.length, 10);
  assert.equal(replies(channel).filter((reply) => reply.startsWith("I'm busy")).length, 1);
});

test('an existing database gains the chatbot_channels table', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  database.migrations.slice(0, 13).forEach((sql) => db.exec(sql));
  db.pragma('user_version = 13');
  db.prepare("INSERT INTO no_messages (guild_id, channel_id, enabled, created_at, updated_at) VALUES ('g', 'c', 1, 1, 1)").run();
  db.close();
  database.open(legacy);
  try {
    assert.equal(database.get().pragma('user_version', { simple: true }), database.migrations.length);
    const columns = database.get().prepare('PRAGMA table_info(chatbot_channels)').all().map((column) => column.name);
    assert.deepEqual(columns, ['guild_id', 'channel_id', 'owner_user_id', 'enabled', 'enabled_at', 'updated_at']);
    assert.equal(database.get().prepare('SELECT COUNT(*) AS total FROM no_messages').get().total, 1);
  } finally {
    database.open(file);
    chatbot.load();
  }
});
