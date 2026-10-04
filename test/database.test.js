const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const database = require('../src/database');
const punishments = require('../src/database/punishments');
const guildSettings = require('../src/database/guildSettings');
const tickets = require('../src/database/tickets');
const ticketPanels = require('../src/database/ticketPanels');
const { tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
const restart = () => {
  database.close();
  database.open(file);
};

test.before(() => database.open(file));
test.after(() => database.close());

test('a fresh database is migrated to the latest version', () => {
  const fresh = tempDatabase();
  const db = database.open(fresh);
  assert.equal(db.pragma('user_version', { simple: true }), database.migrations.length);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['punishments', 'guild_settings', 'ticket_panels', 'ticket_counters', 'tickets', 'verifications', 'verification_panels', 'oauth_states', 'automod_settings', 'automod_flags']) assert.ok(tables.includes(table), table);
  database.open(file);
});

test('an existing version 1 database is upgraded without losing data', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  db.exec(database.migrations[0]);
  db.pragma('user_version = 1');
  db.prepare("INSERT INTO punishments (type, guild_id, user_id, moderator_id, reason, created_at) VALUES ('warn', 'g', 'u', 'm', 'old', 1)").run();
  db.prepare("INSERT INTO guild_settings (guild_id, log_channel_id, logs_enabled) VALUES ('g', 'logs', 1)").run();
  db.close();

  database.open(legacy);
  assert.equal(database.get().pragma('user_version', { simple: true }), database.migrations.length);
  assert.equal(punishments.listByUser('g', 'u', 10)[0].reason, 'old');
  assert.equal(guildSettings.get('g').log_channel_id, 'logs');
  assert.equal(tickets.reserve({ guildId: 'g', panelId: null, creatorId: 'u', robloxUsername: 'Player', reason: 'r' }).ticket.number, 1);

  database.open(legacy);
  assert.equal(database.get().pragma('user_version', { simple: true }), database.migrations.length);
  database.open(file);
});

test('an existing version 2 database with tickets is upgraded to add verification tables', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  database.migrations.slice(0, 2).forEach((sql) => db.exec(sql));
  db.pragma('user_version = 2');
  db.prepare("INSERT INTO tickets (guild_id, number, creator_id, roblox_username, reason, status, created_at) VALUES ('g', 7, 'u', 'P', 'r', 'OPEN', 1)").run();
  db.close();

  database.open(legacy);
  assert.equal(database.get().pragma('user_version', { simple: true }), database.migrations.length);
  assert.equal(tickets.findActiveByCreator('g', 'u').number, 7);
  const tables = database.get().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['verifications', 'verification_panels', 'oauth_states']) assert.ok(tables.includes(table), table);
  database.open(file);
});

test('an existing version 3 database gains AutoMod tables and punishment sources', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  database.migrations.slice(0, 3).forEach((sql) => db.exec(sql));
  db.pragma('user_version = 3');
  db.prepare("INSERT INTO punishments (type, guild_id, user_id, moderator_id, reason, created_at) VALUES ('warn', 'g', 'u', 'm', 'manual', 1)").run();
  db.prepare("INSERT INTO verifications (discord_id, roblox_id, roblox_username, verified_at) VALUES ('u', '1', 'player', 1)").run();
  db.close();

  database.open(legacy);
  assert.equal(database.get().pragma('user_version', { simple: true }), database.migrations.length);
  const [warn] = punishments.listByUser('g', 'u', 1);
  assert.deepEqual([warn.reason, warn.source, warn.automod_function], ['manual', 'moderator', null]);
  assert.equal(database.get().prepare('SELECT roblox_username FROM verifications').get().roblox_username, 'player');
  const tables = database.get().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['automod_settings', 'automod_flags', 'automod_whitelist', 'automod_raid_state', 'automod_lockdowns', 'automod_lockdown_overwrites']) {
    assert.ok(tables.includes(table), table);
  }
  database.open(file);
});

test('an existing version 4 database keeps pending OAuth states and gains the state mode', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  database.migrations.slice(0, 4).forEach((sql) => db.exec(sql));
  db.pragma('user_version = 4');
  db.prepare("INSERT INTO oauth_states (state_hash, discord_id, guild_id, created_at, expires_at) VALUES ('hash', 'u', 'g', 1, 2)").run();
  db.close();

  database.open(legacy);
  assert.equal(database.get().pragma('user_version', { simple: true }), database.migrations.length);
  assert.equal(database.get().prepare("SELECT mode FROM oauth_states WHERE state_hash = 'hash'").get().mode, 'link');
  database.open(file);
});

test('an existing version 5 database gains the level tables without touching other data', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  database.migrations.slice(0, 5).forEach((sql) => db.exec(sql));
  db.pragma('user_version = 5');
  db.prepare("INSERT INTO punishments (type, guild_id, user_id, moderator_id, reason, created_at) VALUES ('warn', 'g', 'u', 'm', 'kept', 1)").run();
  db.close();

  database.open(legacy);
  assert.equal(database.get().pragma('user_version', { simple: true }), database.migrations.length);
  assert.equal(punishments.listByUser('g', 'u', 1)[0].reason, 'kept');
  const tables = database.get().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(tables.includes('levels') && tables.includes('level_role_rewards'));
  database.open(file);
});

test('an existing version 6 database caps stored XP at the level 200 limit', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  database.migrations.slice(0, 6).forEach((sql) => db.exec(sql));
  db.pragma('user_version = 6');
  const insert = db.prepare('INSERT INTO levels (guild_id, user_id, xp, messages, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)');
  insert.run('g', 'huge', 500_000_000);
  insert.run('g', 'normal', 1234);
  db.close();

  database.open(legacy);
  assert.equal(database.get().pragma('user_version', { simple: true }), 7);
  const xp = Object.fromEntries(database.get().prepare('SELECT user_id, xp FROM levels').all().map((row) => [row.user_id, row.xp]));
  assert.deepEqual(xp, { huge: 19_999, normal: 1234 });
  database.open(file);
});

test('punishment records survive a restart', () => {
  const ban = punishments.create({ type: 'ban', guildId: 'g', userId: 'u', moderatorId: 'm', reason: 'r', duration: '7d', expiresAt: 1000, active: true, channelId: 'c' });
  const clear = punishments.create({ type: 'clear', guildId: 'g', userId: 'u', moderatorId: 'm', channelId: 'c', metadata: { requested: 50, deleted: 42 } });

  restart();

  assert.deepEqual(punishments.findById(ban.id), ban);
  assert.deepEqual(punishments.findById(clear.id).metadata, { requested: 50, deleted: 42 });
  assert.equal(punishments.countByUser('g', 'u'), 2);
  assert.deepEqual(punishments.listByUser('g', 'u', 10).map((record) => record.type), ['clear', 'ban']);
});

test('pending temporary bans and deactivation', () => {
  const due = punishments.create({ type: 'ban', guildId: 'g2', userId: 'a', moderatorId: 'm', expiresAt: 500, active: true });
  punishments.create({ type: 'ban', guildId: 'g2', userId: 'b', moderatorId: 'm', expiresAt: 5000, active: true });
  punishments.create({ type: 'ban', guildId: 'g2', userId: 'c', moderatorId: 'm', active: true });

  const ids = (now) => punishments.dueBans(now).filter((ban) => ban.guild_id === 'g2').map((ban) => ban.user_id);
  assert.deepEqual(ids(1000), ['a']);
  assert.deepEqual(ids(10_000), ['a', 'b']);

  assert.equal(punishments.deactivateBans('g2', 'a'), 1);
  assert.equal(punishments.findById(due.id).active, false);
  assert.deepEqual(ids(10_000), ['b']);
});

test('log settings persist and turning logs off keeps the channel', () => {
  guildSettings.enableLogs('g', 'channel1');
  restart();
  assert.deepEqual(guildSettings.get('g'), { guild_id: 'g', log_channel_id: 'channel1', logs_enabled: 1 });

  guildSettings.disableLogs('g');
  assert.deepEqual(guildSettings.get('g'), { guild_id: 'g', log_channel_id: 'channel1', logs_enabled: 0 });

  guildSettings.enableLogs('g', 'channel2');
  assert.equal(guildSettings.get('g').log_channel_id, 'channel2');
  assert.equal(guildSettings.get('g').logs_enabled, 1);
});

test('ticket numbering, one active ticket per user and the state machine', () => {
  const panel = ticketPanels.create({ guildId: 't', channelId: 'c', messageId: 'panel-message', categoryId: 'cat', createdBy: 'admin' });
  const reserve = (creatorId) => tickets.reserve({ guildId: 't', panelId: panel.id, creatorId, robloxUsername: 'Player', reason: 'Help' });

  const first = reserve('a').ticket;
  const second = reserve('b').ticket;
  assert.deepEqual([first.number, second.number], [1, 2]);
  assert.equal(reserve('a').active.id, first.id);

  restart();
  assert.equal(reserve('c').ticket.number, 3);
  assert.equal(ticketPanels.findByMessage('panel-message').category_id, 'cat');

  assert.equal(tickets.transition(first.id, 'CLOSED', 'staff'), null, 'OPEN -> CLOSED is not allowed');
  assert.equal(tickets.transition(first.id, 'DELETED', 'staff'), null, 'OPEN -> DELETED is not allowed');
  assert.equal(tickets.transition(first.id, 'CLAIMED', 'staff').status, 'CLAIMED');
  assert.equal(tickets.transition(first.id, 'CLAIMED', 'other'), null, 'cannot claim twice');
  assert.equal(tickets.transition(first.id, 'CLOSED', 'staff').status, 'CLOSED');
  assert.equal(tickets.transition(first.id, 'CLAIMED', 'staff'), null, 'closed tickets cannot be claimed');
  assert.equal(reserve('a').ticket.number, 4, 'a closed ticket frees the user');
  assert.equal(tickets.transition(first.id, 'DELETED', 'admin').status, 'DELETED');
  assert.equal(tickets.markOrphaned(first.id), 0, 'deleted tickets are never modified');
  assert.throws(() => tickets.transition(first.id, 'OPEN', 'staff'), /Unsupported/);

  restart();
  const stored = tickets.findById(first.id);
  assert.equal(stored.status, 'DELETED');
  assert.equal(stored.claimed_by, 'staff');
  assert.equal(stored.deleted_by, 'admin');
});
