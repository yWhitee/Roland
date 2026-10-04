const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Collection, MessageType } = require('discord.js');
const database = require('../src/database');
const automodSettings = require('../src/database/automodSettings');
const guildSettings = require('../src/database/guildSettings');
const levelRewards = require('../src/database/levelRewards');
const levelStore = require('../src/database/levels');
const levels = require('../src/services/levels');
const messageCreate = require('../src/events/messageCreate');
const levelCommand = require('../src/commands/level');
const leaderboardCommand = require('../src/commands/leaderboard');
const levelsetCommand = require('../src/commands/levelset');
const levelsystemCommand = require('../src/commands/levelsystem');
const { ROLES } = require('../src/permissions');
const { apiError, makeGuild, makeMember, snowflake, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const MINUTE = 60_000;

test.before(() => database.open(file));
test.after(() => database.close());

const setup = () => {
  const guild = makeGuild({ roles: Object.values(ROLES) });
  guildSettings.enableLogs(guild.id, guild.logChannel.id);
  return guild;
};

const addRole = (guild, options = {}) => {
  const role = { id: snowflake(), editable: true, managed: false, ...options };
  guild.roles.cache.set(role.id, role);
  return role;
};

const join = (guild, role = null) => {
  const member = makeMember(role);
  member.adds = [];
  const add = member.roles.add;
  member.roles.add = async (roleId) => {
    member.adds.push(roleId);
    return add(roleId);
  };
  guild.members.cache.set(member.id, member);
  return member;
};

const message = (guild, channel, member, { at = T0, type = MessageType.Default, bot = false, content = 'hello there' } = {}) => ({
  id: snowflake(),
  guild,
  guildId: guild.id,
  channel,
  channelId: channel.id,
  member,
  author: { ...member.user, bot },
  type,
  content,
  createdTimestamp: at,
  webhookId: null,
  system: false,
  inGuild: () => true,
  mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
});

const chat = (guild, channel, member, options) => levels.handleMessage(message(guild, channel, member, options));
const xpOf = (guild, member) => levelStore.get(guild.id, member.id)?.xp ?? 0;

const reply = async (command, interaction) => {
  const replies = [];
  await command.execute({
    deferReply: async () => {},
    editReply: async (payload) => replies.push(payload.embeds[0].toJSON()),
    ...interaction,
  });
  return replies[0];
};

const fields = (embed) => Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));

test('level = floor(xp / 100) with 0-99 XP as level 0 and no level cap', () => {
  const cases = [[0, 0], [2, 0], [99, 0], [100, 1], [199, 1], [200, 2], [999, 9], [1000, 10], [123_456, 1234]];
  for (const [xp, level] of cases) assert.equal(levels.levelFor(xp), level, `${xp} XP`);
  assert.equal(levels.xpFor(1), 100);
  assert.equal(levels.xpFor(10), 1000);
  assert.equal(levels.levelFor(levels.xpFor(5_000_000)), 5_000_000);
});

test('each normal message gives 2 XP', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const member = join(guild);

  const first = await chat(guild, channel, member, { at: T0 });
  assert.deepEqual([first.gained, first.xp, first.level], [2, 2, 0]);
  for (let index = 1; index < 10; index++) await chat(guild, channel, member, { at: T0 + index * 1000 });
  assert.equal(xpOf(guild, member), 20);
  assert.equal(levelStore.get(guild.id, member.id).messages, 10);
});

test('bots, webhooks, system and non-chat messages never give XP', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const member = join(guild);

  assert.equal(await chat(guild, channel, member, { bot: true }), null);
  const webhook = message(guild, channel, member);
  webhook.webhookId = '1';
  assert.equal(await levels.handleMessage(webhook), null);
  const system = message(guild, channel, member);
  system.system = true;
  assert.equal(await levels.handleMessage(system), null);
  assert.equal(await chat(guild, channel, member, { type: MessageType.UserJoin }), null);
  assert.equal(xpOf(guild, member), 0);

  assert.equal((await chat(guild, channel, member, { type: MessageType.Reply })).gained, 2, 'replies are normal messages');
  assert.equal((await chat(guild, channel, member, { content: '' })).gained, 2, 'attachment-only messages count');
});

test('a message gives XP once: duplicates, edits and simultaneous messages are safe', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const member = join(guild);

  const once = message(guild, channel, member);
  await levels.handleMessage(once);
  assert.equal(await levels.handleMessage(once), null, 'the same message is not counted twice');
  assert.equal(xpOf(guild, member), 2);

  const events = fs.readdirSync(path.join(__dirname, '..', 'src', 'events'));
  assert.ok(!events.includes('messageUpdate.js') && !events.includes('messageDelete.js'), 'edits and deletions are not handled by the XP system');

  const other = join(guild);
  await Promise.all(Array.from({ length: 50 }, (_, index) => chat(guild, channel, other, { at: T0 + index })));
  assert.equal(xpOf(guild, other), 100);
  assert.equal(levelStore.get(guild.id, other.id).messages, 50);
});

test('deleted messages keep their XP, and the message AutoMod acts on earns none', async () => {
  const guild = setup();
  automodSettings.set(guild.id, 'antispam', true, 'admin');
  const channel = await guild.channels.create({ name: 'general' });
  const member = join(guild);

  for (let index = 0; index < 10; index++) await messageCreate.execute(message(guild, channel, member, { at: T0 + index * 100 }));
  assert.equal(channel.bulkDeleted.length, 10, 'AutoMod deleted the spam');
  assert.equal(xpOf(guild, member), 18, '9 normal messages earned XP; the violating 10th did not');

  await messageCreate.execute(message(guild, channel, member, { at: T0 + 60_000 }));
  assert.equal(xpOf(guild, member), 20, 'XP is never removed');
});

test('100 messages in a rolling 60 minutes doubles XP and notifies only on crossing', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const member = join(guild);
  const send = (at) => chat(guild, channel, member, { at });

  for (let index = 0; index < 99; index++) assert.equal((await send(T0 + index * 30_000)).gained, 2);
  assert.equal(xpOf(guild, member), 198);
  assert.equal(member.state.dms.length, 0);

  const crossing = await send(T0 + 99 * 30_000);
  assert.deepEqual([crossing.gained, crossing.boosted, crossing.notified], [4, true, true], 'the 100th message gets 4 XP');
  assert.equal(member.state.dms.length, 1);
  const notice = member.state.dms[0].payload.embeds[0].toJSON();
  assert.match(notice.description, /100 messages in the last 60 minutes/);
  assert.match(notice.description, /4 XP per message/);
  assert.match(notice.description, /Keep up the pace/);
  assert.equal(channel.sent.length, 0, 'nothing is posted publicly');

  const above = await send(T0 + 50 * MINUTE);
  assert.deepEqual([above.gained, above.notified], [4, false], 'no repeated notification while above 100');
  assert.equal(levels.profile(guild.id, member.id, T0 + 50 * MINUTE).boosted, true);

  const dropped = await send(T0 + 70 * MINUTE);
  assert.deepEqual([dropped.gained, dropped.boosted, dropped.notified], [2, false, false], 'older messages left the window');
  assert.equal(xpOf(guild, member), 208, 'no XP is removed when the multiplier ends');
  assert.equal(member.state.dms.length, 1, 'no message when the multiplier ends');

  const gains = [];
  for (let index = 1; index <= 20; index++) gains.push((await send(T0 + 70 * MINUTE + index * 1000)).gained);
  assert.deepEqual(gains, [...Array(18).fill(2), 4, 4], 'the multiplier returns at 100 messages');
  assert.equal(member.state.dms.length, 2, 'crossing 100 again notifies again');
  assert.equal(xpOf(guild, member), 208 + 18 * 2 + 4 + 4);
});

test('reaching a configured level grants its role once', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const role = addRole(guild);
  levelRewards.set(guild.id, 1, role.id, 'owner');
  const member = join(guild);
  levelStore.setXp(guild.id, member.id, 98);

  const levelUp = await chat(guild, channel, member);
  assert.deepEqual([levelUp.previousLevel, levelUp.level], [0, 1]);
  assert.deepEqual(member.adds, [role.id]);

  await chat(guild, channel, member, { at: T0 + 1 });
  assert.deepEqual(member.adds, [role.id], 'no level change, no role call');

  const holder = join(guild, role.id);
  levelStore.setXp(guild.id, holder.id, 98);
  await chat(guild, channel, holder);
  assert.deepEqual(holder.adds, [], 'members who already have the role are left alone');
});

test('a role that cannot be assigned is logged and levels keep working', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const role = addRole(guild);
  levelRewards.set(guild.id, 1, role.id, 'owner');
  const member = join(guild);
  member.roles.add = async () => Promise.reject(apiError(50013, 403));
  levelStore.setXp(guild.id, member.id, 98);

  const result = await chat(guild, channel, member);
  assert.equal(result.level, 1);
  assert.equal(result.rewards.failed.length, 1);
  assert.equal(xpOf(guild, member), 100);
  const log = guild.logChannel.sent.at(-1).embeds[0].toJSON();
  assert.equal(log.title, 'Levels • Role reward failed');
  assert.match(log.fields[1].value, /cannot manage this role/);
});

test('/levelsystem configures one role per level with validation', async () => {
  const guild = setup();
  const owner = join(guild, ROLES.CREATOR);
  const novice = addRole(guild);
  const veteran = addRole(guild);
  const run = (role, level) =>
    reply(levelsystemCommand, {
      guild,
      user: owner.user,
      options: { getRole: () => role, getInteger: () => level },
    });

  assert.match((await run(novice, 5)).description, new RegExp(`level 5\\*\\* will receive <@&${novice.id}>`));
  assert.equal(levelRewards.get(guild.id, 5).role_id, novice.id);

  assert.match((await run(veteran, 5)).description, new RegExp(`replaces the previous reward for that level \\(<@&${novice.id}>\\)`));
  assert.equal(levelRewards.get(guild.id, 5).role_id, veteran.id, 'one role per level');

  assert.match((await run(veteran, 50)).description, /is also the reward for level 5/);
  assert.equal(levelRewards.get(guild.id, 1_000_000), undefined);
  await run(novice, 1_000_000);
  assert.equal(levelRewards.get(guild.id, 1_000_000).role_id, novice.id, 'no level limit');

  await assert.rejects(run(addRole(guild, { id: guild.id }), 1), /@everyone/);
  await assert.rejects(run(addRole(guild, { managed: true }), 1), /managed by an integration/);
  await assert.rejects(run(addRole(guild, { editable: false }), 1), /Roland cannot manage this role/);
  assert.throws(() => levels.setReward(guild, novice, 0, owner.id), /1 or more/);
  assert.throws(() => levels.setReward(guild, novice, 2.5, owner.id), /whole number/);
});

test('/levelset sets the exact start XP and grants every reward up to that level', async () => {
  const guild = setup();
  const otherGuild = setup();
  const admin = join(guild, ROLES.ADMINISTRATOR);
  const rewards = [5, 10, 20].map((level) => {
    const role = addRole(guild);
    levelRewards.set(guild.id, level, role.id, 'owner');
    return role;
  });
  const member = join(guild);
  levelStore.setXp(otherGuild.id, member.id, 555);

  const run = (target, level) =>
    reply(levelsetCommand, {
      guild,
      user: admin.user,
      options: { getMember: () => target, getInteger: () => level },
    });

  const ten = await run(member, 10);
  assert.match(ten.description, /is now \*\*level 10\*\* with \*\*1,000 XP\*\*/);
  assert.equal(xpOf(guild, member), 1000);
  assert.deepEqual(member.adds, [rewards[0].id, rewards[1].id]);

  await run(member, 20);
  assert.equal(xpOf(guild, member), 2000);
  assert.deepEqual(member.adds, rewards.map((role) => role.id), 'all rewards up to level 20, each once');

  await run(member, 3);
  assert.equal(xpOf(guild, member), 300);
  assert.ok(rewards.every((role) => member.roles.cache.has(role.id)), 'rewards are never removed');
  assert.equal(levelStore.get(otherGuild.id, member.id).xp, 555, 'other servers are untouched');

  const log = guild.logChannel.sent.at(-1).embeds[0].toJSON();
  assert.equal(log.title, 'Levels • Level set');
  assert.equal(fields(log).Level, '20 → 3');

  await run(member, 5_000_000);
  assert.equal(levels.profile(guild.id, member.id).level, 5_000_000);

  await assert.rejects(run(null, 10), /not a member of this server/);
  const bot = join(guild);
  bot.user.bot = true;
  await assert.rejects(run(bot, 10), /Bots cannot have levels/);
  await assert.rejects(levels.setLevel(guild, member, 0), /1 or more/);
});

test('/level shows level, XP, next level and progress, including at 0 XP', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const fresh = join(guild);
  const view = (member) => reply(levelCommand, { guild, guildId: guild.id, member, user: member.user });

  const zero = fields(await view(fresh));
  assert.deepEqual([zero.User, zero.Level, zero.XP], [`<@${fresh.id}>`, '0', '0']);
  assert.equal(zero['Next level'], 'Level 1 at 100 XP (100 XP to go)');
  assert.equal(zero.Progress, '░░░░░░░░░░ 0%\n0 / 100 XP');

  const active = join(guild);
  levelStore.setXp(guild.id, active.id, 250);
  const halfway = fields(await view(active));
  assert.deepEqual([halfway.Level, halfway.XP], ['2', '250']);
  assert.equal(halfway['Next level'], 'Level 3 at 300 XP (50 XP to go)');
  assert.equal(halfway.Progress, '█████░░░░░ 50%\n50 / 100 XP');

  const now = Date.now();
  for (let index = 0; index < 100; index++) await chat(guild, channel, active, { at: now - index * 1000 });
  assert.match(fields(await view(active)).Activity, /2x XP active/);
});

test('/level grants rewards configured after the member reached the level', async () => {
  const guild = setup();
  const member = join(guild);
  levelStore.setXp(guild.id, member.id, 700);
  const role = addRole(guild);
  levelRewards.set(guild.id, 5, role.id, 'owner');

  await reply(levelCommand, { guild, guildId: guild.id, member, user: member.user });
  assert.deepEqual(member.adds, [role.id]);
});

test('/leaderboard shows the top 10 by XP with deterministic ties and no bots', async () => {
  const guild = setup();
  const ids = ['300000000000000000', '100000000000000000', '200000000000000000', '99999999999999999'];
  for (const id of ids) levelStore.setXp(guild.id, id, 500);
  for (let index = 0; index < 8; index++) levelStore.setXp(guild.id, `40000000000000000${index}`, 100 + index * 10);
  levelStore.setXp(guild.id, '500000000000000000', 99_999);
  guild.client.users.cache.set('500000000000000000', { id: '500000000000000000', bot: true });
  levelStore.setXp(guild.id, '600000000000000000', 0);

  const board = await reply(leaderboardCommand, { guild });
  const lines = board.description.split('\n');
  assert.equal(lines.length, 10);
  assert.ok(!board.description.includes('500000000000000000'), 'bots are excluded');
  assert.ok(!board.description.includes('600000000000000000'), 'users without XP are excluded');
  assert.deepEqual(
    lines.slice(0, 4).map((line) => line.match(/<@(\d+)>/)[1]),
    ['99999999999999999', '100000000000000000', '200000000000000000', '300000000000000000'],
    'ties are ordered by user ID',
  );
  assert.equal(lines[0], '**1.** <@99999999999999999> — Level 5 • 500 XP');
  assert.equal(lines[4], '**5.** <@400000000000000007> — Level 1 • 170 XP');

  const small = setup();
  levelStore.setXp(small.id, '700000000000000000', 1234);
  levelStore.setXp(small.id, '800000000000000000', 50);
  const few = (await reply(leaderboardCommand, { guild: small })).description.split('\n');
  assert.deepEqual(few, ['**1.** <@700000000000000000> — Level 12 • 1,234 XP', '**2.** <@800000000000000000> — Level 0 • 50 XP']);

  assert.equal((await reply(leaderboardCommand, { guild: setup() })).description, 'Nobody has earned XP yet.');
});

test('XP and level rewards survive a restart', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const member = join(guild);
  const role = addRole(guild);
  for (let index = 0; index < 5; index++) await chat(guild, channel, member, { at: T0 + index });
  levelRewards.set(guild.id, 3, role.id, 'owner');

  database.close();
  database.open(file);

  assert.equal(xpOf(guild, member), 10);
  assert.equal(levelRewards.get(guild.id, 3).role_id, role.id);
  await chat(guild, channel, member, { at: T0 + 10 });
  assert.equal(xpOf(guild, member), 12);
});
