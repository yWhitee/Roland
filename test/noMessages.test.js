const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { Collection, MessageType, RESTJSONErrorCodes } = require('discord.js');
const database = require('../src/database');
const automodSettings = require('../src/database/automodSettings');
const levelStore = require('../src/database/levels');
const nomessages = require('../src/commands/nomessages');
const messageCreate = require('../src/events/messageCreate');
const interactionCreate = require('../src/events/interactionCreate');
const noMessages = require('../src/services/noMessages');
const { Level, ROLES } = require('../src/permissions');
const { BOT_ID, apiError, makeGuild, makeInteraction, makeMember, snowflake, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
let clock = Date.UTC(2026, 9, 1, 12);
const tick = () => (clock += 1000);

test.before(() => {
  database.open(file);
  noMessages.load();
});
test.after(() => database.close());

const setup = async () => {
  const guild = makeGuild();
  const channel = await guild.channels.create({ name: 'no-chat' });
  return { guild, channel, admin: makeMember(ROLES.ADMINISTRATOR) };
};

const author = (guild) => {
  const member = makeMember(null);
  guild.members.cache.set(member.id, member);
  return member;
};

const message = (guild, channel, member, { at = tick(), bot = false, webhookId = null, system = false, remove } = {}) => {
  const sent = {
    id: snowflake(),
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    member,
    author: { ...member.user, bot },
    type: MessageType.Default,
    content: 'hello there',
    createdTimestamp: at,
    webhookId,
    system,
    deleted: false,
    deletes: 0,
    inGuild: () => true,
    mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
  };
  sent.delete = async () => {
    sent.deletes++;
    if (remove) return remove();
    sent.deleted = true;
    return sent;
  };
  return sent;
};

const post = async (guild, channel, member, options) => {
  const sent = message(guild, channel, member, options);
  await messageCreate.execute(sent);
  return sent;
};

const run = async (guild, member, state, channel, at = tick()) => {
  const interaction = {
    ...makeInteraction({ guild, member }),
    createdTimestamp: at,
    options: { getString: () => state, getChannel: () => ({ id: channel.id }) },
  };
  await nomessages.execute(interaction);
  return interaction.calls.replies.at(-1).embeds[0].data.description;
};

const route = async (guild, member, state, channel) => {
  const replies = [];
  await interactionCreate.execute({
    ...makeInteraction({ guild, member }),
    commandName: 'nomessages',
    client: { commands: new Collection([['nomessages', nomessages]]), components: new Collection() },
    options: { getString: () => state, getChannel: () => ({ id: channel.id }) },
    isChatInputCommand: () => true,
    isMessageComponent: () => false,
    isModalSubmit: () => false,
    inCachedGuild: () => true,
    reply: async (payload) => replies.push(payload.embeds[0].data.description),
    editReply: async (payload) => replies.push(payload.embeds[0].data.description),
  });
  return replies.at(-1);
};

const quiet = async (task) => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await task(), lines };
  } finally {
    console.error = original;
  }
};

const row = (guild, channel) => database.get().prepare('SELECT * FROM no_messages WHERE guild_id = ? AND channel_id = ?').all(guild.id, channel.id);

test('/nomessages on enables the channel and stores when it was enabled', async () => {
  const { guild, channel, admin } = await setup();
  const at = tick();
  const reply = await run(guild, admin, 'on', channel, at);
  assert.equal(reply, `✅ No-messages mode is now enabled in <#${channel.id}>. New messages sent there will be deleted.`);
  const [stored] = row(guild, channel);
  assert.deepEqual([stored.enabled, stored.enabled_at, stored.updated_by], [1, at, admin.id]);

  const sent = await post(guild, channel, author(guild));
  assert.equal(sent.deleted, true);
});

test('/nomessages off disables the channel and later messages stay', async () => {
  const { guild, channel, admin } = await setup();
  const member = author(guild);
  await run(guild, admin, 'on', channel);
  assert.equal((await post(guild, channel, member)).deleted, true);
  assert.equal((await post(guild, channel, member)).deleted, true);

  const reply = await run(guild, admin, 'off', channel);
  assert.equal(reply, `✅ No-messages mode is now disabled in <#${channel.id}>. Messages sent there will no longer be deleted.`);
  assert.deepEqual([row(guild, channel)[0].enabled, row(guild, channel)[0].enabled_at], [0, null]);
  assert.equal((await post(guild, channel, member)).deleted, false);
});

test('messages in normal channels and in other channels are never deleted', async () => {
  const { guild, channel, admin } = await setup();
  const other = await guild.channels.create({ name: 'general' });
  const member = author(guild);
  assert.equal((await post(guild, channel, member)).deleted, false, 'not enabled yet');
  await run(guild, admin, 'on', channel);
  assert.equal((await post(guild, other, member)).deleted, false);
  assert.equal((await post(guild, channel, member)).deleted, true);
});

test('only messages sent after /nomessages on are deleted, without reading the channel history', async () => {
  const { guild, channel, admin } = await setup();
  const member = author(guild);
  let historyRead = false;
  channel.messages.fetch = async () => {
    historyRead = true;
    return new Collection();
  };
  const before = message(guild, channel, member, { at: tick() });
  const enabledAt = tick();
  await run(guild, admin, 'on', channel, enabledAt);

  await messageCreate.execute(before);
  assert.equal(before.deleted, false, 'sent before activation, processed after it');
  assert.equal(before.deletes, 0);
  assert.equal((await post(guild, channel, member, { at: enabledAt })).deleted, true, 'sent at the activation time');
  assert.equal((await post(guild, channel, member, { at: tick() })).deleted, true);
  assert.equal(historyRead, false);
});

test('enabling or disabling twice keeps a single consistent setting', async () => {
  const { guild, channel, admin } = await setup();
  const first = tick();
  await run(guild, admin, 'on', channel, first);
  await assert.rejects(run(guild, admin, 'on', channel), new RegExp(`already enabled in <#${channel.id}>`));
  assert.equal(row(guild, channel).length, 1);
  assert.equal(row(guild, channel)[0].enabled_at, first, 'the activation time is not moved');

  await run(guild, admin, 'off', channel);
  await assert.rejects(run(guild, admin, 'off', channel), new RegExp(`already disabled in <#${channel.id}>`));
  assert.equal(row(guild, channel).length, 1);
  assert.equal(row(guild, channel)[0].enabled, 0);

  const fresh = await guild.channels.create({ name: 'never-enabled' });
  await assert.rejects(run(guild, admin, 'off', fresh), /already disabled/);
  assert.equal(row(guild, fresh).length, 0, 'disabling an unknown channel creates nothing');
  assert.equal((await post(guild, channel, author(guild))).deleted, false);
});

test('the setting survives a restart, both on and off', async () => {
  const { guild, channel, admin } = await setup();
  const off = await guild.channels.create({ name: 'was-on' });
  await run(guild, admin, 'on', channel);
  await run(guild, admin, 'on', off);
  await run(guild, admin, 'off', off);

  database.close();
  database.open(file);
  assert.ok(noMessages.load() >= 1);

  const member = author(guild);
  assert.equal((await post(guild, channel, member)).deleted, true);
  assert.equal((await post(guild, off, member)).deleted, false);
});

test('guilds and channels are configured independently', async () => {
  const first = await setup();
  const second = await setup();
  const sibling = await first.guild.channels.create({ name: 'sibling' });
  await run(first.guild, first.admin, 'on', first.channel);

  assert.equal((await post(first.guild, first.channel, author(first.guild))).deleted, true);
  assert.equal((await post(first.guild, sibling, author(first.guild))).deleted, false);
  assert.equal((await post(second.guild, second.channel, author(second.guild))).deleted, false);

  await run(second.guild, second.admin, 'on', second.channel);
  await run(first.guild, first.admin, 'off', first.channel);
  assert.equal((await post(first.guild, first.channel, author(first.guild))).deleted, false);
  assert.equal((await post(second.guild, second.channel, author(second.guild))).deleted, true);
});

test("Roland's own messages, other bots, webhooks and system messages are not deleted", async () => {
  const { guild, channel, admin } = await setup();
  await run(guild, admin, 'on', channel);
  const roland = makeMember(null);
  roland.id = BOT_ID;
  roland.user.id = BOT_ID;

  assert.equal((await post(guild, channel, roland, { bot: true })).deletes, 0);
  assert.equal((await post(guild, channel, makeMember(null), { bot: true })).deletes, 0);
  assert.equal((await post(guild, channel, author(guild), { webhookId: snowflake() })).deletes, 0);
  assert.equal((await post(guild, channel, author(guild), { system: true })).deletes, 0);
});

test('Unknown Message is ignored and never retried', async () => {
  const { guild, channel, admin } = await setup();
  await run(guild, admin, 'on', channel);
  const { result, lines } = await quiet(() => post(guild, channel, author(guild), { remove: () => Promise.reject(apiError(RESTJSONErrorCodes.UnknownMessage)) }));
  assert.equal(result.deletes, 1);
  assert.deepEqual(lines, []);
});

test('Missing Permissions is logged once per channel and does not stop other messages', async () => {
  const { guild, channel, admin } = await setup();
  await run(guild, admin, 'on', channel);
  const denied = () => Promise.reject(apiError(RESTJSONErrorCodes.MissingPermissions, 403));
  const { lines } = await quiet(async () => {
    await post(guild, channel, author(guild), { remove: denied });
    await post(guild, channel, author(guild), { remove: denied });
  });
  assert.deepEqual(lines, [`No-messages could not delete a message in channel ${channel.id}: API error ${RESTJSONErrorCodes.MissingPermissions}`]);
  assert.equal((await post(guild, channel, author(guild))).deleted, true, 'the next message is deleted once permissions work');

  const again = await quiet(() => post(guild, channel, author(guild), { remove: denied }));
  assert.equal(again.lines.length, 1, 'logged again after a successful deletion');
});

test('network or API failures are logged without crashing', async () => {
  const { guild, channel, admin } = await setup();
  await run(guild, admin, 'on', channel);
  const { result, lines } = await quiet(() => post(guild, channel, author(guild), { remove: () => Promise.reject(new Error('socket hang up')) }));
  assert.equal(result.deleted, false);
  assert.deepEqual(lines, [`No-messages could not delete a message in channel ${channel.id}: socket hang up`]);
  assert.equal((await post(guild, channel, author(guild))).deleted, true);
});

test('on/off and messageCreate use the state applied when the message is processed', async () => {
  const { guild, channel, admin } = await setup();
  const member = author(guild);
  await run(guild, admin, 'on', channel);
  const sentBeforeOff = message(guild, channel, member, { at: tick() });
  const deleting = message(guild, channel, member, { at: tick() });

  const processing = messageCreate.execute(deleting);
  await run(guild, admin, 'off', channel);
  await processing;
  assert.equal(deleting.deleted, true, 'the deletion started before /nomessages off was applied');

  await messageCreate.execute(sentBeforeOff);
  assert.equal(sentBeforeOff.deletes, 0, 'processed after off: kept, even though it was sent while on');

  await Promise.all([run(guild, admin, 'on', channel), messageCreate.execute(message(guild, channel, member, { at: tick() }))]);
  assert.equal(row(guild, channel).length, 1);
});

test('the cache is updated by the command and no database query is made per message', async () => {
  const { guild, channel, admin } = await setup();
  await run(guild, admin, 'on', channel);
  const original = database.get;
  let queries = 0;
  database.get = () => {
    queries++;
    return original();
  };
  try {
    assert.notEqual(noMessages.handleMessage(message(guild, channel, author(guild))), null);
    assert.equal(noMessages.handleMessage(message(guild, await guild.channels.create({ name: 'free' }), author(guild))), null);
    assert.equal(queries, 0);
  } finally {
    database.get = original;
  }
  await run(guild, admin, 'off', channel);
  assert.equal(noMessages.handleMessage(message(guild, channel, author(guild))), null, 'the cache follows /nomessages off immediately');
});

test('enabling is refused when Roland cannot delete messages in the channel', async () => {
  const { guild, channel, admin } = await setup();
  let asked;
  channel.permissionsFor = (member) => ({ has: (permissions) => ((asked = { member, permissions }), false) });
  await assert.rejects(run(guild, admin, 'on', channel), new RegExp(`I do not have the Manage Messages permission in <#${channel.id}>`));
  assert.equal(asked.member, guild.members.me);
  assert.equal(row(guild, channel).length, 0);
  assert.equal((await post(guild, channel, author(guild))).deletes, 0);
});

test('channels that are not in the server are rejected', async () => {
  const { guild, admin } = await setup();
  const elsewhere = await makeGuild().channels.create({ name: 'elsewhere' });
  await assert.rejects(run(guild, admin, 'on', elsewhere), /Invalid channel/);
  const forged = await guild.channels.create({ name: 'forged' });
  forged.guild = makeGuild();
  await assert.rejects(run(guild, admin, 'on', forged), /Invalid channel/);
});

test('/nomessages uses the central permission levels', async () => {
  assert.equal(nomessages.level, Level.ADMINISTRATOR);
  const { guild, channel } = await setup();
  for (const role of [null, ROLES.SUPPORT, ROLES.MODERATOR, ROLES.SENIOR_MODERATOR]) {
    assert.match(await route(guild, makeMember(role), 'on', channel), /do not have permission/);
  }
  assert.equal(row(guild, channel).length, 0);
  assert.match(await route(guild, makeMember(ROLES.ADMINISTRATOR), 'on', channel), /now enabled/);
  assert.match(await route(guild, makeMember(ROLES.CREATOR), 'off', channel), /now disabled/);
  const json = nomessages.data.toJSON();
  assert.deepEqual(json.options.map((option) => [option.name, option.type, option.required]), [['state', 3, true], ['channel', 7, true]]);
  assert.equal(json.default_member_permissions, undefined);
});

test('AutoMod still processes messages in no-messages channels, which earn no XP', async () => {
  const { guild, channel, admin } = await setup();
  await run(guild, admin, 'on', channel);
  automodSettings.set(guild.id, 'antispam', true, 'admin');
  const member = author(guild);
  const start = tick();
  const sent = [];
  for (let index = 0; index < 10; index++) sent.push(await post(guild, channel, member, { at: start + index * 100 }));

  assert.ok(sent.every((entry) => entry.deleted));
  assert.equal(channel.bulkDeleted.length, 10, 'Anti-Spam still detected the spam and acted on it');
  assert.equal(levelStore.get(guild.id, member.id), undefined);

  const free = await guild.channels.create({ name: 'general' });
  await post(guild, free, author(guild));
  await post(guild, free, member, { at: start + 120_000 });
  assert.equal(levelStore.get(guild.id, member.id).xp, 2, 'XP keeps working in other channels');
});

test('an existing database gains the no_messages table without losing data', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  database.migrations.slice(0, 10).forEach((sql) => db.exec(sql));
  db.pragma('user_version = 10');
  db.prepare("INSERT INTO automod_settings (guild_id, function_id, enabled, updated_by, updated_at) VALUES ('g', 'antispam', 1, 'a', 1)").run();
  db.close();

  database.open(legacy);
  try {
    assert.equal(database.get().pragma('user_version', { simple: true }), database.migrations.length);
    assert.equal(automodSettings.enabledFunctions('g').has('antispam'), true);
    const columns = database.get().prepare('PRAGMA table_info(no_messages)').all().map((column) => column.name);
    assert.deepEqual(columns, ['guild_id', 'channel_id', 'enabled', 'enabled_at', 'updated_by', 'created_at', 'updated_at']);
    database.get().prepare("INSERT INTO no_messages (guild_id, channel_id, enabled, created_at, updated_at) VALUES ('g', 'c', 1, 1, 1)").run();
    assert.throws(() => database.get().prepare("INSERT INTO no_messages (guild_id, channel_id, enabled, created_at, updated_at) VALUES ('g', 'c', 0, 2, 2)").run(), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
  } finally {
    database.open(file);
    noMessages.load();
  }
});
