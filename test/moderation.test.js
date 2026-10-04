const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const database = require('../src/database');
const punishments = require('../src/database/punishments');
const guildSettings = require('../src/database/guildSettings');
const moderation = require('../src/services/moderation');
const logging = require('../src/services/logging');
const tempBans = require('../src/services/tempBans');
const { ROLES } = require('../src/permissions');
const { UserError } = require('../src/utils/errors');
const { BOT_ID, apiError, makeGuild, makeMember, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
const DAY = 86_400_000;

const target = (member) => ({ user: member.user, member });
const clientFor = (guild) => ({ user: { id: BOT_ID }, guilds: { cache: new Map([[guild.id, guild]]) } });
const logs = (guild) => guild.logChannel.sent;
const dm = (member) => member.state.dms.at(-1).payload.embeds[0].toJSON();

test.before(() => database.open(file));
test.after(() => database.close());

test('a temporary ban is recorded, logged and lifted after a restart', async () => {
  const guild = makeGuild();
  guildSettings.enableLogs(guild.id, guild.logChannel.id);
  const moderator = makeMember(ROLES.SENIOR_MODERATOR);
  const victim = makeMember();

  const start = Date.now();
  const { record, dmSent } = await moderation.ban({ guild, moderator, target: target(victim), duration: '7d', reason: 'Spam', channelId: 'c' });
  assert.equal(record.type, 'ban');
  assert.equal(record.active, true);
  assert.equal(record.duration, '7d');
  assert.ok(Math.abs(record.expires_at - (start + 7 * DAY)) < 1000);
  assert.ok(guild.banned.has(victim.id));
  assert.equal(dmSent, true);
  assert.equal(logs(guild).length, 1);

  database.close();
  database.open(file);

  await tempBans.sweep(clientFor(guild), start + 2 * DAY);
  assert.ok(guild.banned.has(victim.id), 'five days remain, the user must stay banned');
  assert.equal(punishments.findById(record.id).active, true);

  await tempBans.sweep(clientFor(guild), start + 30 * DAY);
  assert.ok(!guild.banned.has(victim.id), 'the user must be unbanned after expiration');
  assert.equal(punishments.findById(record.id).active, false);

  const [unban] = punishments.listByUser(guild.id, victim.id, 1);
  assert.equal(unban.type, 'unban');
  assert.equal(unban.moderator_id, BOT_ID);
  assert.match(unban.reason, /expired/);
  assert.equal(logs(guild).length, 2);
});

test('a permanent ban never expires automatically', async () => {
  const guild = makeGuild();
  const victim = makeMember();
  const { record } = await moderation.ban({ guild, moderator: makeMember(ROLES.ADMINISTRATOR), target: target(victim), duration: 'forever', reason: 'r' });
  assert.equal(record.expires_at, null);
  await tempBans.sweep(clientFor(guild), Date.now() + 1000 * 365 * DAY);
  assert.ok(guild.banned.has(victim.id));
});

test('ban: already banned, Creator, higher role, empty reason and invalid duration', async () => {
  const guild = makeGuild();
  const admin = makeMember(ROLES.ADMINISTRATOR);
  const victim = makeMember();
  await moderation.ban({ guild, moderator: admin, target: target(victim), duration: '1d', reason: 'r' });

  await assert.rejects(moderation.ban({ guild, moderator: admin, target: target(victim), duration: '1d', reason: 'r' }), /already banned/);
  await assert.rejects(moderation.ban({ guild, moderator: admin, target: target(makeMember(ROLES.CREATOR)), duration: '1d', reason: 'r' }), /Creator/);
  await assert.rejects(
    moderation.ban({ guild, moderator: makeMember(ROLES.SENIOR_MODERATOR), target: target(makeMember(ROLES.ADMINISTRATOR)), duration: '1d', reason: 'r' }),
    /equal or higher/,
  );
  await assert.rejects(moderation.ban({ guild, moderator: admin, target: target(makeMember()), duration: '1d', reason: '   ' }), /reason/);
  await assert.rejects(moderation.ban({ guild, moderator: admin, target: target(makeMember()), duration: '10x', reason: 'r' }), /Invalid duration/);
  assert.equal(guild.banned.size, 1);
});

test('ban DM states the ban, duration, reason, server and executor', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.ADMINISTRATOR);

  const temporary = makeMember();
  await moderation.ban({ guild, moderator, target: target(temporary), duration: '7d', reason: 'Exploiting' });
  const notice = dm(temporary);
  assert.equal(notice.title, 'You have been banned');
  for (const text of ['Test Server', '7 days', 'Exploiting', moderator.user.tag, 'Expires']) assert.ok(notice.description.includes(text), text);

  const permanent = makeMember();
  await moderation.ban({ guild, moderator, target: target(permanent), duration: 'forever', reason: 'Raid' });
  assert.match(dm(permanent).description, /Permanent/);

  const closed = makeMember(null, { dm: false });
  const result = await moderation.ban({ guild, moderator, target: target(closed), duration: '1d', reason: 'r' });
  assert.equal(result.dmSent, false);
  assert.ok(guild.banned.has(closed.id), 'the ban succeeds even when the DM fails');
});

test('the ban DM is withdrawn if the ban itself fails', async () => {
  const guild = makeGuild();
  guild.members.ban = async () => Promise.reject(apiError(50013, 403));
  const victim = makeMember();

  await assert.rejects(moderation.ban({ guild, moderator: makeMember(ROLES.ADMINISTRATOR), target: target(victim), duration: '1d', reason: 'r' }));
  assert.equal(victim.state.dms[0].deleted, true);
  assert.equal(punishments.countByUser(guild.id, victim.id), 0);
});

test('a manual unban deactivates the temporary ban', async () => {
  const guild = makeGuild();
  const admin = makeMember(ROLES.ADMINISTRATOR);
  const victim = makeMember();
  const { record: ban } = await moderation.ban({ guild, moderator: admin, target: target(victim), duration: '1h', reason: 'r' });

  const unban = await moderation.unban({ guild, moderator: admin, target: { user: victim.user, member: null }, reason: 'Reviewed' });
  assert.equal(unban.type, 'unban');
  assert.equal(punishments.findById(ban.id).active, false);
  await assert.rejects(moderation.unban({ guild, moderator: admin, target: { user: victim.user, member: null }, reason: 'r' }), /not banned/);

  const before = punishments.countByUser(guild.id, victim.id);
  await tempBans.sweep(clientFor(guild), Date.now() + DAY);
  assert.equal(punishments.countByUser(guild.id, victim.id), before);
});

test('kick requires a member, records the action and sends a DM', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.SENIOR_MODERATOR);
  const victim = makeMember(ROLES.MODERATOR);

  const { record, dmSent } = await moderation.kick({ guild, moderator, target: target(victim), reason: 'Toxicity' });
  assert.equal(record.type, 'kick');
  assert.ok(victim.state.kicked);
  assert.equal(dmSent, true);
  const notice = dm(victim);
  assert.equal(notice.title, 'You have been kicked');
  for (const text of ['Test Server', 'Toxicity', moderator.user.tag]) assert.ok(notice.description.includes(text), text);

  const closed = makeMember(null, { dm: false });
  assert.equal((await moderation.kick({ guild, moderator, target: target(closed), reason: 'r' })).dmSent, false);
  assert.ok(closed.state.kicked);

  await assert.rejects(moderation.kick({ guild, moderator, target: { user: makeMember().user, member: null }, reason: 'r' }), /not a member/);
});

test('mute and unmute with validation and a mute DM', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.MODERATOR);
  const victim = makeMember();

  await assert.rejects(moderation.mute({ guild, moderator, target: target(victim), duration: 'forever', reason: 'r' }), /permanent/);
  await assert.rejects(moderation.mute({ guild, moderator, target: target(victim), duration: '29d', reason: 'r' }), /28 days/);
  await assert.rejects(moderation.mute({ guild, moderator, target: target(makeMember(ROLES.MODERATOR)), duration: '1h', reason: 'r' }), /equal or higher/);
  assert.equal(victim.state.dms.length, 0, 'no DM when the mute is rejected');

  const start = Date.now();
  const { record, dmSent } = await moderation.mute({ guild, moderator, target: target(victim), duration: '30m', reason: 'Flood' });
  assert.equal(record.duration, '30m');
  assert.ok(Math.abs(record.expires_at - (start + 30 * 60_000)) < 1000);
  assert.equal(victim.state.timeoutUntil, record.expires_at);
  assert.equal(dmSent, true);
  const notice = dm(victim);
  assert.equal(notice.title, 'You have been muted');
  for (const text of ['Test Server', '30 minutes', 'Flood', moderator.user.tag]) assert.ok(notice.description.includes(text), text);

  await assert.rejects(moderation.mute({ guild, moderator, target: target(victim), duration: '1h', reason: 'r' }), /already muted/);

  const closed = makeMember(null, { dm: false });
  const silent = await moderation.mute({ guild, moderator, target: target(closed), duration: '1h', reason: 'r' });
  assert.equal(silent.dmSent, false);
  assert.ok(closed.isCommunicationDisabled());

  const senior = makeMember(ROLES.SENIOR_MODERATOR);
  const unmute = await moderation.unmute({ guild, moderator: senior, target: target(victim), reason: 'r' });
  assert.equal(unmute.type, 'unmute');
  assert.equal(victim.state.timeoutUntil, null);
  await assert.rejects(moderation.unmute({ guild, moderator: senior, target: target(victim), reason: 'r' }), /not muted/);
});

test('Moderators can moderate Support staff, and Support cannot moderate peers', async () => {
  const guild = makeGuild();
  const support = makeMember(ROLES.SUPPORT);
  await moderation.warn({ guild, moderator: makeMember(ROLES.MODERATOR), target: target(support), reason: 'r' });
  await assert.rejects(moderation.warn({ guild, moderator: support, target: target(makeMember(ROLES.SUPPORT)), reason: 'r' }), /equal or higher/);
});

test('a warn is recorded even when DMs are closed', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.MODERATOR);

  const open = makeMember();
  const sent = await moderation.warn({ guild, moderator, target: target(open), reason: 'Language' });
  assert.equal(sent.dmSent, true);
  assert.equal(dm(open).title, 'You have received a warning');
  assert.match(dm(open).description, /Language/);

  const closed = makeMember(null, { dm: false });
  const blocked = await moderation.warn({ guild, moderator, target: target(closed), reason: 'Spam' });
  assert.equal(blocked.dmSent, false);
  assert.equal(punishments.findById(blocked.record.id).type, 'warn');

  const creator = makeMember(ROLES.CREATOR);
  await assert.rejects(moderation.warn({ guild, moderator: makeMember(ROLES.ADMINISTRATOR), target: target(creator), reason: 'r' }), UserError);
  assert.equal(punishments.countByUser(guild.id, creator.id), 0);
});

const makeChannel = ({ recent, old, authors, pinned = [] }) => {
  const store = new Map();
  const now = Date.now();
  let id = 1_000_000n;
  const add = (age, index) => {
    const messageId = String(id++);
    store.set(messageId, {
      id: messageId,
      author: { id: authors[index % authors.length] },
      createdTimestamp: now - age,
      pinned: pinned.includes(store.size),
      deletable: true,
      delete: async () => store.delete(messageId),
    });
  };
  for (let index = 0; index < old; index++) add(20 * DAY + (old - index) * 1000, index);
  for (let index = 0; index < recent; index++) add((recent - index) * 1000, index);

  return {
    id: 'channel',
    store,
    messages: {
      fetch: async ({ limit, before }) => {
        const list = [...store.values()]
          .filter((message) => !before || BigInt(message.id) < BigInt(before))
          .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
          .slice(0, limit);
        return new Collection(list.map((message) => [message.id, message]));
      },
    },
    bulkDelete: async (messages) => {
      assert.ok(messages.length >= 1 && messages.length <= 100);
      for (const message of messages) {
        assert.ok(now - message.createdTimestamp < 14 * DAY, 'bulk delete only receives recent messages');
        store.delete(message.id);
      }
      return new Collection(messages.map((message) => [message.id, message]));
    },
  };
};

test('clear removes recent and old messages and skips pinned ones', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.MODERATOR);

  const channel = makeChannel({ recent: 150, old: 100, authors: ['a', 'b'] });
  const small = await moderation.clear({ guild, moderator, channel, amount: 50 });
  assert.deepEqual(small.metadata, { requested: 50, deleted: 50 });
  assert.equal(small.channel_id, 'channel');
  assert.equal(channel.store.size, 200);

  const big = await moderation.clear({ guild, moderator, channel, amount: 5000 });
  assert.deepEqual(big.metadata, { requested: 5000, deleted: 200 });
  assert.equal(channel.store.size, 0);

  const withPinned = makeChannel({ recent: 10, old: 0, authors: ['a'], pinned: [9] });
  const result = await moderation.clear({ guild, moderator, channel: withPinned, amount: 10 });
  assert.equal(result.metadata.deleted, 9);
  assert.equal(withPinned.store.size, 1);

  await assert.rejects(moderation.clear({ guild, moderator, channel, amount: 5001 }), /between 1 and 5000/);
  await assert.rejects(moderation.clear({ guild, moderator, channel: {}, amount: 1 }), /cannot be cleared/);
});

test('targeted clear only removes messages from that user', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.MODERATOR);
  const victim = makeMember();
  const channel = makeChannel({ recent: 300, old: 60, authors: [victim.id, 'other', 'other'] });

  const record = await moderation.clear({ guild, moderator, channel, amount: 50, target: target(victim) });
  assert.equal(record.user_id, victim.id);
  assert.deepEqual(record.metadata, { requested: 50, deleted: 50 });
  assert.equal([...channel.store.values()].filter((message) => message.author.id === 'other').length, 240);

  const all = await moderation.clear({ guild, moderator, channel, amount: 5000, target: target(victim) });
  assert.equal(all.metadata.deleted, 70);
  assert.equal(channel.store.size, 240);

  await assert.rejects(moderation.clear({ guild, moderator, channel, amount: 5, target: target(makeMember(ROLES.CREATOR)) }), /Creator/);
});

test('modlog lists the full history with pagination', async () => {
  const guild = makeGuild();
  const admin = makeMember(ROLES.ADMINISTRATOR);
  const victim = makeMember();

  await moderation.warn({ guild, moderator: admin, target: target(victim), reason: 'w' });
  await moderation.mute({ guild, moderator: admin, target: target(victim), duration: '1h', reason: 'm' });
  await moderation.unmute({ guild, moderator: admin, target: target(victim), reason: 'u' });
  await moderation.clear({ guild, moderator: admin, channel: makeChannel({ recent: 3, old: 0, authors: [victim.id] }), amount: 3, target: target(victim) });
  await moderation.kick({ guild, moderator: admin, target: target(victim), reason: 'k' });
  await moderation.ban({ guild, moderator: admin, target: { user: victim.user, member: null }, duration: '1d', reason: 'b' });
  await moderation.unban({ guild, moderator: admin, target: { user: victim.user, member: null }, reason: 'ub' });

  database.close();
  database.open(file);

  const first = moderation.history(guild.id, victim.id, 0, 5);
  assert.equal(first.total, 7);
  assert.equal(first.pages, 2);
  assert.deepEqual(first.records.map((record) => record.type), ['unban', 'ban', 'kick', 'clear', 'unmute']);
  assert.deepEqual(moderation.history(guild.id, victim.id, 1, 5).records.map((record) => record.type), ['mute', 'warn']);
  assert.equal(moderation.history(guild.id, victim.id, 99, 5).page, 1);

  const { render } = require('../src/commands/modlog');
  const page = render(guild.id, victim.id, 0);
  assert.equal(page.embeds[0].data.title, 'Moderation history');
  assert.equal(page.embeds[0].data.fields.length, 5);
  assert.equal(page.components.length, 1);
  assert.ok(JSON.stringify(page.embeds[0].toJSON()).length < 6000);
});

test('logs: on, off and re-enable', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.ADMINISTRATOR);

  await logging.enable(guild, guild.logChannel, moderator);
  assert.equal(logs(guild).length, 1);
  assert.equal(logs(guild)[0].embeds[0].data.title, 'Logs enabled');
  assert.equal(guildSettings.get(guild.id).logs_enabled, 1);

  await moderation.warn({ guild, moderator, target: target(makeMember()), reason: 'r' });
  assert.equal(logs(guild).length, 2);
  assert.equal(logs(guild)[1].embeds[0].data.title, 'Moderation • Warn');

  logging.disable(guild);
  assert.deepEqual(guildSettings.get(guild.id), { guild_id: guild.id, log_channel_id: guild.logChannel.id, logs_enabled: 0 });
  assert.throws(() => logging.disable(guild), /already disabled/);

  const victim = makeMember();
  await moderation.warn({ guild, moderator, target: target(victim), reason: 'r' });
  assert.equal(logs(guild).length, 2);
  assert.equal(punishments.countByUser(guild.id, victim.id), 1, 'modlog keeps working while logs are off');

  const broken = { id: 'x', send: async () => Promise.reject(apiError(50013, 403)) };
  await assert.rejects(logging.enable(guild, broken, moderator), UserError);
  assert.equal(guildSettings.get(guild.id).logs_enabled, 0);
});
