const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const database = require('../src/database');
const guildSettings = require('../src/database/guildSettings');
const verificationPanels = require('../src/database/verificationPanels');
const verifications = require('../src/database/verifications');
const embedBuilder = require('../src/services/embedBuilder');
const verification = require('../src/services/verification');
const createverify = require('../src/commands/createverify');
const verifyCommand = require('../src/commands/verify');
const verifyinfo = require('../src/commands/verifyinfo');
const verifyButton = require('../src/components/verify');
const interactionCreate = require('../src/events/interactionCreate');
const { ROLES } = require('../src/permissions');
const { makeGuild, makeInteraction, makeMember, snowflake, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
const MEMBER_ROLE = '1555596685462479048';
const API_KEY = 'test-rover-key';

const respond = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body });

const fakeRover = () => {
  const rover = { accounts: {}, failure: null, offline: false, calls: [] };
  rover.fetch = async (url, options = {}) => {
    rover.calls.push({ url, authorization: options.headers?.authorization });
    if (rover.offline) throw new Error('getaddrinfo ENOTFOUND registry.rover.link');
    if (rover.failure) return respond(rover.failure.status, rover.failure.body ?? { errorCode: 'error', message: 'Error' }, rover.failure.headers);
    const [, guildId, discordId] = url.match(/\/guilds\/(\d+)\/discord-to-roblox\/(\d+)$/);
    const account = rover.accounts[discordId];
    return account
      ? respond(200, { robloxId: Number(account.id), cachedUsername: account.username, discordId, guildId })
      : respond(404, { errorCode: 'user_not_found', message: 'User not found' });
  };
  return rover;
};

const setup = ({ roles = [MEMBER_ROLE] } = {}) => {
  const guild = makeGuild({ roles });
  guildSettings.enableLogs(guild.id, guild.logChannel.id);
  const rover = fakeRover();
  verification.configure({ apiKey: API_KEY, fetch: rover.fetch });
  return { guild, rover };
};

const join = (guild, options = {}) => {
  const member = makeMember(null, { globalName: 'Whitee', ...options });
  guild.members.cache.set(member.id, member);
  return member;
};

const press = async (guild, member, customId = 'verify:start', message = { id: 'panel-message' }) => {
  const interaction = makeInteraction({ guild, member, customId, message });
  await verifyButton.execute(interaction);
  return { interaction, reply: interaction.calls.replies.at(-1) };
};

const runVerify = async (guild, member) => {
  const interaction = makeInteraction({ guild, member });
  await interactionCreate.execute({
    ...interaction,
    commandName: 'verify',
    client: { commands: new Collection([['verify', verifyCommand]]), components: new Collection() },
    isChatInputCommand: () => true,
    isMessageComponent: () => false,
    isModalSubmit: () => false,
    inCachedGuild: () => true,
  });
  return { interaction, reply: interaction.calls.replies.at(-1) };
};

const embedOf = (reply) => reply.embeds[0].toJSON();
const buttonsOf = (reply) => reply.components.flatMap((row) => row.toJSON().components);

const later = (() => {
  let now = Date.now();
  return () => (now += 60_000);
})();

test.before(() => database.open(file));
test.after(() => database.close());

test('/createverify standard sends the default panel to the selected channel', async () => {
  const { guild } = setup();
  const channel = await guild.channels.create({ name: 'verify' });
  const owner = makeMember(ROLES.CREATOR);
  const interaction = {
    ...makeInteraction({ guild, member: owner }),
    options: { getChannel: () => ({ id: channel.id }), getString: () => 'standard' },
  };

  await createverify.execute(interaction);
  const [message] = channel.sent;
  const embed = message.embeds[0].toJSON();
  assert.equal(embed.title, 'Roblox Verification');
  assert.match(embed.description, /Verify your Roblox account to gain access to the server\./);
  assert.match(embed.description, /Click the button below to connect your Roblox account with your Discord account\./);
  const [button] = message.components[0].toJSON().components;
  assert.deepEqual([button.custom_id, button.label], ['verify:start', 'Verify with Roblox']);

  const panel = verificationPanels.findByMessage(message.id);
  assert.deepEqual([panel.channel_id, panel.type, panel.created_by, panel.guild_id], [channel.id, 'standard', owner.id, guild.id]);
  assert.match(interaction.calls.replies[0].embeds[0].data.description, new RegExp(`sent to <#${channel.id}>`));
});

test('/createverify custom opens a private editor and always keeps the verify button', async () => {
  const { guild } = setup();
  const channel = await guild.channels.create({ name: 'start-here' });
  const owner = makeMember(ROLES.CREATOR);
  const opened = [];
  const interaction = {
    ...makeInteraction({ guild, member: owner }),
    options: { getChannel: () => ({ id: channel.id }), getString: () => 'custom' },
    reply: async (payload) => opened.push(payload),
  };

  await createverify.execute(interaction);
  assert.equal(channel.sent.length, 0, 'nothing is sent before confirmation');
  const [panel] = opened;
  assert.ok(panel.flags, 'the editor is ephemeral');
  assert.match(panel.content, /Verification Panel Builder/);
  assert.equal(panel.embeds[0].toJSON().title, 'Roblox Verification', 'the editor starts from the standard template');

  const action = (name, extra = {}) => ({
    customId: `createverify:${interaction.id}:${name}`,
    user: owner.user,
    member: owner,
    guild,
    values: extra.values ?? [],
    calls: [],
    fields: { getTextInputValue: (id) => extra.fields?.[id] ?? '', getStringSelectValues: () => extra.select ?? [] },
    update: async (payload) => extra.calls?.push(payload),
    reply: async (payload) => extra.calls?.push(payload),
    showModal: async (payload) => extra.calls?.push(payload),
  });

  await createverify.handleComponent(action('modal:body', { fields: { title: 'Welcome', description: 'Link your account', color: '#00ff00' } }));
  await createverify.handleComponent(action('field:new', { fields: { name: 'Why?', value: 'To access the server' }, select: ['no'] }));
  await createverify.handleComponent(action('modal:content', { fields: { content: 'Please verify below.' } }));

  const preview = [];
  await createverify.handleComponent(action('preview', { calls: preview }));
  assert.equal(preview[0].embeds[0].toJSON().title, 'Welcome');

  const sent = [];
  await createverify.handleComponent(action('send', { calls: sent }));
  assert.match(sent[0].content, /Verification Panel Builder: sent to/);

  const [message] = channel.sent;
  assert.equal(message.content, 'Please verify below.');
  const embed = message.embeds[0].toJSON();
  assert.deepEqual([embed.title, embed.description, embed.color], ['Welcome', 'Link your account', 0x00ff00]);
  assert.deepEqual(embed.fields, [{ name: 'Why?', value: 'To access the server', inline: false }]);
  assert.deepEqual(message.components[0].toJSON().components.map((button) => button.custom_id), ['verify:start']);
  assert.equal(verificationPanels.findByMessage(message.id).type, 'custom');

  const cleared = await embedBuilder.start(
    { id: snowflake(), user: owner.user, reply: async (payload) => payload },
    { prefix: 'createverify', channel, deliver: (target, payload) => verification.publishPanel(target, payload, { type: 'custom', createdBy: owner.id }) },
  );
  assert.ok(cleared.components.length > 0);
});

test('nicknames keep the full Roblox username within the Discord limit', () => {
  assert.equal(verification.buildNickname('Whitee', 'Whitee123'), 'Whitee (@Whitee123)');
  assert.equal(verification.buildNickname('Whitee', 'cool_player123'), 'Whitee (@cool_player123)');

  const long = verification.buildNickname('A very long Discord display name', 'twenty_characters_12');
  assert.equal(long, 'A very… (@twenty_characters_12)');
  assert.ok([...long].length <= 32);
  assert.equal([...verification.buildNickname('Abcdefghijklmnop', 'twenty_characters_12')].length, 32);

  const emoji = verification.buildNickname('🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮', 'player_name_long_123');
  assert.ok([...emoji].length <= 32);
  assert.ok(!emoji.includes('�'));
});

test('verification data is unique per Discord and Roblox account at the database level', () => {
  const insert = (discordId, robloxId) =>
    database.get().prepare('INSERT INTO verifications (discord_id, roblox_id, roblox_username, verified_at) VALUES (?, ?, ?, ?)').run(discordId, robloxId, 'name', 1);
  insert('unique-discord', 'unique-roblox');
  assert.throws(() => insert('unique-discord', 'another-roblox'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
  assert.throws(() => insert('another-discord', 'unique-roblox'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });

  assert.equal(verifications.link({ discordId: 'unique-discord', robloxId: 'unique-roblox', robloxUsername: 'x' }).status, 'already-verified');
  assert.equal(verifications.link({ discordId: 'unique-discord', robloxId: 'other', robloxUsername: 'x' }).status, 'discord-linked');
  assert.equal(verifications.link({ discordId: 'someone-else', robloxId: 'unique-roblox', robloxUsername: 'x' }).status, 'roblox-linked');
});

test('/verifyinfo shows the linked Roblox account', async () => {
  const user = { id: '424242424242424242' };
  verifications.link({ discordId: user.id, robloxId: '9999', robloxUsername: 'info_user', verifiedAt: Date.UTC(2026, 0, 1) });
  const replies = [];
  const interaction = {
    client: { users: { fetch: async (id) => ({ id }) } },
    options: { getString: () => `<@${user.id}>` },
    deferReply: async () => {},
    editReply: async (payload) => replies.push(payload.embeds[0].toJSON()),
  };

  await verifyinfo.execute(interaction);
  const fields = Object.fromEntries(replies[0].fields.map((field) => [field.name, field.value]));
  assert.deepEqual(Object.keys(fields), ['Discord user', 'Roblox username', 'Roblox ID', 'Verification date']);
  assert.match(fields['Roblox username'], /info_user/);
  assert.equal(fields['Roblox ID'], '`9999`');

  interaction.options.getString = () => '434343434343434343';
  await verifyinfo.execute(interaction);
  assert.match(replies[1].description, /is not verified/);
});

test('the verify button finds the Roblox account through RoVer and links it with the Member role and nickname', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  rover.accounts[member.id] = { id: '1001', username: 'cool_player123' };

  const { interaction, reply } = await press(guild, member);
  assert.deepEqual(rover.calls, [{ url: `https://registry.rover.link/api/guilds/${guild.id}/discord-to-roblox/${member.id}`, authorization: `Bearer ${API_KEY}` }]);
  assert.ok(interaction.calls.deferred.flags, 'the answer is private');

  const embed = embedOf(reply);
  assert.equal(embed.title, 'Verification successful');
  assert.match(embed.description, /Roblox username: cool_player123\nRoblox ID: 1001/);
  assert.match(embed.description, /You have been given the Member role\.\nYour server nickname has been updated\./);
  assert.ok(member.roles.cache.has(MEMBER_ROLE));
  assert.equal(member.nickname, 'Whitee (@cool_player123)');

  const stored = verifications.findByDiscord(member.id);
  assert.deepEqual([stored.roblox_id, stored.roblox_username, stored.roblox_display_name, stored.guild_id], ['1001', 'cool_player123', null, guild.id]);
  assert.equal(stored.expires_at - stored.verified_at, verification.RETENTION);

  const log = embedOf(guild.logChannel.sent.at(-1));
  assert.equal(log.title, 'Verification • Roblox account linked');
  assert.ok(!JSON.stringify([embed, log]).includes(API_KEY), 'the API key is never shown');
});

test('members who are not verified with RoVer or did not grant access get instructions and a Check again button', async () => {
  for (const failure of [null, { status: 403, body: { errorCode: 'forbidden', message: 'No access' } }]) {
    const { guild, rover } = setup();
    rover.failure = failure;
    const member = join(guild);

    const { reply } = await press(guild, member);
    const embed = embedOf(reply);
    assert.match(embed.description, /RoVer has not shared a Roblox account with this server for you yet/);
    assert.match(embed.description, /`\/verify` command of the \*\*RoVer\*\* bot/);
    assert.match(embed.description, /`\/privacy`/);
    assert.deepEqual(buttonsOf(reply).map((button) => [button.custom_id, button.label]), [['verify:check', 'Check again']]);
    assert.equal(verifications.findByDiscord(member.id), undefined);
    assert.ok(!member.roles.cache.has(MEMBER_ROLE));
  }
});

test('Check again verifies after the member grants access, updating the same private message', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  const first = makeInteraction({ guild, member, customId: 'verify:start' });
  await verification.start(first, { now: later() });

  rover.accounts[member.id] = { id: '1002', username: 'granted_user' };
  const check = makeInteraction({ guild, member, customId: 'verify:check' });
  await verification.start(check, { update: true, now: later() });
  assert.equal(check.calls.deferred, 'update');
  assert.equal(embedOf(check.calls.replies[0]).title, 'Verification successful');
  assert.deepEqual(check.calls.replies[0].components, [], 'the Check again button is removed');
  assert.equal(member.nickname, 'Whitee (@granted_user)');

  const { reply } = await press(guild, join(guild), 'verify:check');
  assert.match(embedOf(reply).description, /has not shared a Roblox account/, 'the button itself is wired');
});

test('checks have a per-member cooldown so RoVer is never polled', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  const now = later();

  await verification.start(makeInteraction({ guild, member }), { now });
  await assert.rejects(verification.start(makeInteraction({ guild, member }), { update: true, now: now + 5_000 }), /wait a few seconds/);
  assert.equal(rover.calls.length, 1);

  await verification.start(makeInteraction({ guild, member: join(guild) }), { now: now + 5_000 });
  assert.equal(rover.calls.length, 2, 'other members are not affected');

  await verification.start(makeInteraction({ guild, member }), { update: true, now: now + 10_000 });
  assert.equal(rover.calls.length, 3);
});

test('a 429 from RoVer pauses every lookup until the rate limit resets', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  const now = later();
  rover.failure = { status: 429, body: { errorCode: 'ratelimit', message: 'Too many requests' }, headers: { 'retry-after': '30' } };

  const blocked = makeInteraction({ guild, member });
  await verification.start(blocked, { now });
  assert.equal(embedOf(blocked.calls.replies[0]).title, 'Too many requests');
  assert.match(embedOf(blocked.calls.replies[0]).description, new RegExp(`<t:${Math.ceil((now + 30_000) / 1000)}:R>`));

  rover.failure = null;
  await assert.rejects(verification.start(makeInteraction({ guild, member: join(guild) }), { now: now + 29_000 }), /too many requests/);
  assert.equal(rover.calls.length, 1, 'no request is sent while rate limited');

  rover.accounts[member.id] = { id: '1003', username: 'patient_user' };
  const retry = makeInteraction({ guild, member });
  await verification.start(retry, { now: now + 30_000 });
  assert.equal(embedOf(retry.calls.replies[0]).title, 'Verification successful');
});

test('a rejected API key, outages and invalid responses are reported without linking or exposing the key', async () => {
  const cases = [
    [{ status: 401, body: { errorCode: 'invalid_api_key', message: 'Invalid' } }, 'RoVer rejected ROVER_API_KEY. Check the key in .env.'],
    [{ status: 500, body: { message: 'Internal' } }, 'RoVer lookup failed: RoVer responded with 500'],
    ['offline', 'RoVer lookup failed: RoVer could not be reached: getaddrinfo ENOTFOUND registry.rover.link'],
    [{ status: 200, body: { robloxId: 5, cachedUsername: 'bad name!' } }, 'RoVer lookup failed: RoVer returned an invalid Roblox account'],
  ];
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    for (const [failure, logged] of cases) {
      const { guild, rover } = setup();
      if (failure === 'offline') rover.offline = true;
      else rover.failure = failure;
      const member = join(guild);

      const { reply } = await press(guild, member);
      assert.equal(embedOf(reply).title, 'Verification unavailable');
      assert.equal(errors.at(-1), logged);
      assert.equal(verifications.findByDiscord(member.id), undefined);
    }
  } finally {
    console.error = original;
  }
  assert.ok(!errors.join(' ').includes(API_KEY));
});

test('a Roblox account linked to another Discord account is rejected without revealing it', async () => {
  const { guild, rover } = setup();
  const owner = join(guild);
  const member = join(guild);
  rover.accounts[owner.id] = { id: '1004', username: 'taken_account' };
  rover.accounts[member.id] = { id: '1004', username: 'taken_account' };
  await press(guild, owner);

  const { reply } = await press(guild, member);
  const embed = embedOf(reply);
  assert.equal(embed.title, 'Verification failed');
  assert.equal(embed.description, 'This Roblox account is already linked to another Discord account.');
  assert.ok(!embed.description.includes(owner.id));
  assert.equal(verifications.findByDiscord(member.id), undefined);
});

test('already verified members see their linked account without a new lookup', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  rover.accounts[member.id] = { id: '1005', username: 'linked_user' };
  await press(guild, member);

  const { reply } = await press(guild, member);
  assert.ok(reply.flags);
  assert.equal(embedOf(reply).title, 'You are already verified');
  assert.match(embedOf(reply).description, /linked_user/);
  assert.equal(rover.calls.length, 1);
});

test('role and nickname failures do not undo a successful verification', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  rover.accounts[member.id] = { id: '1006', username: 'no_perms_user' };
  member.roles.add = async () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013 }));
  member.setNickname = async () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013 }));

  const original = console.error;
  console.error = () => {};
  let reply;
  try {
    ({ reply } = await press(guild, member));
  } finally {
    console.error = original;
  }
  const lines = embedOf(reply).description.split('\n');
  assert.equal(embedOf(reply).title, 'Verification successful');
  assert.match(lines[3], /Member role could not be assigned: The bot is missing the Manage Roles permission/);
  assert.match(lines[4], /nickname could not be updated: The bot is missing the Manage Nicknames permission/);
  assert.ok(verifications.findByDiscord(member.id));

  const { guild: noRole, rover: other } = setup({ roles: [] });
  const second = join(noRole);
  other.accounts[second.id] = { id: '1007', username: 'role_missing' };
  const missing = embedOf((await press(noRole, second)).reply).description;
  assert.match(missing, /Member role no longer exists/);
  assert.equal(second.nickname, 'Whitee (@role_missing)');
});

test('the server owner verifies even though Discord blocks owner nickname changes', async () => {
  const { guild, rover } = setup();
  const owner = join(guild);
  guild.ownerId = owner.id;
  rover.accounts[owner.id] = { id: '1008', username: 'owner_account' };

  const { reply } = await press(guild, owner);
  assert.ok(owner.roles.cache.has(MEMBER_ROLE));
  assert.match(embedOf(reply).description, /does not allow bots to change the server owner's nickname/);
});

test('multiple verification panels work independently and after a restart', async () => {
  const { guild, rover } = setup();
  const owner = makeMember(ROLES.CREATOR).id;
  const panels = [];
  for (const name of ['verification', 'start-here', 'verify']) {
    const channel = await guild.channels.create({ name });
    panels.push(await verification.publishPanel(channel, { embeds: [] }, { type: 'standard', createdBy: owner }));
  }
  assert.equal(new Set(panels.map((panel) => panel.channel_id)).size, 3);

  database.close();
  database.open(file);
  for (const panel of panels) assert.equal(verificationPanels.findByMessage(panel.message_id).id, panel.id);

  for (const panel of [...panels, { message_id: 'deleted-message' }]) {
    const member = join(guild);
    rover.accounts[member.id] = { id: String(1100 + rover.calls.length), username: `panel_user_${rover.calls.length}` };
    const { reply } = await press(guild, member, 'verify:start', { id: panel.message_id });
    assert.equal(embedOf(reply).title, 'Verification successful');
  }
});

test('verification is disabled cleanly when ROVER_API_KEY is not set', async () => {
  assert.equal(verification.configure({}), false);
  assert.equal(verification.configure({ apiKey: '' }), false);
  assert.equal(verification.isConfigured(), false);

  const guild = makeGuild();
  await assert.rejects(press(guild, join(guild)), /not configured/);
});

test('/verify can be used by every member, staff or not', async () => {
  const { guild, rover } = setup();
  const ranks = [null, MEMBER_ROLE, ROLES.SUPPORT, ROLES.MODERATOR, ROLES.SENIOR_MODERATOR, ROLES.ADMINISTRATOR, ROLES.CREATOR];
  for (const role of ranks) {
    const member = makeMember(role, { globalName: 'Whitee' });
    guild.members.cache.set(member.id, member);
    const { interaction, reply } = await runVerify(guild, member);
    assert.ok(interaction.calls.deferred.flags, `${role}: private reply`);
    assert.deepEqual(buttonsOf(reply).map((button) => button.custom_id), ['verify:check:relink'], `${role}: asked to use RoVer`);
  }
  assert.equal(rover.calls.length, ranks.length);
});

test('/verify replaces the linked Roblox account with the one RoVer now reports', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  rover.accounts[member.id] = { id: '1201', username: 'old_account' };
  await verification.start(makeInteraction({ guild, member }), { now: later() });

  rover.accounts[member.id] = { id: '1202', username: 'new_account' };
  const relink = makeInteraction({ guild, member });
  await verification.start(relink, { replace: true, now: later() });
  const embed = embedOf(relink.calls.replies[0]);
  assert.equal(embed.title, 'Roblox account updated');
  assert.match(embed.description, /^Roblox username: new_account\nRoblox ID: 1202\nPrevious Roblox account: old_account/);

  const stored = verifications.findByDiscord(member.id);
  assert.deepEqual([stored.roblox_id, stored.roblox_username], ['1202', 'new_account']);
  assert.equal(verifications.findByRoblox('1201'), undefined, 'the previous Roblox account is released');
  assert.equal(member.nickname, 'Whitee (@new_account)');
  assert.equal(embedOf(guild.logChannel.sent.at(-1)).title, 'Verification • Roblox account changed');

  const same = makeInteraction({ guild, member });
  await verification.start(same, { replace: true, now: later() });
  assert.equal(embedOf(same.calls.replies[0]).title, 'You are already verified');
});

test('/verify rejects a Roblox account linked to another Discord account and keeps the current link', async () => {
  const { guild, rover } = setup();
  const owner = join(guild);
  const member = join(guild);
  rover.accounts[owner.id] = { id: '1301', username: 'taken_account' };
  rover.accounts[member.id] = { id: '1302', username: 'my_account' };
  await press(guild, owner);
  await press(guild, member);
  const before = verifications.findByDiscord(member.id);

  rover.accounts[member.id] = { id: '1301', username: 'taken_account' };
  const attempt = makeInteraction({ guild, member });
  await verification.start(attempt, { replace: true, now: later() });
  assert.equal(embedOf(attempt.calls.replies[0]).description, 'This Roblox account is already linked to another Discord account.\nYour current verification (my_account) was not changed.');
  assert.deepEqual(verifications.findByDiscord(member.id), before);
  assert.equal(member.nickname, 'Whitee (@my_account)');
});

test('data from RoVer expires after the retention period and is refreshed by a new verification', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  rover.accounts[member.id] = { id: '1401', username: 'retained_user' };
  const now = later();
  await verification.start(makeInteraction({ guild, member }), { now });
  verifications.link({ discordId: 'legacy-oauth-user', robloxId: 'legacy-roblox', robloxUsername: 'legacy' });

  verification.cleanup(now + verification.RETENTION - 1);
  assert.ok(verifications.findByDiscord(member.id));
  await verification.start(makeInteraction({ guild, member }), { replace: true, now: now + 60_000 });
  assert.equal(verifications.findByDiscord(member.id).expires_at, now + 60_000 + verification.RETENTION, 'a new lookup refreshes the expiry');

  verification.cleanup(now + 60_000 + verification.RETENTION);
  assert.equal(verifications.findByDiscord(member.id), undefined);
  assert.equal(verifications.findByRoblox('1401'), undefined);
  assert.ok(verifications.findByDiscord('legacy-oauth-user'), 'links made before RoVer have no expiry');
  assert.ok(member.roles.cache.has(MEMBER_ROLE), 'the Member role stays');
});

