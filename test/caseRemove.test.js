const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { Collection } = require('discord.js');
const database = require('../src/database');
const guildSettings = require('../src/database/guildSettings');
const punishments = require('../src/database/punishments');
const caseCommand = require('../src/commands/case');
const caseremove = require('../src/commands/caseremove');
const modlog = require('../src/commands/modlog');
const interactionCreate = require('../src/events/interactionCreate');
const moderation = require('../src/services/moderation');
const { ROLES } = require('../src/permissions');
const { apiError, makeGuild, makeInteraction, makeMember, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();

test.before(() => database.open(file));
test.after(() => database.close());

const setup = () => {
  const guild = makeGuild();
  guildSettings.enableLogs(guild.id, guild.logChannel.id);
  return { guild, mod: makeMember(ROLES.MODERATOR), admin: makeMember(ROLES.ADMINISTRATOR) };
};

const join = (guild) => {
  const member = makeMember(null);
  guild.members.cache.set(member.id, member);
  return member;
};

const history = async (guild, mod, victim) => {
  const target = { user: victim.user, member: victim };
  await moderation.warn({ guild, moderator: mod, target, reason: 'Flood' });
  await moderation.mute({ guild, moderator: mod, target, duration: '10m', reason: 'Spam' });
  await moderation.ban({ guild, moderator: mod, target: { user: victim.user, member: null }, duration: 'forever', reason: 'Raid' });
};

const remove = async (guild, member, user, value) => {
  const interaction = { ...makeInteraction({ guild, member }), options: { getString: (name) => ({ user, case: value })[name] } };
  await caseremove.execute(interaction);
  return interaction.calls.replies.at(-1).embeds[0].data.description;
};

const showCase = async (guild, member, value) => {
  const interaction = { ...makeInteraction({ guild, member }), options: { getString: () => value } };
  await caseCommand.execute(interaction);
  return interaction.calls.replies.at(-1).embeds[0].toJSON();
};

const modlogCases = (guild, userId) => (modlog.render(guild.id, userId, 0).embeds[0].toJSON().fields ?? []).map((field) => Number(field.name.match(/Case #(\d+)/)[1]));

const logged = (guild) => guild.logChannel.sent.map((message) => message.embeds[0].toJSON());

const quiet = async (task) => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try {
    return { result: await task(), lines };
  } finally {
    console.error = original;
  }
};

test('/caseremove hides one case from /modlog without changing or deleting it', async () => {
  const { guild, mod, admin } = setup();
  const victim = join(guild);
  await history(guild, mod, victim);
  const before = punishments.findByCase(guild.id, 2);
  const cases = punishments.countCases(guild.id);

  const reply = await remove(guild, admin, `<@${victim.id}>`, '2');
  assert.equal(reply, `✅ Case #2 of <@${victim.id}> removed from the modlog. It is still available with /case 2.`);
  assert.deepEqual(modlogCases(guild, victim.id), [3, 1]);

  const after = punishments.findByCase(guild.id, 2);
  assert.ok(after, 'the case still exists');
  assert.deepEqual([after.removed_by, after.removed_by_name], [admin.id, admin.user.username]);
  assert.ok(after.removed_at >= before.created_at);
  const original = ({ removed_at, removed_by, removed_by_name, ...rest }) => rest;
  assert.deepEqual(original(after), original(before), 'action, user, moderator, reason, date and case number are unchanged');
  assert.equal(punishments.countCases(guild.id), cases, 'no new case is created');
});

test('/case still shows a removed case, who removed it and when', async () => {
  const { guild, mod, admin } = setup();
  const victim = join(guild);
  await history(guild, mod, victim);
  await remove(guild, admin, victim.id, '3');
  const removed = punishments.findByCase(guild.id, 3);

  const embed = await showCase(guild, mod, '3');
  assert.equal(embed.title, 'Case #3');
  for (const line of [
    '**Action:** 🔨 Ban',
    `**Moderator:** <@${mod.id}> • ${mod.user.username}`,
    '**Reason:** Raid',
    '**Status:** Removed from Modlog',
    `**Removed by:** <@${admin.id}> • ${admin.user.username}`,
    `**Removed at:** <t:${Math.floor(removed.removed_at / 1000)}:f>`,
  ]) assert.ok(embed.description.includes(line), line);
  assert.match(embed.description, new RegExp(`\\*\\*Date:\\*\\* <t:${Math.floor(removed.created_at / 1000)}:f>`), 'the original date is kept');
  assert.doesNotMatch((await showCase(guild, mod, '1')).description, /Removed from Modlog/);
});

test('/caseremove works with a user ID for users who left the server', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  await history(guild, mod, victim);
  guild.members.cache.delete(victim.id);
  guild.members.fetch = async () => assert.fail('the member is not needed');

  await remove(guild, mod, victim.id, '#1');
  assert.deepEqual(modlogCases(guild, victim.id), [3, 2]);
  await assert.rejects(remove(guild, mod, 'not-a-user', '1'), /Invalid user/);
  await assert.rejects(remove(guild, mod, victim.id, 'abc'), /Provide a case number/);
});

test('/caseremove rejects missing cases, cases of another user and cases of another server', async () => {
  const first = setup();
  const second = setup();
  const maria = join(first.guild);
  const joao = join(first.guild);
  await history(first.guild, first.mod, maria);
  const outsider = join(second.guild);
  for (let index = 0; index < 5; index++) await moderation.warn({ guild: second.guild, moderator: second.mod, target: { user: outsider.user, member: outsider }, reason: 'r' });

  await assert.rejects(remove(first.guild, first.mod, joao.id, '2'), new RegExp(`Case #2 does not belong to <@${joao.id}>`));
  assert.equal(punishments.findByCase(first.guild.id, 2).removed_at, null);
  await assert.rejects(remove(first.guild, first.mod, maria.id, '99'), /Case #99 does not exist in this server/);
  await assert.rejects(remove(first.guild, first.mod, outsider.id, '5'), /Case #5 does not exist in this server/);
  assert.equal(punishments.findByCase(second.guild.id, 5).removed_at, null, 'the other server is untouched');
  await assert.rejects(remove(first.guild, first.mod, outsider.id, 'all'), new RegExp(`<@${outsider.id}> has no cases in this server`));
  assert.deepEqual(modlogCases(second.guild, outsider.id), [5, 4, 3, 2, 1]);
});

test('removing an already removed case changes nothing', async () => {
  const { guild, mod, admin } = setup();
  const victim = join(guild);
  await history(guild, mod, victim);
  await remove(guild, mod, victim.id, '1');
  const first = punishments.findByCase(guild.id, 1);
  const logs = guild.logChannel.sent.length;

  await assert.rejects(remove(guild, admin, victim.id, '1'), /Case #1 was already removed from the modlog/);
  assert.deepEqual(punishments.findByCase(guild.id, 1), first);
  assert.equal(guild.logChannel.sent.length, logs);
});

test('/caseremove all hides every case of that user only, and keeps them in /case', async () => {
  const { guild, mod, admin } = setup();
  const victim = join(guild);
  const other = join(guild);
  await history(guild, mod, victim);
  await moderation.warn({ guild, moderator: mod, target: { user: other.user, member: other }, reason: 'Other' });
  await remove(guild, mod, victim.id, '2');
  const firstRemoval = punishments.findByCase(guild.id, 2);

  const reply = await remove(guild, admin, `<@${victim.id}>`, 'ALL');
  assert.equal(reply, `✅ 2 cases of <@${victim.id}> removed from the modlog. They are still available with /case.`);
  assert.deepEqual(modlogCases(guild, victim.id), []);
  assert.match(modlog.render(guild.id, victim.id, 0).embeds[0].data.description, /No punishments recorded/);
  assert.deepEqual(modlogCases(guild, other.id), [4]);
  assert.deepEqual(punishments.findByCase(guild.id, 2), firstRemoval, 'the earlier removal keeps its author and time');
  for (const number of [1, 3]) {
    const record = punishments.findByCase(guild.id, number);
    assert.equal(record.removed_by, admin.id);
    assert.match((await showCase(guild, mod, String(number))).description, /Removed from Modlog/);
  }
  assert.equal(punishments.countCases(guild.id), 4);
  await assert.rejects(remove(guild, admin, victim.id, 'all'), new RegExp(`All cases of <@${victim.id}> were already removed`));
});

test('/case all still lists removed cases and marks them', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  await history(guild, mod, victim);
  await remove(guild, mod, victim.id, '2');
  const interaction = { ...makeInteraction({ guild, member: mod }), options: { getString: () => 'all' } };
  await caseCommand.execute(interaction);
  const names = interaction.calls.replies[0].embeds[0].toJSON().fields.map((field) => field.name);
  assert.deepEqual(names, ['🔨 Case #3 • Ban', '🔇 Case #2 • Mute • Removed from Modlog', '⚠️ Case #1 • Warn']);
});

test('/logs records single removals and one entry for all', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  await history(guild, mod, victim);
  await moderation.warn({ guild, moderator: mod, target: { user: victim.user, member: victim }, reason: 'Again' });
  const before = guild.logChannel.sent.length;

  await remove(guild, mod, victim.id, '3');
  const single = logged(guild).at(-1);
  const removed = punishments.findByCase(guild.id, 3);
  assert.equal(single.title, 'Moderation • Case Removed');
  assert.equal(single.description, [
    '**Case:** #3',
    `**User:** <@${victim.id}> (\`${victim.id}\`)`,
    '**Action:** 🔨 Ban',
    `**Removed by:** <@${mod.id}>`,
    `**Date:** <t:${Math.floor(removed.removed_at / 1000)}:f>`,
  ].join('\n'));

  await remove(guild, mod, victim.id, 'all');
  assert.equal(guild.logChannel.sent.length, before + 2, 'one entry for all');
  const all = logged(guild).at(-1);
  assert.equal(all.title, 'Moderation • Cases Removed');
  assert.match(all.description, /\*\*Cases removed from Modlog:\*\* 3/);
  assert.match(all.description, /\*\*Cases:\*\* #1, #2, #4/);
  assert.match(all.description, new RegExp(`\\*\\*Removed by:\\*\\* <@${mod.id}>`));
});

test('a failed log does not undo the removal', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  await history(guild, mod, victim);
  guild.logChannel.send = async () => Promise.reject(apiError(50013, 403));
  const { lines } = await quiet(async () => {
    await remove(guild, mod, victim.id, '1');
    await remove(guild, mod, victim.id, 'all');
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(modlogCases(guild, victim.id), []);
  for (const number of [1, 2, 3]) assert.ok(punishments.findByCase(guild.id, number).removed_at);
});

test('simultaneous removals leave one consistent removal per case', async () => {
  const { guild, mod, admin } = setup();
  const victim = join(guild);
  await history(guild, mod, victim);
  const results = await Promise.allSettled([
    moderation.removeCase({ guild, moderator: mod, userId: victim.id, caseNumber: 1 }),
    moderation.removeCase({ guild, moderator: admin, userId: victim.id, caseNumber: 1 }),
    moderation.removeUserCases({ guild, moderator: admin, userId: victim.id }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(results[2].value, [2, 3]);
  assert.equal(punishments.findByCase(guild.id, 1).removed_by, mod.id);
  assert.equal(punishments.countCases(guild.id), 3);
});

test('/caseremove requires Moderator or higher', async () => {
  const { guild, mod } = setup();
  const victim = join(guild);
  await history(guild, mod, victim);
  const route = async (member) => {
    const replies = [];
    await interactionCreate.execute({
      ...makeInteraction({ guild, member }),
      commandName: 'caseremove',
      client: { commands: new Collection([['caseremove', caseremove]]), components: new Collection() },
      options: { getString: (name) => ({ user: victim.id, case: '1' })[name] },
      isChatInputCommand: () => true,
      isMessageComponent: () => false,
      isModalSubmit: () => false,
      inCachedGuild: () => true,
      reply: async (payload) => replies.push(payload.embeds[0].data.description),
      editReply: async (payload) => replies.push(payload.embeds[0].data.description),
    });
    return replies.at(-1);
  };
  for (const role of [null, ROLES.SUPPORT]) assert.match(await route(makeMember(role)), /do not have permission/);
  assert.equal(punishments.findByCase(guild.id, 1).removed_at, null);
  assert.match(await route(makeMember(ROLES.MODERATOR)), /Case #1 .* removed from the modlog/);
});

test('migrations number old punishments by creation time and keep every case visible', () => {
  const legacy = tempDatabase();
  const db = new Database(legacy);
  database.migrations.slice(0, 11).forEach((sql) => db.exec(sql));
  db.pragma('user_version = 11');
  const insert = db.prepare('INSERT INTO punishments (type, guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('warn', 'G', 'u', 'm', 'third', 300);
  insert.run('warn', 'G', 'u', 'm', 'first', 100);
  insert.run('warn', 'G', 'u', 'm', 'second-a', 200);
  insert.run('warn', 'G', 'u', 'm', 'second-b', 200);
  db.close();

  database.open(legacy);
  try {
    assert.equal(database.get().pragma('user_version', { simple: true }), database.migrations.length);
    const rows = database.get().prepare('SELECT reason, case_number, removed_at, removed_by FROM punishments ORDER BY case_number').all().map((row) => ({ ...row }));
    assert.deepEqual(rows.map((row) => [row.case_number, row.reason]), [[1, 'first'], [2, 'second-a'], [3, 'second-b'], [4, 'third']]);
    assert.ok(rows.every((row) => row.removed_at === null && row.removed_by === null));
    assert.equal(punishments.countByUser('G', 'u'), 4);
  } finally {
    database.open(file);
  }

  const v12 = tempDatabase();
  const older = new Database(v12);
  database.migrations.slice(0, 12).forEach((sql) => older.exec(sql));
  older.pragma('user_version = 12');
  older.prepare("INSERT INTO punishments (type, guild_id, user_id, moderator_id, created_at, case_number) VALUES ('ban', 'G', 'u', 'm', 1, 7)").run();
  older.close();
  database.open(v12);
  try {
    const record = punishments.findByCase('G', 7);
    assert.deepEqual([record.type, record.removed_at, record.removed_by, record.removed_by_name], ['ban', null, null, null]);
    assert.equal(punishments.countByUser('G', 'u'), 1);
  } finally {
    database.open(file);
  }
});
