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

const JSON_TYPE = 'application/json;charset=UTF-8';

const respond = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': JSON_TYPE, ...headers }),
  json: async () => body,
});

const html = (status) => ({
  ok: false,
  status,
  headers: new Headers({ 'content-type': 'text/html; charset=UTF-8' }),
  json: async () => {
    throw new SyntaxError('Unexpected token < in JSON');
  },
});

const fakeRover = () => {
  const rover = { accounts: {}, requests: new Set(), failure: null, offline: false, calls: [] };
  rover.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    rover.calls.push({ method, url, authorization: options.headers?.authorization });
    if (rover.offline) throw new Error('getaddrinfo ENOTFOUND registry.rover.link');
    const failure = typeof rover.failure === 'function' ? rover.failure(method) : rover.failure;
    if (failure?.html) return html(failure.status);
    if (failure) return respond(failure.status, failure.body ?? { errorCode: 'error', message: 'Error' }, failure.headers);

    const [, guildId, route, discordId] = url.match(/\/guilds\/(\d+)\/(discord-to-roblox|access-requests)\/(\d+)$/);
    const account = rover.accounts[discordId];
    if (route === 'access-requests') {
      if (account) return respond(200, { status: 'already_authorized' });
      if (rover.requests.has(discordId)) return respond(200, { status: 'pending' });
      rover.requests.add(discordId);
      return respond(201, { status: 'pending' });
    }
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
  assert.deepEqual(rover.calls, [{ method: 'GET', url: `https://registry.rover.link/api/guilds/${guild.id}/discord-to-roblox/${member.id}`, authorization: `Bearer ${API_KEY}` }]);
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

test('members without consent get a RoVer access request and a Check again button, and a 403 is not treated as missing consent', async () => {
  const { guild, rover } = setup();
  const member = join(guild);

  const { reply } = await press(guild, member);
  assert.deepEqual(rover.calls.map((call) => `${call.method} ${call.url}`), [
    `GET https://registry.rover.link/api/guilds/${guild.id}/discord-to-roblox/${member.id}`,
    `PUT https://registry.rover.link/api/guilds/${guild.id}/access-requests/${member.id}`,
  ]);
  const embed = embedOf(reply);
  assert.match(embed.description, /RoVer sent you a direct message/);
  assert.match(embed.description, /click \*\*Allow\*\*/);
  assert.deepEqual(buttonsOf(reply).map((button) => [button.custom_id, button.label]), [['verify:check', 'Check again']]);
  assert.equal(verifications.findByDiscord(member.id), undefined);
  assert.ok(!member.roles.cache.has(MEMBER_ROLE));

  const { guild: other, rover: forbidden } = setup();
  forbidden.failure = { status: 403, body: { errorCode: 'forbidden', message: 'No access' } };
  const original = console.error;
  console.error = () => {};
  try {
    const denied = await press(other, join(other));
    assert.equal(embedOf(denied.reply).title, 'Verification unavailable');
  } finally {
    console.error = original;
  }
  assert.deepEqual(forbidden.calls.map((call) => call.method), ['GET'], 'no access request without a documented errorCode');
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
  assert.match(embedOf(reply).description, /RoVer sent you a direct message/, 'the button itself is wired');
});

test('checks have a per-member cooldown so RoVer is never polled', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  const now = later();
  const lookups = () => rover.calls.filter((call) => call.method === 'GET').length;

  await verification.start(makeInteraction({ guild, member }), { now });
  await assert.rejects(verification.start(makeInteraction({ guild, member }), { update: true, now: now + 5_000 }), /wait a few seconds/);
  assert.equal(lookups(), 1);

  await verification.start(makeInteraction({ guild, member: join(guild) }), { now: now + 5_000 });
  assert.equal(lookups(), 2, 'other members are not affected');

  await verification.start(makeInteraction({ guild, member }), { update: true, now: now + 10_000 });
  assert.equal(lookups(), 3);
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
  assert.equal(rover.calls.filter((call) => call.method === 'GET').length, ranks.length);
  assert.equal(rover.calls.filter((call) => call.method === 'PUT').length, ranks.length);
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

const quiet = async (task) => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await task(), lines };
  } finally {
    Object.assign(console, original);
  }
};

const methods = (rover) => rover.calls.map((call) => call.method);

test('access request 201 pending: RoVer is asked once, with an empty body, and the member is told to click Allow', async () => {
  const { guild, rover } = setup();
  const seen = [];
  verification.configure({ apiKey: API_KEY, fetch: (url, options) => seen.push(options) && rover.fetch(url, options) });
  const member = join(guild);

  const interaction = makeInteraction({ guild, member });
  await verification.start(interaction, { now: later() });
  assert.deepEqual(methods(rover), ['GET', 'PUT']);
  assert.equal(rover.calls[1].url, `https://registry.rover.link/api/guilds/${guild.id}/access-requests/${member.id}`);
  assert.equal(rover.calls[1].authorization, `Bearer ${API_KEY}`);
  assert.equal(seen[1].body, undefined, 'no callbackUrl is sent');
  assert.ok(interaction.calls.deferred.flags, 'private reply');
  const embed = embedOf(interaction.calls.replies[0]);
  assert.match(embed.description, /^RoVer sent you a direct message asking whether this server can see your Roblox account\./);
  assert.match(embed.description, /Open the DM from \*\*RoVer\*\* and click \*\*Allow\*\*/);
});

test('access request 200 pending: a repeated click reports the pending request without a new DM', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  await verification.start(makeInteraction({ guild, member }), { now: later() });

  const again = makeInteraction({ guild, member });
  await verification.start(again, { update: true, now: later() });
  assert.deepEqual(methods(rover), ['GET', 'PUT', 'GET', 'PUT']);
  assert.equal(rover.requests.size, 1, 'RoVer created only one request');
  assert.match(embedOf(again.calls.replies[0]).description, /^RoVer already sent you an authorization request\./);
  assert.deepEqual(buttonsOf(again.calls.replies[0]).map((button) => button.custom_id), ['verify:check']);
});

test('access request already_authorized: the account is looked up again right away and verified', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  rover.accounts[member.id] = { id: '1501', username: 'authorized_user' };
  let hidden = true;
  rover.failure = (method) => (method === 'GET' && hidden && !(hidden = false) ? { status: 404, body: { errorCode: 'user_not_found' } } : null);

  const interaction = makeInteraction({ guild, member });
  await verification.start(interaction, { now: later() });
  assert.deepEqual(methods(rover), ['GET', 'PUT', 'GET']);
  assert.equal(embedOf(interaction.calls.replies[0]).title, 'Verification successful');
  assert.equal(member.nickname, 'Whitee (@authorized_user)');

  const { guild: other, rover: unlinked } = setup();
  unlinked.failure = (method) => (method === 'GET' ? { status: 404, body: { errorCode: 'user_not_found' } } : { status: 200, body: { status: 'already_authorized' } });
  const stuck = makeInteraction({ guild: other, member: join(other) });
  await verification.start(stuck, { now: later() });
  assert.deepEqual(methods(unlinked), ['GET', 'PUT', 'GET'], 'no loop when RoVer has no account');
  assert.match(embedOf(stuck.calls.replies[0]).description, /^Your Discord account is not linked to a Roblox account yet\./);
});

test('a member who allows the request is verified on Check again with the Roblox ID and username from RoVer', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  await verification.start(makeInteraction({ guild, member }), { now: later() });
  assert.equal(verifications.findByDiscord(member.id), undefined);

  rover.accounts[member.id] = { id: '1502', username: 'allowed_user' };
  const check = makeInteraction({ guild, member, customId: 'verify:check' });
  await verification.start(check, { update: true, now: later() });
  assert.deepEqual(methods(rover), ['GET', 'PUT', 'GET']);
  assert.equal(check.calls.deferred, 'update', 'Check again edits the same private message');
  const embed = embedOf(check.calls.replies[0]);
  assert.equal(embed.title, 'Verification successful');
  assert.match(embed.description, /^Roblox username: allowed_user\nRoblox ID: 1502/);
  const stored = verifications.findByDiscord(member.id);
  assert.deepEqual([stored.roblox_id, stored.roblox_username], ['1502', 'allowed_user']);
  assert.ok(member.roles.cache.has(MEMBER_ROLE));
  assert.equal(member.nickname, 'Whitee (@allowed_user)');
});

test('nothing polls RoVer: requests only happen when the member clicks', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  await verification.start(makeInteraction({ guild, member }), { now: later() });
  const sent = rover.calls.length;
  rover.accounts[member.id] = { id: '1503', username: 'waiting_user' };
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rover.calls.length, sent);
  assert.equal(verifications.findByDiscord(member.id), undefined);
});

test('dm_unreachable tells the member that RoVer could not DM them', async () => {
  const { guild, rover } = setup();
  rover.failure = (method) => (method === 'PUT' ? { status: 400, body: { errorCode: 'dm_unreachable', message: 'Cannot DM' } } : null);
  const { result, lines } = await quiet(() => press(guild, join(guild)));
  const embed = embedOf(result.reply);
  assert.match(embed.description, /RoVer could not send you a direct message/);
  assert.match(embed.description, /Allow direct messages from this server and make sure you can receive messages from \*\*RoVer\*\*/);
  assert.deepEqual(buttonsOf(result.reply).map((button) => button.custom_id), ['verify:check']);
  assert.deepEqual(lines, []);
});

test('member_not_in_guild, bot_not_in_guild, discord_error and bad_request are handled explicitly', async () => {
  const cases = {
    member_not_in_guild: ['Verification failed', /could not find you in this server/, null],
    bot_not_in_guild: ['Verification unavailable', /contact a server administrator/, 'RoVer is not in this server. Add the RoVer bot so it can send authorization requests.'],
    discord_error: ['Verification unavailable', /could not reach Discord/, 'RoVer lookup failed: RoVer access request responded with 500 (discord_error)'],
    bad_request: ['Verification unavailable', /could not be reached right now/, 'RoVer lookup failed: RoVer access request responded with 400 (bad_request)'],
  };
  for (const [code, [title, description, logged]] of Object.entries(cases)) {
    const { guild, rover } = setup();
    rover.failure = (method) => (method === 'PUT' ? { status: code === 'discord_error' ? 500 : 400, body: { errorCode: code, message: code } } : null);
    const { result, lines } = await quiet(() => press(guild, join(guild)));
    const embed = embedOf(result.reply);
    assert.equal(embed.title, title, code);
    assert.match(embed.description, description, code);
    assert.deepEqual(lines, logged ? [logged] : [], code);
  }
});

test('429 and discord_rate_limit on the access request stop every request until Retry-After', async () => {
  for (const failure of [{ status: 429, body: { message: 'Too many requests' }, headers: { 'retry-after': '7' } }, { status: 500, body: { errorCode: 'discord_rate_limit' }, headers: { 'retry-after': '3' } }]) {
    const { guild, rover } = setup();
    rover.failure = (method) => (method === 'PUT' ? failure : null);
    const now = later();
    const seconds = Number(failure.headers['retry-after']);

    const interaction = makeInteraction({ guild, member: join(guild) });
    await verification.start(interaction, { now });
    assert.equal(embedOf(interaction.calls.replies[0]).title, 'Too many requests');
    assert.match(embedOf(interaction.calls.replies[0]).description, new RegExp(`<t:${Math.ceil((now + seconds * 1000) / 1000)}:R>`));

    await assert.rejects(verification.start(makeInteraction({ guild, member: join(guild) }), { now: now + seconds * 1000 - 1 }), /too many requests/);
    assert.deepEqual(methods(rover), ['GET', 'PUT'], 'no immediate retry');

    rover.failure = null;
    await verification.start(makeInteraction({ guild, member: join(guild) }), { now: now + seconds * 1000 });
    assert.equal(rover.calls.length, 4);
  }
});

test('JSON errors are read only with a JSON Content-Type', async () => {
  const { guild, rover } = setup();
  rover.failure = { status: 404, body: { errorCode: 'user_not_found' }, headers: { 'content-type': 'text/plain' } };
  const { result, lines } = await quiet(() => press(guild, join(guild)));
  assert.equal(embedOf(result.reply).title, 'Verification unavailable');
  assert.deepEqual(methods(rover), ['GET'], 'an errorCode is not trusted without a JSON Content-Type');
  assert.deepEqual(lines, ['RoVer lookup failed: RoVer responded with 404']);
});

test('a Cloudflare HTML response does not crash verification', async () => {
  for (const [status, method] of [[502, 'GET'], [403, 'GET'], [503, 'PUT']]) {
    const { guild, rover } = setup();
    rover.failure = (requested) => (requested === method ? { html: true, status } : null);
    const member = join(guild);
    const { result, lines } = await quiet(() => press(guild, member));
    assert.equal(embedOf(result.reply).title, 'Verification unavailable');
    assert.match(lines[0], new RegExp(`responded with ${status}$`));
    assert.equal(verifications.findByDiscord(member.id), undefined);
  }
});

test('the API key never appears in replies or console output', async () => {
  const outputs = [];
  for (const failure of [null, { status: 401, body: { errorCode: 'unauthorized' } }, { status: 500, body: { errorCode: 'bad_request' } }, { html: true, status: 502 }]) {
    const { guild, rover } = setup();
    rover.failure = failure;
    const member = join(guild);
    rover.accounts[member.id] = { id: String(1600 + outputs.length), username: 'key_check_user' };
    const { result, lines } = await quiet(() => press(guild, member));
    outputs.push(JSON.stringify(result.reply.embeds.map((embed) => embed.toJSON())), ...lines, ...guild.logChannel.sent.map((message) => JSON.stringify(message.embeds)));
  }
  assert.ok(outputs.length > 4);
  assert.ok(!outputs.join('\n').includes(API_KEY));
});

test('data from the RoVer API is kept for at most 30 days', async () => {
  assert.equal(verification.RETENTION, 30 * 24 * 60 * 60 * 1000);
  const { guild, rover } = setup();
  const member = join(guild);
  rover.accounts[member.id] = { id: '1701', username: 'thirty_days' };
  const now = later();
  await verification.start(makeInteraction({ guild, member }), { now });
  const stored = verifications.findByDiscord(member.id);
  assert.equal(stored.verified_at, now);
  assert.equal(stored.expires_at, now + verification.RETENTION);
});

test('expired RoVer data is deleted before it outlives 30 days, and a missing account removes stored RoVer data', async () => {
  assert.equal(database.get().pragma('secure_delete', { simple: true }), 1, 'deleted rows are overwritten on disk');
  verifications.link({ discordId: 'expiring-soon', robloxId: '1801', robloxUsername: 'soon', expiresAt: Date.now() + 30 * 60_000 });
  verifications.link({ discordId: 'expiring-later', robloxId: '1802', robloxUsername: 'later', expiresAt: Date.now() + verification.RETENTION });
  verifications.link({ discordId: 'from-oauth', robloxId: '1803', robloxUsername: 'oauth' });

  verification.startCleanup();
  assert.equal(verifications.findByDiscord('expiring-soon'), undefined, 'removed before the next hourly cleanup would be too late');
  assert.ok(verifications.findByDiscord('expiring-later'));
  assert.ok(verifications.findByDiscord('from-oauth'), 'links made by the old OAuth flow are not RoVer data');

  const { guild, rover } = setup();
  const member = join(guild);
  rover.accounts[member.id] = { id: '1804', username: 'revoked_user' };
  await verification.start(makeInteraction({ guild, member }), { now: later() });
  delete rover.accounts[member.id];
  const relink = makeInteraction({ guild, member });
  await verification.start(relink, { replace: true, now: later() });
  assert.equal(verifications.findByDiscord(member.id), undefined, 'RoVer no longer returns the account, so its data is not kept');
  assert.match(embedOf(relink.calls.replies[0]).description, /RoVer sent you a direct message/);
});

test('the Roblox ID and username from RoVer never reach the permanent verification log or the console', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  rover.accounts[member.id] = { id: '1901', username: 'private_first' };
  const { lines } = await quiet(async () => {
    await verification.start(makeInteraction({ guild, member }), { now: later() });
    rover.accounts[member.id] = { id: '1902', username: 'private_second' };
    await verification.start(makeInteraction({ guild, member }), { replace: true, now: later() });
  });

  const logs = guild.logChannel.sent.map((message) => message.embeds[0].toJSON());
  assert.deepEqual(logs.map((log) => log.title), ['Verification • Roblox account linked', 'Verification • Roblox account changed']);
  assert.deepEqual(logs[1].fields.map((field) => field.name), ['Discord user', 'Member role', 'Nickname', 'Timestamp']);
  const permanent = JSON.stringify(logs) + lines.join('\n');
  for (const value of ['1901', '1902', 'private_first', 'private_second']) assert.ok(!permanent.includes(value), value);
});
const clientFor = (guild) => ({ guilds: { cache: new Map([[guild.id, guild]]) } });

const verifyAs = async (guild, rover, member, account, options = {}) => {
  rover.accounts[member.id] = account;
  const interaction = makeInteraction({ guild, member });
  await verification.start(interaction, { now: later(), ...options });
  return interaction;
};

test('the nickname is applied after verification and Roland records that it set it', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  await verifyAs(guild, rover, member, { id: '2001', username: 'nick_user' });

  assert.equal(member.nickname, 'Whitee (@nick_user)');
  const stored = verifications.findByDiscord(member.id);
  assert.deepEqual([stored.nickname_managed, stored.previous_nickname], [1, null]);
});

test('the previous nickname is kept across a change of Roblox account', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  member.nickname = 'Custom Nick';
  await verifyAs(guild, rover, member, { id: '2101', username: 'first_name' });
  assert.equal(member.nickname, 'Whitee (@first_name)');
  assert.equal(verifications.findByDiscord(member.id).previous_nickname, 'Custom Nick');

  await verifyAs(guild, rover, member, { id: '2102', username: 'second_name' }, { replace: true });
  assert.equal(member.nickname, 'Whitee (@second_name)');
  assert.equal(verifications.findByDiscord(member.id).previous_nickname, 'Custom Nick', 'not replaced by the earlier RoVer nickname');
});

test('when RoVer data expires the previous nickname, or the Discord default, is restored', async () => {
  const { guild, rover } = setup();
  const named = join(guild);
  named.nickname = 'Custom Nick';
  const unnamed = join(guild);
  const now = later();
  await verifyAs(guild, rover, named, { id: '2201', username: 'expiring_one' }, { now });
  await verifyAs(guild, rover, unnamed, { id: '2202', username: 'expiring_two' }, { now });

  await verification.cleanup(now + verification.RETENTION, clientFor(guild));
  assert.equal(named.nickname, 'Custom Nick');
  assert.equal(unnamed.nickname, null, 'no previous nickname: back to the Discord default');
  assert.equal(verifications.findByDiscord(named.id), undefined);
  assert.equal(verifications.findByDiscord(unnamed.id), undefined);
  assert.ok(named.roles.cache.has(MEMBER_ROLE), 'the Member role stays');
});

test('user_not_found restores the previous nickname and clears the stored RoVer data', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  member.nickname = 'Before';
  await verifyAs(guild, rover, member, { id: '2301', username: 'gone_user' });
  assert.equal(member.nickname, 'Whitee (@gone_user)');

  delete rover.accounts[member.id];
  const relink = makeInteraction({ guild, member });
  await verification.start(relink, { replace: true, now: later() });
  assert.equal(member.nickname, 'Before');
  assert.equal(verifications.findByDiscord(member.id), undefined);
  assert.equal(rover.calls.at(-1).method, 'PUT', 'consent is requested again');
});

test('verifying again after expiry looks RoVer up again, reapplies the nickname and renews 30 days', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  member.nickname = 'Custom Nick';
  const first = later();
  await verifyAs(guild, rover, member, { id: '2401', username: 'old_name' }, { now: first });
  await verification.cleanup(first + verification.RETENTION, clientFor(guild));
  assert.equal(member.nickname, 'Custom Nick');

  const lookups = rover.calls.length;
  const second = first + verification.RETENTION + 60_000;
  await verifyAs(guild, rover, member, { id: '2401', username: 'renamed_user' }, { now: second });
  assert.equal(rover.calls.length, lookups + 1);
  assert.equal(member.nickname, 'Whitee (@renamed_user)');
  const stored = verifications.findByDiscord(member.id);
  assert.deepEqual([stored.roblox_username, stored.expires_at, stored.previous_nickname], ['renamed_user', second + verification.RETENTION, 'Custom Nick']);
});

test('the RoVer username is not kept anywhere once its data is removed', async () => {
  const { guild, rover } = setup();
  const member = join(guild);
  member.nickname = 'Someone (@stale_name)';
  const now = later();
  await verifyAs(guild, rover, member, { id: '2501', username: 'secret_name' }, { now });
  assert.equal(verifications.findByDiscord(member.id).previous_nickname, null, 'a nickname with a Roblox username is never saved as the previous one');

  await verification.cleanup(now + verification.RETENTION, clientFor(guild));
  assert.equal(member.nickname, null);
  const db = database.get();
  const dump = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('\n');
  for (const value of ['secret_name', 'stale_name']) assert.ok(!dump.includes(value), value);
  assert.equal(verifications.findByRoblox('2501'), undefined);
});

test('cleanup keeps nicknames changed by the member and survives members who left or permission errors', async () => {
  const { guild, rover } = setup();
  const renamed = join(guild);
  const left = join(guild);
  const locked = join(guild);
  locked.nickname = 'Locked';
  const now = later();
  for (const [member, name] of [[renamed, 'manual_case'], [left, 'left_case'], [locked, 'locked_case']]) {
    await verifyAs(guild, rover, member, { id: String(2600 + rover.calls.length), username: name }, { now });
  }
  renamed.nickname = 'My own nickname';
  guild.members.cache.delete(left.id);
  locked.setNickname = async () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013 }));

  const { result, lines } = await quiet(() => verification.cleanup(now + verification.RETENTION, clientFor(guild)));
  assert.ok(result >= 3);
  assert.equal(renamed.nickname, 'My own nickname', 'a nickname without the RoVer username is left alone');
  assert.equal(locked.nickname, 'Whitee (@locked_case)');
  assert.deepEqual(lines, [`Failed to restore the nickname of ${locked.id}: Missing Permissions`]);
  assert.ok(!lines.join(' ').includes('locked_case'));
  for (const member of [renamed, left, locked]) assert.equal(verifications.findByDiscord(member.id), undefined, 'data is removed even when the nickname cannot be restored');

  const soon = join(guild);
  soon.nickname = 'Soon';
  verifications.link({ discordId: soon.id, robloxId: '2699', robloxUsername: 'soon_case', guildId: guild.id, expiresAt: Date.now() + 30 * 60_000 });
  soon.nickname = 'Whitee (@soon_case)';
  verifications.manageNickname(soon.id, 'Soon');
  verification.startCleanup(clientFor(guild));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(soon.nickname, 'Soon', 'the scheduled cleanup restores nicknames too');
});

const ROVER_VERIFY = 'https://rover.link/verify/';

const unlinked = (rover) => {
  rover.failure = (method) =>
    rover.linked ? null : method === 'GET' ? { status: 404, body: { errorCode: 'user_not_found', message: 'User not found' } } : { status: 200, body: { status: 'already_authorized' } };
};

test('an account without a Roblox link gets Roland instructions with the official RoVer link, not an error', async () => {
  const { guild, rover } = setup();
  unlinked(rover);
  const member = join(guild);
  member.nickname = 'Untouched';

  const interaction = makeInteraction({ guild, member });
  const { lines } = await quiet(() => verification.start(interaction, { now: later() }));
  const reply = interaction.calls.replies[0];
  const embed = embedOf(reply);
  assert.ok(interaction.calls.deferred.flags, 'private reply');
  assert.equal(interaction.calls.replies.length, 1, 'no other message');
  assert.equal(embed.title, 'Roblox Verification');
  assert.equal(embed.description, [
    'Your Discord account is not linked to a Roblox account yet.',
    '',
    '**To continue:**',
    '1. Click **Verify with Roblox** below.',
    '2. Complete the Roblox verification on the official RoVer website.',
    '3. Return to this server.',
    '4. Click **Check again**.',
    '',
    'Your Roblox account will only be linked to Roland after you complete the verification.',
  ].join('\n'));
  assert.doesNotMatch(embed.description, /user_not_found|RoVer bot/);

  const [link, check] = buttonsOf(reply);
  assert.deepEqual([link.label, link.style, link.url, link.custom_id], ['Verify with Roblox', 5, ROVER_VERIFY, undefined]);
  assert.deepEqual([check.label, check.custom_id], ['Check again', 'verify:check']);

  assert.deepEqual(lines, [], 'not logged as an error');
  assert.equal(verifications.findByDiscord(member.id), undefined);
  assert.ok(!member.roles.cache.has(MEMBER_ROLE));
  assert.equal(member.nickname, 'Untouched');
  assert.ok(!JSON.stringify(reply.components.map((row) => row.toJSON())).includes(API_KEY));
  assert.ok(!JSON.stringify(embed).includes(API_KEY));
});

test('Check again looks RoVer up again and keeps guiding the member until the account is linked', async () => {
  const { guild, rover } = setup();
  unlinked(rover);
  const member = join(guild);
  await verification.start(makeInteraction({ guild, member }), { now: later() });
  const lookups = () => rover.calls.filter((call) => call.method === 'GET').length;
  const before = lookups();

  const still = makeInteraction({ guild, member, customId: 'verify:check' });
  await verification.start(still, { update: true, now: later() });
  assert.ok(lookups() > before, 'the API is queried again');
  assert.equal(still.calls.deferred, 'update');
  const embed = embedOf(still.calls.replies[0]);
  assert.equal(embed.title, 'Roblox Verification');
  assert.match(embed.description, /^We still couldn't find a Roblox account linked to your Discord account\./);
  assert.match(embed.description, /click \*\*Verify with Roblox\*\* below\.\nAfter completing it, return here and click \*\*Check again\*\*\.$/);
  assert.deepEqual(buttonsOf(still.calls.replies[0]).map((button) => button.url ?? button.custom_id), [ROVER_VERIFY, 'verify:check']);

  rover.linked = true;
  rover.accounts[member.id] = { id: '3001', username: 'now_linked' };
  const done = makeInteraction({ guild, member, customId: 'verify:check' });
  await verification.start(done, { update: true, now: later() });
  assert.equal(embedOf(done.calls.replies[0]).title, 'Verification successful');
  assert.deepEqual(done.calls.replies[0].components, []);
  assert.ok(member.roles.cache.has(MEMBER_ROLE));
  assert.equal(member.nickname, 'Whitee (@now_linked)');
  const stored = verifications.findByDiscord(member.id);
  assert.equal(stored.expires_at - stored.verified_at, verification.RETENTION);
});

test('/verify without a Roblox link shows the RoVer link and keeps the relink Check again', async () => {
  const { guild, rover } = setup();
  unlinked(rover);
  const { reply } = await runVerify(guild, join(guild));
  assert.deepEqual(buttonsOf(reply).map((button) => button.url ?? button.custom_id), [ROVER_VERIFY, 'verify:check:relink']);
});

test('the access request and error states never show the RoVer verification link', async () => {
  const { guild, rover } = setup();
  const requested = await press(guild, join(guild));
  assert.match(embedOf(requested.reply).description, /RoVer sent you a direct message/);
  assert.ok(buttonsOf(requested.reply).every((button) => !button.url), 'consent keeps its own guidance');

  for (const failure of [
    { status: 429, body: { message: 'Too many requests' }, headers: { 'retry-after': '5' } },
    { status: 401, body: { errorCode: 'unauthorized' } },
    { status: 500, body: { errorCode: 'discord_error' } },
    { status: 400, body: { errorCode: 'bad_request' } },
    { html: true, status: 502 },
  ]) {
    const { guild: other, rover: failing } = setup();
    failing.failure = failure;
    const { result } = await quiet(() => press(other, join(other)));
    assert.notEqual(embedOf(result.reply).title, 'Roblox Verification', JSON.stringify(failure));
    assert.deepEqual(result.reply.components, [], 'a real error is not shown as a missing link');
  }
});
