const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, GatewayIntentBits, OverwriteType, PermissionFlagsBits } = require('discord.js');
const database = require('../src/database');
const automodFlags = require('../src/database/automodFlags');
const automodRaids = require('../src/database/automodRaids');
const automodSettings = require('../src/database/automodSettings');
const automodWhitelist = require('../src/database/automodWhitelist');
const guildSettings = require('../src/database/guildSettings');
const punishments = require('../src/database/punishments');
const automod = require('../src/services/automod');
const { countEmojis, mentionedUsers } = require('../src/services/automod/detectors');
const { FUNCTIONS, byId } = require('../src/services/automod/functions');
const { findInvites, clearCache } = require('../src/services/automod/invites');
const moderation = require('../src/services/moderation');
const automodCommand = require('../src/commands/automod');
const automodlist = require('../src/commands/automodlist');
const automodwhitelist = require('../src/commands/automodwhitelist');
const modlog = require('../src/commands/modlog');
const { resolveIntents } = require('../src/intents');
const { ROLES } = require('../src/permissions');
const { BOT_ID, apiError, makeGuild, makeMember, snowflake, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
const HOUR = 3_600_000;
const STAFF = [ROLES.CREATOR, ROLES.ADMINISTRATOR, ROLES.SENIOR_MODERATOR, ROLES.MODERATOR, ROLES.SUPPORT];
const MEMBER_ROLE = '1555596685462479048';
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

test.before(() => database.open(file));
test.after(() => database.close());

const restart = () => {
  database.close();
  database.open(file);
};

const setup = ({ enable = [], logs = true } = {}) => {
  const guild = makeGuild({ roles: [...STAFF, MEMBER_ROLE] });
  if (logs) guildSettings.enableLogs(guild.id, guild.logChannel.id);
  for (const id of enable) automodSettings.set(guild.id, id, true, 'admin');
  return { guild };
};

const channelOf = (guild, name = 'general') => guild.channels.create({ name });

const user = (guild, role = null, options = {}) => {
  const member = makeMember(role, options);
  guild.members.cache.set(member.id, member);
  return member;
};

const message = (guild, channel, member, { content = 'hello there', at = T0, users = [], repliedUser = null, bot = false } = {}) => ({
  id: snowflake(),
  guild,
  guildId: guild.id,
  channel,
  channelId: channel.id,
  member,
  author: { ...member.user, bot },
  content,
  createdTimestamp: at,
  webhookId: null,
  system: false,
  inGuild: () => true,
  mentions: { users: new Collection(users.map((id) => [id, { id }])), roles: new Collection(), repliedUser },
});

const send = (guild, channel, member, options) => automod.handleMessage(message(guild, channel, member, options));

const burst = async (guild, channel, member, { count, start, step }) => {
  const outcomes = [];
  for (let index = 0; index < count; index++) {
    const outcome = await send(guild, channel, member, { content: `message number ${index} ${start}`, at: start + index * step });
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
};

const emojiSpam = '😀'.repeat(10);
const dm = (member) => member.state.dms.at(-1)?.payload.embeds[0].toJSON();
const logs = (guild) => guild.logChannel.sent.map((sent) => sent.embeds?.[0]?.toJSON?.() ?? sent);
const fields = (embed) => Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));

test('Function IDs, names and actions are defined in one registry', () => {
  assert.deepEqual(FUNCTIONS.map((fn) => fn.id), ['antiflood', 'antispam', 'antimassping', 'antiinvite', 'antiduplicate', 'antiemojispam', 'antiraid']);
  for (const fn of FUNCTIONS) {
    assert.ok(fn.name && fn.description && fn.detection && fn.reason, fn.id);
    if (!fn.serverWide) assert.equal(fn.actions.length, 3, fn.id);
  }
  assert.deepEqual(byId.get('antiduplicate').actions[2], byId.get('antiduplicate').actions[1]);
  assert.deepEqual(byId.get('antiinvite').actions[2], byId.get('antiinvite').actions[1]);
});

test('/automod enables and disables functions per guild and the setting persists', async () => {
  const { guild } = setup();
  const other = setup().guild;
  const admin = user(guild, ROLES.ADMINISTRATOR);
  const run = async (fn, state) => {
    const replies = [];
    await automodCommand.execute({
      guild,
      user: admin.user,
      options: { getString: (name) => ({ function: fn, state })[name] },
      deferReply: async () => {},
      editReply: async (payload) => replies.push(payload.embeds[0].data.description),
    });
    return replies[0];
  };

  assert.match(await run('antispam', 'on'), /Anti-Spam\*\* \(`antispam`\) is now \*\*ENABLED/);
  restart();
  assert.ok(automodSettings.enabledFunctions(guild.id).has('antispam'));
  assert.ok(!automodSettings.enabledFunctions(other.id).has('antispam'), 'settings are per guild');

  assert.match(await run('antispam', 'off'), /DISABLED/);
  restart();
  assert.ok(!automodSettings.enabledFunctions(guild.id).has('antispam'));

  automod.configure({ messageContent: false, members: false });
  assert.match(await run('antiinvite', 'on'), /Message Content intent is disabled/);
  assert.match(await run('antiraid', 'on'), /Server Members intent is disabled/);
  assert.doesNotMatch(await run('antispam', 'on'), /intent/);
  automod.configure();
});

test('flags count 1/3, 2/3, 3/3, expire after exactly 4 hours and survive restarts', async () => {
  const { guild } = setup({ enable: ['antiemojispam'] });
  const channel = await channelOf(guild);
  const member = user(guild);

  const levels = [];
  for (const at of [T0, T0 + HOUR, T0 + 2 * HOUR]) levels.push((await send(guild, channel, member, { content: emojiSpam, at })).level);
  assert.deepEqual(levels, [1, 2, 3]);

  restart();
  assert.equal(automodFlags.countActive(guild.id, member.id, 'antiemojispam', T0 + 2 * HOUR), 3);
  assert.equal(automodFlags.countActive(guild.id, member.id, 'antiemojispam', T0 + 4 * HOUR - 1), 3);
  assert.equal(automodFlags.countActive(guild.id, member.id, 'antiemojispam', T0 + 4 * HOUR), 2, 'the first flag expires at exactly 4 hours');
  assert.equal(automodFlags.countActive(guild.id, member.id, 'antiemojispam', T0 + 6 * HOUR), 0);

  assert.equal((await send(guild, channel, member, { content: emojiSpam, at: T0 + 6 * HOUR })).level, 1, 'expired flags do not count');
  assert.equal((await send(guild, channel, member, { content: emojiSpam, at: T0 + 6 * HOUR + 1 })).level, 2);

  const maxed = user(guild);
  for (let index = 0; index < 5; index++) await send(guild, channel, maxed, { content: emojiSpam, at: T0 + index });
  assert.equal(automodFlags.countActive(guild.id, maxed.id, 'antiemojispam', T0 + 5), 5);
  assert.equal((await send(guild, channel, maxed, { content: emojiSpam, at: T0 + 6 })).level, 3, 'more than 3 active flags still means 3/3');

  assert.ok(automodFlags.purgeExpired(T0 + 10 * HOUR) >= 8);
  assert.equal(automodFlags.countActive(guild.id, maxed.id, 'antiemojispam', T0), 0, 'expired records are removed');
});

test('functions have independent flags and normal warnings never change AutoMod flags', async () => {
  const { guild } = setup({ enable: ['antiemojispam', 'antimassping'] });
  const channel = await channelOf(guild);
  const member = user(guild);
  const moderator = user(guild, ROLES.MODERATOR);

  for (let index = 0; index < 3; index++) await moderation.warn({ guild, moderator, target: { user: member.user, member }, reason: 'manual' });
  assert.equal(automodFlags.countActive(guild.id, member.id, 'antiemojispam', T0), 0);

  assert.equal((await send(guild, channel, member, { content: emojiSpam, at: T0 })).level, 1);
  assert.equal((await send(guild, channel, member, { content: emojiSpam, at: T0 + 1 })).level, 2);
  const ping = await send(guild, channel, member, { at: T0 + 2, users: [1, 2, 3, 4, 5].map(() => snowflake()) });
  assert.equal(ping.level, 1, 'Anti-Mass Mention has its own counter');

  const warnings = punishments.listByUser(guild.id, member.id, 20).filter((record) => record.type === 'warn');
  assert.equal(warnings.filter((record) => record.source === 'moderator').length, 3, 'manual warnings unchanged');
  assert.ok(warnings.filter((record) => record.source === 'automod').every((record) => record.moderator_id === BOT_ID));
});

test('Anti-Spam: 5 messages in 5 seconds escalates delete, warn, then a 3 hour mute', async () => {
  const { guild } = setup({ enable: ['antispam'] });
  const channel = await channelOf(guild);
  const member = user(guild);

  assert.deepEqual(await burst(guild, channel, member, { count: 4, start: T0, step: 1000 }), [], '4 messages are fine');
  assert.deepEqual(await burst(guild, channel, user(guild), { count: 5, start: T0, step: 1500 }), [], '5 messages over 6 seconds are fine');

  const [first] = await burst(guild, channel, member, { count: 1, start: T0 + 4500, step: 0 });
  assert.equal(first.level, 1);
  assert.equal(first.deleted, 5);
  assert.equal(first.warning, null);
  assert.equal(channel.bulkDeleted.length, 5);
  assert.equal(dm(member).title, 'Your message was removed by AutoMod');
  assert.match(dm(member).description, /in #general were removed by AutoMod/);
  assert.match(dm(member).description, /\*\*Reason:\*\* Spam/);
  assert.match(dm(member).description, /AutoMod status:\*\* 1\/3/);

  const [second] = await burst(guild, channel, member, { count: 5, start: T0 + 60_000, step: 500 });
  assert.equal(second.level, 2);
  assert.equal(second.warning.source, 'automod');
  assert.equal(second.warning.automod_function, 'antispam');
  assert.equal(second.warning.reason, 'Spam detection');
  assert.equal(dm(member).title, 'You have received an AutoMod warning');
  assert.match(dm(member).description, /Your warning has been recorded in the server moderation log/);

  const [third] = await burst(guild, channel, member, { count: 5, start: T0 + 120_000, step: 500 });
  assert.equal(third.level, 3);
  assert.equal(third.mute.duration, '3h');
  assert.equal(third.mute.source, 'automod');
  assert.ok(Math.abs(member.state.timeoutUntil - (Date.now() + 3 * HOUR)) < 5000, 'native timeout for 3 hours');
  assert.equal(dm(member).title, 'You have been muted by AutoMod');
  assert.match(dm(member).description, /Duration:\*\* 3 hours/);
  assert.match(dm(member).description, /AutoMod status:\*\* 3\/3/);
  assert.ok(!third.action.ban && !third.action.kick);
});

test('Anti-Flood: 8 messages in 2 seconds escalates delete, 30 minute mute, then 6 hour mute', async () => {
  const { guild } = setup({ enable: ['antiflood'] });
  const channel = await channelOf(guild);
  const member = user(guild);

  assert.deepEqual(await burst(guild, channel, member, { count: 7, start: T0, step: 250 }), []);
  const results = [
    ...(await burst(guild, channel, member, { count: 1, start: T0 + 1900, step: 0 })),
    ...(await burst(guild, channel, member, { count: 8, start: T0 + 60_000, step: 200 })),
    ...(await burst(guild, channel, member, { count: 8, start: T0 + 120_000, step: 200 })),
  ];
  assert.deepEqual(results.map((outcome) => outcome.level), [1, 2, 3]);
  assert.equal(results[0].deleted, 8);
  assert.equal(results[0].mute, null);
  assert.equal(results[1].mute.duration, '30m');
  assert.equal(results[2].mute.duration, '6h');
  assert.match(dm(member).description, /Duration:\*\* 6 hours/);
});

test('Anti-Mass Mention counts individual users only', async () => {
  const { guild } = setup({ enable: ['antimassping'] });
  const channel = await channelOf(guild);
  const member = user(guild);
  const ids = (count) => Array.from({ length: count }, () => snowflake());

  assert.equal(await send(guild, channel, member, { users: ids(4) }), null);
  const roleOnly = message(guild, channel, member, { users: ids(4) });
  roleOnly.mentions.roles = new Collection(ids(10).map((id) => [id, { id }]));
  assert.equal(await automod.handleMessage(roleOnly), null, 'role mentions are not user mentions');

  const replied = ids(1)[0];
  assert.equal(mentionedUsers(message(guild, channel, member, { users: [...ids(4), replied], repliedUser: { id: replied } })), 4);
  assert.equal(mentionedUsers(message(guild, channel, member, { users: [...ids(4), replied], repliedUser: { id: replied }, content: `<@${replied}> hi` })), 5);
  assert.equal(mentionedUsers(message(guild, channel, member, { users: [...ids(4), member.id] })), 4, 'self mentions are ignored');

  const first = await send(guild, channel, member, { users: ids(5), at: T0 + 1 });
  assert.deepEqual([first.level, first.deleted, Boolean(first.warning)], [1, 1, true]);
  const second = await send(guild, channel, member, { users: ids(6), at: T0 + 2 });
  assert.equal(second.mute.duration, '3h');
  const third = await send(guild, channel, member, { users: ids(12), at: T0 + 3 });
  assert.equal(third.mute.duration, '24h');
});

test('Anti-Duplicate flags repeated messages but not normal conversation', async () => {
  const { guild } = setup({ enable: ['antiduplicate'] });
  const channel = await channelOf(guild);
  const other = await channelOf(guild, 'other');
  const member = user(guild);

  for (const [index, content] of ['hey everyone', 'how are you?', 'I am fine', 'what are we playing', 'hey everyone'].entries()) {
    assert.equal(await send(guild, channel, member, { content, at: T0 + index * 1000 }), null);
  }
  for (let index = 0; index < 5; index++) assert.equal(await send(guild, channel, user(guild), { content: 'ok', at: T0 + index }), null, 'short replies are ignored');

  const slow = user(guild);
  for (let index = 0; index < 3; index++) assert.equal(await send(guild, channel, slow, { content: 'join my game please', at: T0 + index * 20_000 }), null);

  const spammer = user(guild);
  await send(guild, channel, spammer, { content: 'Buy cheap Robux now', at: T0 });
  await send(guild, other, spammer, { content: 'buy  cheap robux NOW!!!', at: T0 + 5000 });
  const outcome = await send(guild, channel, spammer, { content: 'BUY CHEAP ROBUX NOW', at: T0 + 10_000 });
  assert.equal(outcome.level, 1);
  assert.equal(outcome.deleted, 3, 'all duplicates are deleted, across channels');
  assert.ok(outcome.warning);

  for (let round = 1; round <= 2; round++) {
    let result;
    for (let index = 0; index < 3; index++) result = await send(guild, channel, spammer, { content: 'Buy cheap Robux now', at: T0 + round * 60_000 + index });
    assert.equal(result.mute.duration, '6h', `${round + 1}/3 mutes for 6 hours`);
  }
});

test('Anti-Invite detects invite formats and obfuscation without flagging normal .gg text', () => {
  const strong = [
    'discord.gg/example',
    'discord.com/invite/example',
    '.gg/example',
    '.gg /example',
    'join DISCORD . GG / example',
    'DiScOrD.Gg/example',
    'discord(.)gg/example',
    'discord[dot]gg/example',
    'discord dot gg slash example',
    'discord..gg//example',
    'discord.gg\\example',
    '<https://discord.gg/example>',
    '||discord.gg/example||',
    'ｄｉｓｃｏｒｄ．ｇｇ／example',
    'dis​cord.gg/example',
    'discordapp.com/invite/example',
    'ptb.discord.com/invite/example',
  ];
  for (const text of strong) assert.deepEqual(findInvites(text), [{ code: 'example', strength: 'strong' }], text);

  assert.deepEqual(findInvites('gg/example'), [{ code: 'example', strength: 'weak' }]);
  assert.deepEqual(findInvites('d i s c o r d . g g / example'), [{ code: 'example', strength: 'weak' }]);
  assert.deepEqual(findInvites('d-i-s-c-o-r-d.gg/example'), [{ code: 'example', strength: 'weak' }]);
  assert.deepEqual(findInvites('dsc.gg/example'), [{ code: 'example', strength: 'service' }]);
  assert.deepEqual(findInvites('discord.gg/AbC123')[0].code, 'AbC123', 'invite codes keep their case');

  for (const text of ['gg', 'gg ez', 'good game.gg', 'check op.gg/summoner', 'visit u.gg/build', 'the .gg domain is cool', 'egg/bacon', 'discord is fun']) {
    assert.deepEqual(findInvites(text), [], text);
  }
});

test('Anti-Invite allows this server, blocks other servers and escalates', async () => {
  clearCache();
  const { guild } = setup({ enable: ['antiinvite'] });
  const channel = await channelOf(guild);
  const member = user(guild);
  const servers = { ours: guild.id, raid: 'other-guild', spam: 'spam-guild' };
  guild.client.fetchInvite = async (code) => (servers[code] ? { guild: { id: servers[code] } } : Promise.reject(apiError(10006)));

  assert.equal(await send(guild, channel, member, { content: 'join us at discord.gg/ours', at: T0 }), null, 'own server invites are allowed');
  assert.equal(await send(guild, channel, member, { content: 'gg/ez everyone', at: T0 + 1 }), null, 'gg/ez is not a real invite');
  assert.equal(await send(guild, channel, member, { content: 'good game.gg lol', at: T0 + 2 }), null);

  const first = await send(guild, channel, member, { content: 'come to discord.gg/raid', at: T0 + 3 });
  assert.deepEqual([first.level, first.deleted, Boolean(first.warning)], [1, 1, true]);
  assert.match(first.detail, /raid/);

  const second = await send(guild, channel, member, { content: 'gg/spam', at: T0 + 4 });
  assert.equal(second.mute.duration, '24h', 'a weak form that resolves to another server is blocked');
  const third = await send(guild, channel, member, { content: 'discord.gg/deadinvite', at: T0 + 5 });
  assert.equal(third.level, 3, 'unresolvable explicit invites follow the block policy');
  assert.equal(third.mute.duration, '24h');

  const service = await send(guild, channel, user(guild), { content: 'dsc.gg/anything', at: T0 + 6 });
  assert.equal(service.level, 1);
});

test('Anti-Emoji Spam counts Unicode and custom emojis', async () => {
  assert.equal(countEmojis('😀'.repeat(9)), 9);
  assert.equal(countEmojis('😀'.repeat(10)), 10);
  assert.equal(countEmojis('<:pepe:123456789012345678>'.repeat(5) + '<a:dance:123456789012345678>'.repeat(5)), 10);
  assert.equal(countEmojis('👨‍👩‍👧‍👦🇧🇷1️⃣👍🏽'), 4, 'ZWJ sequences, flags, keycaps and skin tones count once');
  assert.equal(countEmojis('hello 123 #1'), 0);

  const { guild } = setup({ enable: ['antiemojispam'] });
  const channel = await channelOf(guild);
  const member = user(guild);
  assert.equal(await send(guild, channel, member, { content: '😀'.repeat(9) }), null);

  const results = [];
  for (let index = 0; index < 3; index++) results.push(await send(guild, channel, member, { content: emojiSpam, at: T0 + index }));
  assert.deepEqual(results.map((outcome) => [outcome.deleted, Boolean(outcome.warning), outcome.mute?.duration ?? null]), [
    [1, false, null],
    [1, true, null],
    [1, false, '1h'],
  ]);
});

test('whitelists are per function and support users and roles', async () => {
  const { guild } = setup({ enable: ['antiemojispam', 'antimassping'] });
  const channel = await channelOf(guild);
  const member = user(guild);
  const roleMember = user(guild, MEMBER_ROLE);

  automodWhitelist.add({ guildId: guild.id, functionId: 'antiemojispam', targetType: 'user', targetId: member.id, createdBy: 'admin' });
  automodWhitelist.add({ guildId: guild.id, functionId: 'antiemojispam', targetType: 'role', targetId: MEMBER_ROLE, createdBy: 'admin' });

  for (const target of [member, roleMember]) {
    assert.equal(await send(guild, channel, target, { content: emojiSpam }), null);
    assert.equal(automodFlags.countActive(guild.id, target.id, 'antiemojispam', T0), 0, 'no flag');
    assert.equal(target.state.dms.length, 0, 'no DM');
  }
  assert.equal(channel.bulkDeleted.length, 0, 'no deletion');
  assert.equal(punishments.countByUser(guild.id, member.id), 0, 'no warning or mute');

  const ping = await send(guild, channel, member, { users: Array.from({ length: 5 }, () => snowflake()), at: T0 + 1 });
  assert.equal(ping.fn.id, 'antimassping', 'other functions still apply');

  restart();
  assert.ok(automodWhitelist.bypasses(guild.id, member.id).has('antiemojispam'));
  assert.ok(!automodWhitelist.bypasses(guild.id, member.id).has('antimassping'));
});

test('/automodwhitelist adds and removes user and role bypasses', async () => {
  const { guild } = setup();
  const target = user(guild);
  const run = (option, state) => {
    const replies = [];
    return automodwhitelist
      .execute({
        guildId: guild.id,
        user: { id: 'admin' },
        options: { getString: (name) => ({ function: 'antispam', state })[name] ?? null, get: () => option },
        deferReply: async () => {},
        editReply: async (payload) => replies.push(payload.embeds[0].data.description),
      })
      .then(() => replies[0]);
  };

  assert.match(await run({ user: target.user }), new RegExp(`<@${target.id}> now bypasses \\*\\*Anti-Spam`));
  await assert.rejects(run({ user: target.user }), /already whitelisted/);
  assert.match(await run({ role: { id: MEMBER_ROLE } }), new RegExp(`<@&${MEMBER_ROLE}> now bypasses`));
  assert.deepEqual(automodWhitelist.list(guild.id).map((entry) => [entry.target_type, entry.function_id]), [['user', 'antispam'], ['role', 'antispam']]);
  assert.match(await run({ user: target.user }, 'off'), /no longer bypasses/);
  await assert.rejects(run({ user: target.user }, 'off'), /is not whitelisted/);
});

test('staff, bots and webhooks are ignored by AutoMod', async () => {
  const { guild } = setup({ enable: ['antiemojispam'] });
  const channel = await channelOf(guild);
  for (const role of STAFF) assert.equal(await send(guild, channel, user(guild, role), { content: emojiSpam }), null, role);
  assert.equal(await send(guild, channel, user(guild), { content: emojiSpam, bot: true }), null);
  const webhook = message(guild, channel, user(guild), { content: emojiSpam });
  webhook.webhookId = '1';
  assert.equal(await automod.handleMessage(webhook), null);
});

test('failed DMs, deletions and timeouts do not stop the other actions', async () => {
  const { guild } = setup({ enable: ['antiemojispam'] });
  const channel = await channelOf(guild);
  const member = user(guild, null, { dm: false });
  channel.bulkDelete = async () => Promise.reject(apiError(50013, 403));

  await send(guild, channel, member, { content: emojiSpam, at: T0 });
  const warned = await send(guild, channel, member, { content: emojiSpam, at: T0 + 1 });
  assert.equal(warned.dmSent, false);
  assert.equal(warned.deleted, 0);
  assert.ok(warned.warning, 'the warning is still recorded');
  assert.match(warned.errors[0], /Message deletion failed/);

  member.disableCommunicationUntil = async () => Promise.reject(apiError(50013, 403));
  channel.permissionsFor = () => ({ has: () => false });
  const muted = await send(guild, channel, member, { content: emojiSpam, at: T0 + 2 });
  assert.equal(muted.level, 3);
  assert.equal(muted.mute, null);
  assert.match(muted.errors.join(' '), /Missing access or Manage Messages/);
  assert.match(muted.errors.join(' '), /Timeout failed/);
  assert.match(fields(logs(guild).at(-1)).Errors, /Timeout failed/);
});

test('AutoMod mutes never shorten a longer existing timeout', async () => {
  const { guild } = setup();
  const member = user(guild);
  member.communicationDisabledUntilTimestamp = Date.now() + 48 * HOUR;
  let changed = false;
  member.disableCommunicationUntil = async () => {
    changed = true;
  };
  const record = await moderation.automodMute({ guild, member, duration: '1h', functionId: 'antiemojispam', reason: 'r', channelId: 'c' });
  assert.equal(changed, false);
  assert.equal(record.source, 'automod');
});

test('every AutoMod action is logged when logs are enabled and nothing is sent when disabled', async () => {
  const { guild } = setup({ enable: ['antiemojispam'] });
  const channel = await channelOf(guild);
  const member = user(guild);
  for (let index = 0; index < 3; index++) await send(guild, channel, member, { content: emojiSpam, at: T0 + index });

  const entries = logs(guild);
  assert.deepEqual(entries.map((entry) => entry.title), ['AutoMod • Anti-Emoji Spam', 'AutoMod • Anti-Emoji Spam', 'AutoMod • Anti-Emoji Spam']);
  assert.deepEqual(entries.map((entry) => fields(entry).Flag), ['1/3', '2/3', '3/3']);
  assert.match(fields(entries[0]).Action, /^DELETE \(1 message\)$/);
  assert.match(fields(entries[1]).Action, /WARN \(record #\d+\)/);
  assert.match(fields(entries[2]).Action, /TIMEOUT 1 hour \(record #\d+\)/);
  assert.equal(fields(entries[2]).Function, 'Anti-Emoji Spam (`antiemojispam`)');
  assert.equal(fields(entries[2]).Channel, `<#${channel.id}>`);

  const quiet = setup({ enable: ['antiemojispam'], logs: false }).guild;
  const quietChannel = await channelOf(quiet);
  const quietMember = user(quiet);
  for (let index = 0; index < 3; index++) await send(quiet, quietChannel, quietMember, { content: emojiSpam, at: T0 + index });
  assert.equal(quiet.logChannel.sent.length, 0);
  assert.ok(quietMember.isCommunicationDisabled(), 'the action still happens');
});

test('AutoMod warnings appear in /modlog marked as AutoMod', async () => {
  const { guild } = setup({ enable: ['antispam'] });
  const channel = await channelOf(guild);
  const member = user(guild);
  await moderation.warn({ guild, moderator: user(guild, ROLES.MODERATOR), target: { user: member.user, member }, reason: 'Manual warning' });
  await burst(guild, channel, member, { count: 5, start: T0, step: 100 });
  await burst(guild, channel, member, { count: 5, start: T0 + 60_000, step: 100 });

  const page = modlog.render(guild.id, member.id, 0).embeds[0].toJSON();
  const automodField = page.fields.find((field) => field.name.includes('Warn (AutoMod)'));
  assert.ok(automodField);
  assert.match(automodField.value, /\*\*Source:\*\* AutoMod/);
  assert.match(automodField.value, /\*\*Function:\*\* Anti-Spam/);
  assert.match(automodField.value, /\*\*Moderator:\*\* Roland AutoMod/);
  assert.match(automodField.value, /\*\*Reason:\*\* Spam detection/);
  assert.doesNotMatch(automodField.value, /<@\d+>/, 'not attributed to a human moderator');

  const manual = page.fields.find((field) => field.name.endsWith('• Warn'));
  assert.doesNotMatch(manual.value, /AutoMod/);
});

test('concurrent violations create distinct flag levels', async () => {
  const { guild } = setup({ enable: ['antiemojispam'] });
  const channel = await channelOf(guild);
  const member = user(guild);
  const outcomes = await Promise.all([0, 1, 2].map((index) => send(guild, channel, member, { content: emojiSpam, at: T0 + index })));
  assert.deepEqual(outcomes.map((outcome) => outcome.level).sort(), [1, 2, 3]);
});

const joinMember = (guild, at) => automod.handleJoin({ id: snowflake(), guild, user: { bot: false }, roles: { cache: new Map([[guild.id, {}]]) } }, at);

test('Anti-Raid: 8 joins in 20 seconds starts a persisted 30 minute alert with 10 staff alerts', async () => {
  const { guild } = setup({ enable: ['antiraid'] });
  for (let index = 0; index < 7; index++) assert.equal(await joinMember(guild, T0 + index * 2000), null);
  assert.equal(automodRaids.active(guild.id, T0 + 15_000), null, '7 joins do not trigger');

  const state = await joinMember(guild, T0 + 15_000);
  assert.equal(state.expires_at, T0 + 15_000 + 30 * 60_000);
  assert.equal(await joinMember(guild, T0 + 16_000), null, 'an active raid is not activated twice');

  const sent = guild.logChannel.sent;
  assert.equal(sent[0].embeds[0].toJSON().title, 'AutoMod • Anti-Raid activated');
  const alerts = sent.filter((entry) => entry.content?.includes('Anti-Raid alert'));
  assert.equal(alerts.length, 10);
  for (const alert of alerts) {
    for (const role of STAFF) assert.ok(alert.content.includes(`<@&${role}>`), role);
    assert.deepEqual(alert.allowedMentions.parse, []);
    assert.deepEqual([...alert.allowedMentions.roles].sort(), [...STAFF].sort());
  }

  restart();
  assert.ok(automodRaids.active(guild.id, T0 + 20 * 60_000), 'the alert survives a restart');

  const slow = setup({ enable: ['antiraid'] }).guild;
  for (let index = 0; index < 10; index++) assert.equal(await joinMember(slow, T0 + index * 3000), null, '8 joins spread over more than 20 seconds');

  const disabled = setup().guild;
  for (let index = 0; index < 10; index++) assert.equal(await joinMember(disabled, T0 + index), null, 'nothing happens while disabled');

  const quiet = setup({ enable: ['antiraid'], logs: false }).guild;
  for (let index = 0; index < 8; index++) await joinMember(quiet, T0 + index);
  assert.ok(automodRaids.active(quiet.id, T0 + 10), 'the raid state activates without logs');
  assert.equal(quiet.logChannel.sent.length, 0, 'no alerts are sent when logs are disabled');
});

const startRaid = async (guild, at = T0) => {
  for (let index = 0; index < 8; index++) await joinMember(guild, at + index);
};

const canSend = (channel, guild, member) => {
  const flag = PermissionFlagsBits.SendMessages;
  const overwrites = channel.permissionOverwrites.cache;
  let allowed = true;
  if (overwrites.get(guild.id)?.deny.has(flag)) allowed = false;
  if (overwrites.get(guild.id)?.allow.has(flag)) allowed = true;
  const roles = [...member.roles.cache.keys()].map((id) => overwrites.get(id)).filter(Boolean);
  if (roles.some((overwrite) => overwrite.deny.has(flag))) allowed = false;
  if (roles.some((overwrite) => overwrite.allow.has(flag))) allowed = true;
  return allowed;
};

test('raid lockdown locks only flooded channels, keeps staff access and restores safely', async () => {
  const { guild } = setup({ enable: ['antiraid'] });
  const general = await channelOf(guild, 'general');
  const quiet = await channelOf(guild, 'quiet');
  general.permissionOverwrites.set(MEMBER_ROLE, OverwriteType.Role, [PermissionFlagsBits.SendMessages]);
  general.permissionOverwrites.set(guild.id, OverwriteType.Role, [], [PermissionFlagsBits.AddReactions]);
  await startRaid(guild);

  const raiders = [user(guild, MEMBER_ROLE), user(guild, MEMBER_ROLE), user(guild)];
  await burst(guild, general, raiders[0], { count: 5, start: T0 + 60_000, step: 100 });
  await burst(guild, general, raiders[1], { count: 5, start: T0 + 61_000, step: 100 });
  assert.equal(general.permissionOverwrites.edits.length, 0, 'two users are not enough');
  await burst(guild, general, raiders[2], { count: 5, start: T0 + 62_000, step: 100 });

  const everyone = general.permissionOverwrites.cache.get(guild.id);
  for (const permission of ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads']) {
    assert.ok(everyone.deny.has(PermissionFlagsBits[permission]), permission);
  }
  assert.ok(general.permissionOverwrites.cache.get(MEMBER_ROLE).deny.has(PermissionFlagsBits.SendMessages), 'role allows are overridden');
  for (const raider of raiders) assert.ok(!canSend(general, guild, raider));
  for (const role of STAFF) assert.ok(canSend(general, guild, user(guild, role)), `${role} keeps access`);
  assert.equal(quiet.permissionOverwrites.edits.length, 0, 'other channels are untouched');
  assert.equal(automodRaids.lockdowns(guild.id).length, 1);
  assert.ok(automodSettings.enabledFunctions(guild.id).has('antiraid'));

  const lockLog = logs(guild).find((entry) => entry.title === 'AutoMod • Anti-Raid Lockdown Activated');
  assert.equal(fields(lockLog)['Channel(s)'], `<#${general.id}>`);
  assert.match(fields(lockLog).Reason, /3 users triggered/);

  await general.permissionOverwrites.edit(guild.id, { SendMessages: true });
  restart();

  await automod.sweep({ guilds: { cache: new Map([[guild.id, guild]]) } }, T0 + 20 * 60_000);
  assert.ok(automodRaids.active(guild.id, T0 + 20 * 60_000), 'still active before 30 minutes');

  await automod.sweep({ guilds: { cache: new Map([[guild.id, guild]]) } }, T0 + 31 * 60_000);
  assert.equal(automodRaids.active(guild.id, T0 + 31 * 60_000), null);
  assert.equal(automodRaids.lockdowns(guild.id).length, 0);

  const restored = general.permissionOverwrites.cache;
  assert.ok(restored.get(guild.id).allow.has(PermissionFlagsBits.SendMessages), 'manual change during the lockdown is kept');
  assert.ok(!restored.get(guild.id).deny.has(PermissionFlagsBits.SendMessagesInThreads), 'automated deny removed');
  assert.ok(restored.get(guild.id).deny.has(PermissionFlagsBits.AddReactions), 'pre-existing deny kept');
  assert.ok(restored.get(MEMBER_ROLE).allow.has(PermissionFlagsBits.SendMessages), 'role allow restored');
  assert.ok(!restored.get(ROLES.SUPPORT).allow.has(PermissionFlagsBits.SendMessages), 'temporary staff allow removed');

  const ended = logs(guild).find((entry) => entry.title === 'AutoMod • Anti-Raid alert ended');
  assert.match(fields(ended)['Lockdown ended'], /permission\(s\) restored, 1 left unchanged \(modified manually\)/);
});

test('raid monitoring respects whitelists and disabling Anti-Raid ends the alert immediately', async () => {
  const { guild } = setup({ enable: ['antiraid'] });
  const channel = await channelOf(guild);
  await startRaid(guild);
  automodWhitelist.add({ guildId: guild.id, functionId: 'antiraid', targetType: 'role', targetId: MEMBER_ROLE, createdBy: 'admin' });

  for (let index = 0; index < 3; index++) await burst(guild, channel, user(guild, MEMBER_ROLE), { count: 5, start: T0 + 60_000 + index * 1000, step: 100 });
  assert.equal(automodRaids.lockdowns(guild.id).length, 0, 'whitelisted users do not trigger lockdowns');

  for (let index = 0; index < 3; index++) await burst(guild, channel, user(guild), { count: 5, start: T0 + 70_000 + index * 1000, step: 100 });
  assert.equal(automodRaids.lockdowns(guild.id).length, 1);

  await automod.setEnabled(guild, 'antiraid', false, 'admin');
  assert.equal(automodRaids.active(guild.id, T0 + 80_000), null);
  assert.equal(automodRaids.lockdowns(guild.id).length, 0);
  assert.ok(!channel.permissionOverwrites.cache.get(guild.id).deny.has(PermissionFlagsBits.SendMessages));
});

test('floods inside threads lock the parent channel', async () => {
  const { guild } = setup({ enable: ['antiraid'] });
  const parent = await channelOf(guild, 'general');
  const thread = { id: snowflake(), name: 'thread', parent, bulkDelete: async (ids) => new Collection(ids.map((id) => [id, {}])), permissionsFor: () => ({ has: () => true }) };
  guild.channels.cache.set(thread.id, thread);
  await startRaid(guild);

  for (let index = 0; index < 3; index++) await burst(guild, thread, user(guild), { count: 5, start: T0 + 60_000 + index * 1000, step: 100 });
  assert.equal(automodRaids.lockdowns(guild.id)[0].channel_id, parent.id);
  assert.ok(parent.permissionOverwrites.cache.get(guild.id).deny.has(PermissionFlagsBits.SendMessagesInThreads));
});

test('a restart after an expired raid restores locked channels', async () => {
  const { guild } = setup({ enable: ['antiraid'] });
  const channel = await channelOf(guild);
  await startRaid(guild);
  for (let index = 0; index < 3; index++) await burst(guild, channel, user(guild), { count: 5, start: T0 + 60_000 + index * 1000, step: 100 });
  assert.ok(channel.permissionOverwrites.cache.get(guild.id).deny.has(PermissionFlagsBits.SendMessages));

  restart();
  await automod.sweep({ guilds: { cache: new Map([[guild.id, guild]]) } }, T0 + 5 * HOUR);
  assert.ok(!channel.permissionOverwrites.cache.get(guild.id).deny.has(PermissionFlagsBits.SendMessages));
  assert.equal(automodRaids.get(guild.id).active, 0);
});

test('/automodlist shows every function with its ID, status, actions and whitelist', async () => {
  const { guild } = setup({ enable: ['antiinvite'] });
  automodWhitelist.add({ guildId: guild.id, functionId: 'antiinvite', targetType: 'user', targetId: '111111111111111111', createdBy: 'admin' });
  automodWhitelist.add({ guildId: guild.id, functionId: 'antiinvite', targetType: 'role', targetId: MEMBER_ROLE, createdBy: 'admin' });

  const overview = automodlist.render(guild.id, 0).embeds[0].toJSON();
  for (const fn of FUNCTIONS) assert.match(overview.description, new RegExp(`Function ID: \`${fn.id}\``));
  assert.match(overview.description, /🟢 \*\*ENABLED\*\* — \*\*Anti-Invite\*\*/);
  assert.match(overview.description, /🔴 \*\*DISABLED\*\* — \*\*Anti-Spam\*\*/);

  const pages = FUNCTIONS.map((fn, index) => automodlist.render(guild.id, index + 1).embeds[0].toJSON());
  const invite = pages[FUNCTIONS.findIndex((fn) => fn.id === 'antiinvite')];
  const values = fields(invite);
  assert.equal(invite.title, 'Anti-Invite');
  assert.match(invite.description, /Function ID: `antiinvite`/);
  assert.match(invite.description, /ENABLED/);
  assert.equal(values.Flags, '3 flags maximum. Each flag lasts 4 hours.');
  assert.deepEqual([values['1/3'], values['2/3'], values['3/3']], ['Delete message + Warn', 'Delete message + Mute 24 hours', 'Delete message + Mute 24 hours']);
  assert.match(values.Note, /3\/3 repeats the 2\/3 action/);
  assert.equal(values['Whitelisted users'], '<@111111111111111111>');
  assert.equal(values['Whitelisted roles'], `<@&${MEMBER_ROLE}>`);

  const duplicate = fields(pages[FUNCTIONS.findIndex((fn) => fn.id === 'antiduplicate')]);
  assert.match(duplicate.Note, /3\/3 repeats the 2\/3 action/);
  assert.equal(duplicate['3/3'], 'Delete offending messages + Mute 6 hours');
  for (const page of pages) assert.ok(JSON.stringify(page).length < 6000);

  const raid = fields(pages.at(-1));
  assert.match(raid.Response, /30 minutes/);
  assert.equal(automodlist.render(guild.id, 99).embeds[0].toJSON().footer.text, `Page ${FUNCTIONS.length + 1} of ${FUNCTIONS.length + 1}`);
});

test('privileged intents are only requested when enabled in the Developer Portal', async () => {
  const rest = (flags) => ({ get: async () => ({ flags }) });
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const all = await resolveIntents('token', rest((1 << 19) | (1 << 15)));
    assert.ok(all.intents.includes(GatewayIntentBits.MessageContent));
    assert.ok(all.intents.includes(GatewayIntentBits.GuildMembers));
    assert.deepEqual(all.capabilities, { messageContent: true, members: true });

    const limited = await resolveIntents('token', rest((1 << 18) | (1 << 14)));
    assert.deepEqual(limited.capabilities, { messageContent: true, members: true });

    const none = await resolveIntents('token', rest(0));
    assert.deepEqual(none.intents, [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages]);
    assert.deepEqual(none.capabilities, { messageContent: false, members: false });

    const original = console.error;
    console.error = () => {};
    const failed = await resolveIntents('token', { get: async () => Promise.reject(new Error('offline')) });
    console.error = original;
    assert.deepEqual(failed.capabilities, { messageContent: false, members: false });
  } finally {
    console.warn = quiet;
  }
});
