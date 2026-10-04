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
const { MEMBER_ROLE } = require('../src/services/verification');
const { apiError, makeGuild, makeMember, snowflake, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const MINUTE = 60_000;

test.before(() => database.open(file));
test.after(() => database.close());

const setup = () => {
  const guild = makeGuild({ roles: [...Object.values(ROLES), MEMBER_ROLE] });
  guildSettings.enableLogs(guild.id, guild.logChannel.id);
  return guild;
};

const addRole = (guild, options = {}) => {
  const role = { id: snowflake(), editable: true, managed: false, ...options };
  guild.roles.cache.set(role.id, role);
  return role;
};

const join = (guild, ...roles) => {
  const member = makeMember(roles[0] ?? null);
  for (const role of roles.slice(1)) member.roles.cache.set(role, {});
  member.changes = [];
  const { add, remove } = member.roles;
  member.roles.add = async (roleId) => {
    member.changes.push(`+${roleId}`);
    return add(roleId);
  };
  member.roles.remove = async (roleId) => {
    member.changes.push(`-${roleId}`);
    return remove(roleId);
  };
  guild.members.cache.set(member.id, member);
  return member;
};

const rewardRoles = (guild) => {
  const roles = {};
  for (const [name, level] of [['novato', 5], ['veterano', 10], ['elite', 20]]) {
    roles[name] = addRole(guild);
    levelRewards.set(guild.id, level, roles[name].id, 'owner');
  }
  return roles;
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
const rewardsOf = (member, roles) => Object.entries(roles).filter(([, role]) => member.roles.cache.has(role.id)).map(([name]) => name);

const reply = async (command, interaction) => {
  const replies = [];
  await command.execute({
    deferReply: async () => {},
    editReply: async (payload) => replies.push(payload.embeds[0].toJSON()),
    ...interaction,
  });
  return replies[0];
};

const levelset = (guild, actor, target, level) =>
  reply(levelsetCommand, { guild, user: actor.user, options: { getMember: () => target, getInteger: () => level } });

const levelsystem = (guild, actor, role, level) =>
  reply(levelsystemCommand, { guild, user: actor.user, options: { getRole: () => role, getInteger: () => level } });

const fields = (embed) => Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));

test('level = min(200, floor(xp / 100) + 1): level 1 starts at 0 XP', () => {
  const cases = [[0, 1], [2, 1], [99, 1], [100, 2], [199, 2], [200, 3], [900, 10], [1000, 11], [19_899, 199], [19_900, 200], [19_999, 200], [1_000_000, 200]];
  for (const [xp, level] of cases) assert.equal(levels.levelFor(xp), level, `${xp} XP`);
  assert.deepEqual([1, 2, 10, 50, 200].map(levels.xpFor), [0, 100, 900, 4900, 19_900]);
  assert.equal(levels.MAX_LEVEL, 200);
  assert.equal(levels.MAX_XP, 19_999);
});

test('each normal message gives 2 XP', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const member = join(guild);

  const first = await chat(guild, channel, member, { at: T0 });
  assert.deepEqual([first.gained, first.xp, first.level], [2, 2, 1]);
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
  assert.deepEqual([above.gained, above.boosted, above.notified], [4, true, false], 'no repeated notification while above 100');

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

test('level 200 is the maximum: XP stops growing and never exceeds 19999', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const roles = rewardRoles(guild);
  const top = addRole(guild);
  levelRewards.set(guild.id, 200, top.id, 'owner');
  const member = join(guild);
  await levels.setLevel(guild, member, 199);
  levelStore.setXp(guild.id, member.id, 19_898);

  const reached = await chat(guild, channel, member, { at: T0 });
  assert.deepEqual([reached.previousLevel, reached.level, reached.xp], [199, 200, 19_900]);
  assert.ok(member.roles.cache.has(top.id), 'the level 200 reward is granted');
  assert.deepEqual(rewardsOf(member, roles), [], 'the previous reward is removed');

  const after = await chat(guild, channel, member, { at: T0 + 1000 });
  assert.deepEqual([after.gained, after.xp, after.level], [0, 19_900, 200], 'messages after level 200 add no XP');

  for (let index = 0; index < 120; index++) await chat(guild, channel, member, { at: T0 + 2000 + index });
  assert.equal(xpOf(guild, member), 19_900, 'not even with the 2x multiplier');
  assert.equal(member.state.dms.length, 0, 'no 2x notice when no XP can be earned');

  const boosted = join(guild);
  levelStore.setXp(guild.id, boosted.id, 19_898);
  for (let index = 0; index < 99; index++) await chat(guild, channel, join(guild), { at: T0 + index });
  levelStore.setXp(guild.id, boosted.id, 19_899);
  assert.equal(levels.levelFor(xpOf(guild, boosted)), 199);
  assert.equal((await chat(guild, channel, boosted, { at: T0 + 5000 })).xp, 19_901, 'the message reaching level 200 still counts');

  assert.equal(levelStore.addXp(guild.id, join(guild).id, 50_000).xp, 19_999, 'XP is clamped to 19999');
  assert.equal(levelStore.setXp(guild.id, join(guild).id, 25_000).xp, 19_999);
  assert.equal(levels.levelFor(19_999), 200);
});

test('/levelset uses (level - 1) x 100 XP and accepts levels 1 to 200 only', async () => {
  const guild = setup();
  const otherGuild = setup();
  const admin = join(guild, ROLES.ADMINISTRATOR);
  const member = join(guild);
  levelStore.setXp(otherGuild.id, member.id, 555);

  for (const [level, xp] of [[1, 0], [2, 100], [10, 900], [50, 4900], [200, 19_900]]) {
    const result = await levelset(guild, admin, member, level);
    assert.equal(xpOf(guild, member), xp, `level ${level}`);
    assert.equal(levels.profile(guild.id, member.id).level, level);
    assert.match(result.description, new RegExp(`level ${level}\\*\\* with \\*\\*${xp} XP`));
  }
  assert.equal(levelStore.get(otherGuild.id, member.id).xp, 555, 'other servers are untouched');

  await assert.rejects(levelset(guild, admin, member, 0), /from 1 to 200/);
  await assert.rejects(levelset(guild, admin, member, 201), /from 1 to 200/);
  await assert.rejects(levelset(guild, admin, member, 2.5), /whole number/);
  await assert.rejects(levelset(guild, admin, null, 10), /not a member of this server/);
  const bot = join(guild);
  bot.user.bot = true;
  await assert.rejects(levelset(guild, admin, bot, 10), /Bots cannot have levels/);

  const log = guild.logChannel.sent.at(-1).embeds[0].toJSON();
  assert.equal(log.title, 'Levels • Level set');
  assert.equal(fields(log).Level, '50 → 200');
});

test('level rewards: only the reward of the highest reached level is kept', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const roles = rewardRoles(guild);
  const member = join(guild, MEMBER_ROLE, ROLES.SUPPORT);
  const unrelated = addRole(guild);
  member.roles.cache.set(unrelated.id, {});

  levelStore.setXp(guild.id, member.id, 398);
  assert.equal((await chat(guild, channel, member, { at: T0 })).level, 5);
  assert.deepEqual(rewardsOf(member, roles), ['novato']);

  levelStore.setXp(guild.id, member.id, 898);
  assert.equal((await chat(guild, channel, member, { at: T0 + 1 })).level, 10);
  assert.deepEqual(rewardsOf(member, roles), ['veterano'], 'level 10 swaps Novato for Veterano');

  levelStore.setXp(guild.id, member.id, 1398);
  await chat(guild, channel, member, { at: T0 + 2 });
  assert.deepEqual(rewardsOf(member, roles), ['veterano'], 'a level without a reward keeps the last valid reward');

  levelStore.setXp(guild.id, member.id, 1898);
  assert.equal((await chat(guild, channel, member, { at: T0 + 3 })).level, 20);
  assert.deepEqual(rewardsOf(member, roles), ['elite'], 'level 20 swaps Veterano for Elite');

  for (const role of [MEMBER_ROLE, ROLES.SUPPORT, unrelated.id]) assert.ok(member.roles.cache.has(role), `${role} is never removed`);

  const changes = member.changes.length;
  await chat(guild, channel, member, { at: T0 + 4 });
  assert.equal(member.changes.length, changes, 'no role changes without a level change');
});

test('/levelset applies the same single-reward rule', async () => {
  const guild = setup();
  const roles = rewardRoles(guild);
  const admin = join(guild, ROLES.ADMINISTRATOR);
  const member = join(guild, ROLES.MODERATOR);

  await levelset(guild, admin, member, 5);
  assert.deepEqual(rewardsOf(member, roles), ['novato']);

  const jump = await levelset(guild, admin, member, 20);
  assert.deepEqual(rewardsOf(member, roles), ['elite']);
  assert.match(jump.description, new RegExp(`Level reward added: <@&${roles.elite.id}>`));
  assert.match(jump.description, new RegExp(`Previous level reward removed: <@&${roles.novato.id}>`));

  await levelset(guild, admin, member, 15);
  assert.deepEqual(rewardsOf(member, roles), ['veterano'], 'level 15 keeps the reward of level 10');

  await levelset(guild, admin, member, 3);
  assert.deepEqual(rewardsOf(member, roles), [], 'below every reward level no reward remains');
  assert.ok(member.roles.cache.has(ROLES.MODERATOR), 'staff roles are untouched');

  member.roles.cache.set(roles.novato.id, {});
  member.roles.cache.set(roles.elite.id, {});
  await levelset(guild, admin, member, 12);
  assert.deepEqual(rewardsOf(member, roles), ['veterano'], 'extra reward roles are cleaned up');
});

test('/levelsystem validates the reward and applies it retroactively', async () => {
  const guild = setup();
  const owner = join(guild, ROLES.CREATOR);
  const novato = addRole(guild);
  const veterano = addRole(guild);
  const elite = addRole(guild);

  const low = join(guild);
  const mid = join(guild);
  const high = join(guild, ROLES.SENIOR_MODERATOR);
  levelStore.setXp(guild.id, low.id, 100);
  levelStore.setXp(guild.id, mid.id, 1400);
  levelStore.setXp(guild.id, high.id, 2500);
  const roles = { novato, veterano, elite };

  const first = await levelsystem(guild, owner, novato, 5);
  assert.match(first.description, /Updated 2 member\(s\) already at level 5 or above/);
  assert.deepEqual([rewardsOf(low, roles), rewardsOf(mid, roles), rewardsOf(high, roles)], [[], ['novato'], ['novato']]);

  await levelsystem(guild, owner, veterano, 10);
  assert.deepEqual([rewardsOf(mid, roles), rewardsOf(high, roles)], [['veterano'], ['veterano']], 'level 15 and 26 keep only Veterano');

  await levelsystem(guild, owner, elite, 20);
  assert.deepEqual([rewardsOf(mid, roles), rewardsOf(high, roles)], [['veterano'], ['elite']]);
  assert.ok(high.roles.cache.has(ROLES.SENIOR_MODERATOR));
  assert.equal(levelRewards.get(guild.id, 20).role_id, elite.id);

  const replaced = addRole(guild);
  assert.match((await levelsystem(guild, owner, replaced, 20)).description, new RegExp(`replaces the previous reward for that level \\(<@&${elite.id}>\\)`));
  assert.deepEqual(rewardsOf(high, { ...roles, replaced }), ['replaced'], 'a replaced reward is swapped for the new one');
  assert.ok(!high.roles.cache.has(elite.id), 'the replaced reward role is removed');

  await levelsystem(guild, owner, addRole(guild), 200);
  await assert.rejects(levelsystem(guild, owner, novato, 0), /from 1 to 200/);
  await assert.rejects(levelsystem(guild, owner, novato, 201), /from 1 to 200/);
  await assert.rejects(levelsystem(guild, owner, addRole(guild, { id: guild.id }), 1), /@everyone/);
  for (const protectedRole of [ROLES.SUPPORT, ROLES.ADMINISTRATOR, MEMBER_ROLE]) {
    await assert.rejects(levelsystem(guild, owner, addRole(guild, { id: protectedRole }), 3), /Staff roles and the Member role/);
  }
  await assert.rejects(levelsystem(guild, owner, addRole(guild, { managed: true }), 1), /managed by an integration/);
  await assert.rejects(levelsystem(guild, owner, addRole(guild, { editable: false }), 1), /Roland cannot manage this role/);
});

test('a role that cannot be changed is logged and levels keep working', async () => {
  const guild = setup();
  const channel = await guild.channels.create({ name: 'general' });
  const role = addRole(guild);
  levelRewards.set(guild.id, 2, role.id, 'owner');
  const member = join(guild);
  member.roles.add = async () => Promise.reject(apiError(50013, 403));
  levelStore.setXp(guild.id, member.id, 98);

  const result = await chat(guild, channel, member);
  assert.equal(result.level, 2);
  assert.equal(result.rewards.failed.length, 1);
  assert.equal(xpOf(guild, member), 100);
  const log = guild.logChannel.sent.at(-1).embeds[0].toJSON();
  assert.equal(log.title, 'Levels • Role reward failed');
  assert.match(log.fields[1].value, /cannot manage this role/);
});

test('/level shows only the user, level and XP', async () => {
  const guild = setup();
  const view = (member) => reply(levelCommand, { guild, guildId: guild.id, member, user: member.user });

  const fresh = join(guild);
  const zero = await view(fresh);
  assert.deepEqual(zero.fields.map((field) => field.name), ['User', 'Level', 'XP']);
  assert.deepEqual(Object.values(fields(zero)), [`<@${fresh.id}>`, '1', '0']);
  assert.equal(zero.thumbnail, undefined);

  const active = join(guild);
  levelStore.setXp(guild.id, active.id, 1137);
  assert.deepEqual(Object.values(fields(await view(active))), [`<@${active.id}>`, '12', '1137']);
});

test('/leaderboard shows only the top 10 current members by XP', async () => {
  const guild = setup();
  const add = (id, xp, { bot = false, member = true } = {}) => {
    levelStore.setXp(guild.id, id, xp);
    if (member) guild.members.cache.set(id, { id, user: { id, bot } });
  };

  for (const id of ['300000000000000000', '100000000000000000', '200000000000000000', '99999999999999999']) add(id, 500);
  for (let index = 0; index < 8; index++) add(`40000000000000000${index}`, 100 + index * 10);
  add('500000000000000000', 19_999, { bot: true });
  add('510000000000000000', 19_000, { member: false });
  add('600000000000000000', 0);

  const board = await reply(leaderboardCommand, { guild });
  const lines = board.description.split('\n');
  assert.equal(lines.length, 10);
  assert.ok(!board.description.includes('500000000000000000'), 'bots are excluded');
  assert.ok(!board.description.includes('510000000000000000'), 'members who left are excluded');
  assert.ok(!board.description.includes('600000000000000000'), 'users with 0 XP are excluded');
  assert.deepEqual(
    lines.slice(0, 4).map((line) => line.match(/<@(\d+)>/)[1]),
    ['99999999999999999', '100000000000000000', '200000000000000000', '300000000000000000'],
    'ties are ordered by user ID',
  );
  assert.equal(lines[0], '#1 <@99999999999999999> — Level 6 — 500 XP');
  assert.equal(lines[4], '#5 <@400000000000000007> — Level 2 — 170 XP');
  assert.equal(lines[9], '#10 <@400000000000000002> — Level 2 — 120 XP');

  const small = setup();
  for (const [id, xp] of [['700000000000000000', 19_900], ['710000000000000000', 1234], ['720000000000000000', 50]]) {
    levelStore.setXp(small.id, id, xp);
    small.members.cache.set(id, { id, user: { id, bot: false } });
  }
  const few = (await reply(leaderboardCommand, { guild: small })).description.split('\n');
  assert.deepEqual(few, [
    '#1 <@700000000000000000> — Level 200 — 19900 XP',
    '#2 <@710000000000000000> — Level 13 — 1234 XP',
    '#3 <@720000000000000000> — Level 1 — 50 XP',
  ]);

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
  assert.equal(levels.profile(guild.id, member.id).level, 1);
});
