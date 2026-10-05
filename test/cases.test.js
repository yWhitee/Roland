const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { Collection, SnowflakeUtil } = require('discord.js');
const database = require('../src/database');
const guildSettings = require('../src/database/guildSettings');
const punishments = require('../src/database/punishments');
const verifications = require('../src/database/verifications');
const caseCommand = require('../src/commands/case');
const modlog = require('../src/commands/modlog');
const interactionCreate = require('../src/events/interactionCreate');
const automodMessages = require('../src/services/automod/messages');
const moderation = require('../src/services/moderation');
const tempBans = require('../src/services/tempBans');
const { ROLES } = require('../src/permissions');
const { BOT_ID, apiError, makeGuild, makeInteraction, makeMember, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();

test.before(() => database.open(file));
test.after(() => database.close());

const target = (member) => ({ user: member.user, member });
const absent = (member) => ({ user: member.user, member: null });
const DAY = 86_400_000;

const setup = () => {
  const guild = makeGuild();
  guildSettings.enableLogs(guild.id, guild.logChannel.id);
  return { guild, mod: makeMember(ROLES.ADMINISTRATOR, { globalName: 'Mod Display' }) };
};

const join = (guild, options) => {
  const member = makeMember(null, options);
  guild.members.cache.set(member.id, member);
  return member;
};

const punishAll = async (guild, mod, victim) => {
  const warn = (await moderation.warn({ guild, moderator: mod, target: target(victim), reason: 'Flood' })).record;
  const mute = (await moderation.mute({ guild, moderator: mod, target: target(victim), duration: '10m', reason: 'Spam' })).record;
  const kick = (await moderation.kick({ guild, moderator: mod, target: target(victim), reason: 'Rude' })).record;
  const ban = (await moderation.ban({ guild, moderator: mod, target: absent(victim), duration: 'forever', reason: 'Raid' })).record;
  return { warn, mute, kick, ban };
};

const usersOf = (...members) => {
  const known = new Map(members.map((member) => [member.id, member.user]));
  return { fetch: async (id) => known.get(id) ?? Promise.reject(apiError(10013)) };
};

const command = async (guild, member, value, extra = {}) => {
  const interaction = {
    ...makeInteraction({ guild, member }),
    options: { getString: () => value },
    client: { users: usersOf() },
    ...extra,
  };
  const execute = interaction.commandName === 'modlog' ? modlog.execute : caseCommand.execute;
  await execute(interaction);
  return interaction;
};

const click = async (guild, member, customId, message = { embeds: [] }) => {
  const updates = [];
  const interaction = { ...makeInteraction({ guild, member, customId, message }), update: async (payload) => updates.push(payload) };
  await caseCommand.handleComponent(interaction);
  return updates[0];
};

const page = (payload) => {
  const embed = payload.embeds[0].toJSON();
  const buttons = payload.components[0]?.toJSON().components ?? [];
  return {
    cases: embed.fields?.map((field) => Number(field.name.match(/Case #(\d+)/)[1])) ?? [],
    footer: embed.footer.text,
    buttons: Object.fromEntries(buttons.map((button) => [button.label, { id: button.custom_id, disabled: Boolean(button.disabled) }])),
  };
};

test('warn, mute, kick and ban each create one numbered case starting at 1', async () => {
  const { guild, mod } = setup();
  const victim = join(guild, { globalName: 'Victim Display' });
  const cases = await punishAll(guild, mod, victim);

  assert.deepEqual(Object.values(cases).map((record) => [record.type, record.case_number]), [['warn', 1], ['mute', 2], ['kick', 3], ['ban', 4]]);
  for (const record of Object.values(cases)) {
    assert.equal(record.guild_id, guild.id);
    assert.equal(record.user_id, victim.id);
    assert.equal(record.moderator_id, mod.id);
    assert.deepEqual([record.user_name, record.user_display_name], [victim.user.username, 'Victim Display']);
    assert.deepEqual([record.moderator_name, record.moderator_display_name], [mod.user.username, 'Mod Display']);
  }
  assert.equal(punishments.countCases(guild.id), 4);
  const warn = (await moderation.warn({ guild, moderator: mod, target: target(join(guild)), reason: 'Again' })).record;
  assert.equal(warn.case_number, 5);
});

test('case numbers are per server and never duplicated, even for simultaneous actions', async () => {
  const first = setup();
  const second = setup();
  const victims = Array.from({ length: 25 }, () => join(first.guild));
  const records = await Promise.all(victims.map((victim) => moderation.warn({ guild: first.guild, moderator: first.mod, target: target(victim), reason: 'r' })));
  assert.deepEqual(records.map(({ record }) => record.case_number).sort((a, b) => a - b), Array.from({ length: 25 }, (_, index) => index + 1));

  const other = await moderation.warn({ guild: second.guild, moderator: second.mod, target: target(join(second.guild)), reason: 'r' });
  assert.equal(other.record.case_number, 1, 'another server starts at Case #1');

  const insert = database.get().prepare("INSERT INTO punishments (type, guild_id, user_id, moderator_id, created_at, case_number) VALUES ('warn', ?, 'u', 'm', 1, ?)");
  assert.throws(() => insert.run(first.guild.id, 3), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
  insert.run(`${second.guild.id}x`, 3);
});

test('a failed punishment creates no case and does not use a number', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  guild.members.ban = async () => Promise.reject(apiError(50013, 403));
  await assert.rejects(moderation.ban({ guild, moderator: mod, target: target(victim), duration: '1d', reason: 'r' }));
  victim.kick = async () => Promise.reject(apiError(50013, 403));
  await assert.rejects(moderation.kick({ guild, moderator: mod, target: target(victim), reason: 'r' }));
  victim.disableCommunicationUntil = async () => Promise.reject(apiError(50013, 403));
  await assert.rejects(moderation.mute({ guild, moderator: mod, target: target(victim), duration: '1h', reason: 'r' }));
  await assert.rejects(moderation.warn({ guild, moderator: mod, target: target(victim), reason: '  ' }), /reason/);

  assert.equal(punishments.countCases(guild.id), 0);
  assert.equal((await moderation.warn({ guild, moderator: mod, target: target(victim), reason: 'r' })).record.case_number, 1);
});

test('/logs entries show the case number, and a failed log keeps the case', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  const { warn, mute, kick, ban } = await punishAll(guild, mod, victim);
  const logged = guild.logChannel.sent.map((message) => message.embeds[0].toJSON());
  assert.deepEqual(logged.map((embed) => embed.title), ['Moderation • Warn', 'Moderation • Mute', 'Moderation • Kick', 'Moderation • Ban']);
  for (const [embed, record] of logged.map((embed, index) => [embed, [warn, mute, kick, ban][index]])) {
    assert.ok(embed.description.startsWith(`**Case:** #${record.case_number}\n`));
    assert.equal(embed.footer.text, `Case #${record.case_number}`);
  }

  guild.logChannel.send = async () => Promise.reject(apiError(50013, 403));
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  let record;
  try {
    ({ record } = await moderation.warn({ guild, moderator: mod, target: target(victim), reason: 'Kept' }));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.equal(punishments.findByCase(guild.id, record.case_number).reason, 'Kept');
});

test('cases and /modlog survive leaving, banning, unbanning and rejoining', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  await moderation.warn({ guild, moderator: mod, target: target(victim), reason: 'First' });
  guild.members.cache.delete(victim.id);
  await moderation.ban({ guild, moderator: mod, target: absent(victim), duration: '1d', reason: 'Gone' });
  await moderation.unban({ guild, moderator: mod, target: absent(victim), reason: 'Appeal' });
  database.close();
  database.open(file);
  guild.members.cache.set(victim.id, victim);

  const history = modlog.render(guild.id, victim.id, 0).embeds[0].toJSON();
  assert.deepEqual(history.fields.map((field) => field.name), ['♻️ Case #3 • Unban', '🔨 Case #2 • Ban', '⚠️ Case #1 • Warn']);
  assert.equal(punishments.findByCase(guild.id, 1).reason, 'First');
});

test('/case <number> shows the case from stored data only, even when the user left', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  await moderation.warn({ guild, moderator: mod, target: target(victim), reason: 'w' });
  const { record } = await moderation.mute({ guild, moderator: mod, target: target(victim), duration: '10m', reason: 'Spam' });
  guild.members.cache.delete(victim.id);
  guild.members.fetch = async () => assert.fail('a case must not need the member');
  victim.user.username = 'renamed_later';

  const interaction = await command(guild, mod, `${record.case_number}`);
  const [reply] = interaction.calls.replies;
  assert.ok(reply.flags);
  const embed = reply.embeds[0].toJSON();
  assert.equal(embed.title, 'Case #2');
  for (const line of [
    '**Action:** 🔇 Mute',
    `**User:** <@${victim.id}> • ${record.user_name} (\`${victim.id}\`)`,
    `**Moderator:** <@${mod.id}> • ${mod.user.username}`,
    '**Reason:** Spam',
    '**Duration:** 10 minutes',
  ]) assert.ok(embed.description.includes(line), line);
  assert.match(embed.description, /\*\*Date:\*\* <t:\d+:f>/);
  assert.ok(!embed.description.includes('renamed_later'), 'the name at the time of the case is kept');

  assert.equal((await command(guild, mod, '#1')).calls.replies[0].embeds[0].toJSON().title, 'Case #1');
});

test('/case never shows a case from another server and validates the number', async () => {
  const first = setup();
  const second = setup();
  await moderation.warn({ guild: first.guild, moderator: first.mod, target: target(join(first.guild)), reason: 'A' });
  await moderation.warn({ guild: first.guild, moderator: first.mod, target: target(join(first.guild)), reason: 'B' });
  await moderation.warn({ guild: second.guild, moderator: second.mod, target: target(join(second.guild)), reason: 'Other server' });

  assert.match((await command(second.guild, second.mod, '1')).calls.replies[0].embeds[0].toJSON().description, /Other server/);
  await assert.rejects(command(second.guild, second.mod, '2'), /Case #2 does not exist in this server/);
  for (const input of ['0', '-1', '1.5', 'abc', '9999999999999999']) await assert.rejects(command(first.guild, first.mod, input), /Provide a case number/);
});

test('/case all pages through every case from newest to oldest, privately', async () => {
  const { guild, mod } = setup();
  for (let index = 0; index < 12; index++) await moderation.warn({ guild, moderator: mod, target: target(join(guild)), reason: `Case ${index + 1}` });

  const interaction = await command(guild, mod, 'ALL');
  assert.ok(interaction.calls.deferred, 'deferred privately');
  const first = page(interaction.calls.replies[0]);
  assert.deepEqual(first.cases, [12, 11, 10, 9, 8]);
  assert.equal(first.footer, 'Page 1 / 3');
  assert.deepEqual(Object.fromEntries(Object.entries(first.buttons).map(([label, button]) => [label, button.disabled])), { '⏮': true, '◀': true, '▶': false, '⏭': false });
  assert.equal(new Set(Object.values(first.buttons).map((button) => button.id)).size, 4, 'unique custom IDs');

  const second = page(await click(guild, mod, first.buttons['▶'].id));
  assert.deepEqual([second.cases, second.footer], [[7, 6, 5, 4, 3], 'Page 2 / 3']);
  const last = page(await click(guild, mod, second.buttons['⏭'].id));
  assert.deepEqual([last.cases, last.footer], [[2, 1], 'Page 3 / 3']);
  assert.ok(last.buttons['▶'].disabled && last.buttons['⏭'].disabled);
  assert.deepEqual(page(await click(guild, mod, last.buttons['◀'].id)).cases, [7, 6, 5, 4, 3]);
  assert.deepEqual(page(await click(guild, mod, last.buttons['⏮'].id)).cases, [12, 11, 10, 9, 8]);
  assert.deepEqual(page(await click(guild, mod, `case:${mod.id}:next:99`)).cases, [2, 1], 'out of range pages are clamped');
  assert.deepEqual(page(await click(guild, mod, `case:${mod.id}:previous:-1`)).cases, [12, 11, 10, 9, 8]);

  await assert.rejects(click(guild, makeMember(ROLES.MODERATOR), first.buttons['▶'].id), /Only the moderator who opened this list/);
  assert.ok(JSON.stringify(interaction.calls.replies[0].embeds[0].toJSON()).length < 6000);
  assert.equal(punishments.listCases(guild.id, 5, 10).length, 2, 'only one page is read');

  const empty = page((await command(makeGuild(), mod, 'all')).calls.replies[0]);
  assert.deepEqual([empty.cases, empty.footer, empty.buttons], [[], 'Page 1 / 1', {}]);
});

test('/modlog shows case numbers and current user information', async () => {
  const { guild, mod } = setup();
  const victim = join(guild, { globalName: 'Victim Display' });
  victim.joinedTimestamp = Date.UTC(2026, 7, 12);
  for (const [id, position] of [['300000000000000001', 3], ['300000000000000002', 9], ['300000000000000003', 1]]) {
    guild.roles.cache.set(id, { id, position });
    victim.roles.cache.set(id, {});
  }
  verifications.link({ discordId: victim.id, robloxId: '777001', robloxUsername: 'VictimRBX', guildId: guild.id });
  await moderation.warn({ guild, moderator: mod, target: target(victim), reason: 'Flood' });
  await moderation.mute({ guild, moderator: mod, target: target(victim), duration: '10m', reason: 'Spam' });

  const interaction = await command(guild, mod, victim.id, { commandName: 'modlog', client: { users: usersOf(victim) } });
  const [info, history] = interaction.calls.replies[0].embeds.map((embed) => embed.toJSON());
  assert.equal(info.title, 'User Information');
  for (const line of [
    `**Username:** ${victim.user.username}`,
    '**Display Name:** Victim Display',
    `**User ID:** \`${victim.id}\``,
    `**Account Created:** <t:${Math.floor(SnowflakeUtil.timestampFrom(victim.id) / 1000)}:D>`,
    `**Joined:** <t:${Math.floor(victim.joinedTimestamp / 1000)}:D>`,
    '**Highest Role:** <@&300000000000000002> (position 9)',
    '**Roles:** <@&300000000000000002> <@&300000000000000001> <@&300000000000000003>',
    '**RoVer Verification:** ✓ Verified\n**Roblox:** VictimRBX',
  ]) assert.ok(info.description.includes(line), line);
  assert.deepEqual(history.fields.map((field) => field.name), ['🔇 Case #2 • Mute', '⚠️ Case #1 • Warn']);
  assert.match(history.fields[0].value, /\*\*Duration:\*\* 10 minutes/);
});

test('/modlog works for users who are no longer in the server or cannot be fetched', async () => {
  const { guild, mod } = setup();
  const victim = join(guild, { globalName: 'Old Display' });
  await moderation.warn({ guild, moderator: mod, target: target(victim), reason: 'w' });
  await moderation.kick({ guild, moderator: mod, target: target(victim), reason: 'k' });
  guild.members.cache.delete(victim.id);

  const gone = await command(guild, mod, `<@${victim.id}>`, { commandName: 'modlog', client: { users: usersOf(victim) } });
  const [info, history] = gone.calls.replies[0].embeds.map((embed) => embed.toJSON());
  assert.match(info.description, /\*\*Joined:\*\* Not currently in this server/);
  assert.doesNotMatch(info.description, /Highest Role/);
  assert.match(info.description, /\*\*RoVer Verification:\*\* ✗ Not verified/);
  assert.match(info.description, new RegExp(`\\*\\*Name recorded in cases:\\*\\* ${victim.user.username} \\(Old Display\\)`));
  assert.equal(history.fields.length, 2);

  const unknown = await command(guild, mod, victim.id, { commandName: 'modlog', client: { users: usersOf() } });
  const [missing] = unknown.calls.replies[0].embeds.map((embed) => embed.toJSON());
  assert.match(missing.description, /\*\*Username:\*\* Not available/);
  await assert.rejects(command(guild, mod, '123456789012345678', { commandName: 'modlog', client: { users: usersOf() } }), /User not found/);
});

test('/modlog page buttons keep the user information', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  for (let index = 0; index < 7; index++) await moderation.warn({ guild, moderator: mod, target: target(victim), reason: `r${index}` });
  const first = (await command(guild, mod, victim.id, { commandName: 'modlog', client: { users: usersOf(victim) } })).calls.replies[0];
  const next = first.components[0].toJSON().components[1].custom_id;
  const updates = [];
  await modlog.handleComponent({ ...makeInteraction({ guild, member: mod, customId: next, message: { embeds: first.embeds } }), update: async (payload) => updates.push(payload) });
  const [info, history] = updates[0].embeds.map((embed) => embed.toJSON?.() ?? embed);
  assert.equal(info.title, 'User Information');
  assert.deepEqual(history.fields.map((field) => field.name.match(/Case #(\d+)/)[1]), ['2', '1']);
});

test('/case and /modlog require Moderator or higher', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  await moderation.warn({ guild, moderator: mod, target: target(victim), reason: 'r' });
  const route = async (member, commandName, value) => {
    const replies = [];
    await interactionCreate.execute({
      ...makeInteraction({ guild, member }),
      commandName,
      client: { commands: new Collection([['case', caseCommand], ['modlog', modlog]]), components: new Collection(), users: usersOf(victim) },
      options: { getString: () => value },
      isChatInputCommand: () => true,
      isMessageComponent: () => false,
      isModalSubmit: () => false,
      inCachedGuild: () => true,
      reply: async (payload) => replies.push(payload.embeds[0].toJSON()),
      editReply: async (payload) => replies.push(payload.embeds[0].toJSON()),
    });
    return replies.at(-1);
  };
  for (const role of [null, ROLES.SUPPORT]) {
    assert.match((await route(makeMember(role), 'case', '1')).description, /do not have permission/);
    assert.match((await route(makeMember(role), 'modlog', victim.id)).description, /do not have permission/);
  }
  assert.equal((await route(makeMember(ROLES.MODERATOR), 'case', '1')).title, 'Case #1');
  assert.equal((await route(makeMember(ROLES.MODERATOR), 'modlog', victim.id)).title, 'User Information');
});

test('AutoMod punishments and expired bans get cases with stored names', async () => {
  const { guild, mod } = setup();
  const member = join(guild, { globalName: 'Spammer' });
  const warning = moderation.automodWarn({ guild, userId: member.id, member, functionId: 'antispam', reason: 'Spam detection', channelId: 'c' });
  const mute = await moderation.automodMute({ guild, member, duration: '1h', functionId: 'antispam', reason: 'Spam detection', channelId: 'c' });
  assert.deepEqual([warning.case_number, mute.case_number], [1, 2]);
  assert.deepEqual([warning.user_name, warning.user_display_name, warning.moderator_id], [member.user.username, 'Spammer', BOT_ID]);
  const log = automodMessages.violationLog(member, { id: 'c' }, { fn: { name: 'Anti-Spam', id: 'antispam', reason: 'Spam' }, level: 3, action: { delete: false }, deleted: 0, warning, mute, dmSent: true, errors: [], detail: 'd' }).toJSON();
  const action = log.fields.find((field) => field.name === 'Action').value;
  assert.match(action, /WARN \(record #\d+\) • Case #1/);
  assert.match(action, /TIMEOUT 1 hour \(record #\d+\) • Case #2/);

  const banned = join(guild, { globalName: 'Temp' });
  const { record } = await moderation.ban({ guild, moderator: mod, target: target(banned), duration: '1d', reason: 'r' });
  await tempBans.sweep({ user: { id: BOT_ID }, guilds: { cache: new Map([[guild.id, guild]]) } }, record.expires_at + DAY);
  const [unban] = punishments.listByUser(guild.id, banned.id, 1);
  assert.deepEqual([unban.type, unban.case_number, unban.user_name, unban.user_display_name], ['unban', 4, banned.user.username, 'Temp']);
});

test('existing punishments get deterministic case numbers without losing any record', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  database.migrations.slice(0, 11).forEach((sql) => db.exec(sql));
  db.pragma('user_version = 11');
  const insert = db.prepare('INSERT INTO punishments (type, guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('warn', 'A', 'u1', 'm', 'a1', 10);
  insert.run('mute', 'B', 'u2', 'm', 'b1', 11);
  insert.run('clear', 'A', null, 'm', null, 12);
  insert.run('ban', 'A', 'u1', 'm', 'a2', 13);
  insert.run('kick', 'B', 'u3', 'm', 'b2', 14);
  insert.run('warn', 'A', 'u4', 'm', 'a3', 15);
  db.close();

  database.open(legacy);
  try {
    const rows = database.get().prepare('SELECT guild_id, type, reason, case_number FROM punishments ORDER BY id').all().map((row) => ({ ...row }));
    assert.deepEqual(rows.map((row) => [row.guild_id, row.type, row.case_number]), [
      ['A', 'warn', 1],
      ['B', 'mute', 1],
      ['A', 'clear', null],
      ['A', 'ban', 2],
      ['B', 'kick', 2],
      ['A', 'warn', 3],
    ]);
    assert.equal(rows.length, 6, 'nothing is lost');
    assert.equal(punishments.create({ type: 'warn', guildId: 'A', userId: 'u9', moderatorId: 'm', reason: 'next' }).case_number, 4);
    assert.equal(punishments.create({ type: 'warn', guildId: 'B', userId: 'u9', moderatorId: 'm', reason: 'next' }).case_number, 3);
    assert.equal(punishments.create({ type: 'warn', guildId: 'C', userId: 'u9', moderatorId: 'm', reason: 'new' }).case_number, 1);
    assert.equal(punishments.findByCase('A', 2).reason, 'a2');
    assert.equal(punishments.countByUser('A', 'u1'), 2);
  } finally {
    database.open(file);
  }
});
