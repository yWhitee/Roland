const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const database = require('../src/database');
const guildSettings = require('../src/database/guildSettings');
const verificationPanels = require('../src/database/verificationPanels');
const verifications = require('../src/database/verifications');
const embedBuilder = require('../src/services/embedBuilder');
const verification = require('../src/services/verification');
const createverify = require('../src/commands/createverify');
const verifyinfo = require('../src/commands/verifyinfo');
const verifyButton = require('../src/components/verify');
const web = require('../src/web/server');
const { Collection } = require('discord.js');
const verifyCommand = require('../src/commands/verify');
const interactionCreate = require('../src/events/interactionCreate');
const oauthStates = require('../src/database/oauthStates');
const { ROLES } = require('../src/permissions');
const { makeGuild, makeInteraction, makeMember, snowflake, tempDatabase } = require('./helpers/discord');

const file = tempDatabase();
const MEMBER_ROLE = '1555596685462479048';
const SETTINGS = { clientId: '1234567890', clientSecret: 'test-secret', redirectUri: 'https://roland.example/oauth/roblox/callback' };

let nextRobloxId = 10_000;

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const fakeRoblox = ({ user = {}, token = {}, tokenStatus = 200, userStatus = 200, offline = false } = {}) => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null });
    if (offline) throw new Error('getaddrinfo ENOTFOUND apis.roblox.com');
    if (url.endsWith('/v1/token')) return json(tokenStatus, { access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer', ...token });
    if (url.endsWith('/v1/userinfo')) {
      return json(userStatus, { sub: String(nextRobloxId++), name: 'CoolPlayer', nickname: 'CoolPlayer', preferred_username: 'cool_player123', ...user });
    }
    if (url.endsWith('/v1/token/revoke')) return json(200, {});
    return json(404, {});
  };
  return { fetch, calls };
};

const setup = ({ roblox = fakeRoblox(), roles = [MEMBER_ROLE] } = {}) => {
  const guild = makeGuild({ roles });
  guildSettings.enableLogs(guild.id, guild.logChannel.id);
  const client = { user: { id: '900000000000000000' }, guilds: { cache: new Map([[guild.id, guild]]) } };
  verification.configure({ ...SETTINGS, client, fetch: roblox.fetch });
  return { guild, client, roblox };
};

const join = (guild, options = {}) => {
  const member = makeMember(null, { globalName: 'Whitee', ...options });
  guild.members.cache.set(member.id, member);
  return member;
};

const click = async (guild, member, message = { id: 'panel-message' }) => {
  const interaction = makeInteraction({ guild, member, customId: 'verify:start', message });
  await verifyButton.execute(interaction);
  const reply = interaction.calls.replies[0];
  const link = reply.components?.[0]?.toJSON().components[0].url;
  return { interaction, reply, url: link && new URL(link), state: link && new URL(link).searchParams.get('state') };
};

const callback = (params, now) => verification.handleCallback(new URLSearchParams(params), now);

const lastEdit = (interaction) => interaction.calls.replies.at(-1).embeds[0].toJSON();

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

test('the verify button starts a PKCE OAuth flow with a single, hashed, expiring state', async () => {
  const { guild } = setup();
  const member = join(guild);
  const { reply, url, state } = await click(guild, member);

  assert.ok(reply.flags, 'the OAuth link is ephemeral');
  assert.equal(`${url.origin}${url.pathname}`, 'https://apis.roblox.com/oauth/v1/authorize');
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual(
    { ...params, state: undefined, code_challenge: undefined },
    {
      client_id: SETTINGS.clientId,
      redirect_uri: SETTINGS.redirectUri,
      scope: 'openid profile',
      response_type: 'code',
      state: undefined,
      code_challenge: undefined,
      code_challenge_method: 'S256',
    },
  );
  assert.ok(state.length >= 43);
  assert.ok(url.toString().length <= 512);

  const stored = database.get().prepare('SELECT * FROM oauth_states WHERE discord_id = ?').all(member.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].state_hash, crypto.createHash('sha256').update(state).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(state), 'the raw state is never stored');
  assert.ok(stored[0].expires_at - stored[0].created_at === 10 * 60_000);

  const again = await click(guild, member);
  assert.equal(database.get().prepare('SELECT COUNT(*) AS total FROM oauth_states WHERE discord_id = ?').get(member.id).total, 1);
  assert.equal((await callback({ code: 'abc', state })).status, 400, 'starting again invalidates the previous link');
  assert.notEqual(again.state, state);
});

test('a valid callback links the Roblox identity, assigns the Member role and sets the nickname with the Roblox USERNAME', async () => {
  const { guild, roblox } = setup({ roblox: fakeRoblox({ user: { sub: '123456789' } }) });
  const member = join(guild);
  const { interaction, url, state } = await click(guild, member);

  const result = await callback({ code: 'auth-code', state });
  assert.equal(result.status, 200);
  assert.equal(result.title, 'Verification successful');
  assert.deepEqual(result.lines, [
    'Roblox username: cool_player123',
    'Roblox ID: 123456789',
    '',
    'You have been given the Member role.',
    'Your server nickname has been updated.',
  ]);

  const [tokenCall, userCall, revokeCall] = roblox.calls;
  assert.equal(tokenCall.url, 'https://apis.roblox.com/oauth/v1/token');
  assert.equal(tokenCall.options.method, 'POST');
  assert.equal(tokenCall.body.grant_type, 'authorization_code');
  assert.equal(tokenCall.body.code, 'auth-code');
  assert.equal(tokenCall.body.client_id, SETTINGS.clientId);
  assert.equal(tokenCall.body.client_secret, SETTINGS.clientSecret);
  assert.equal(crypto.createHash('sha256').update(tokenCall.body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'), 'PKCE verifier matches the challenge');
  assert.equal(userCall.url, 'https://apis.roblox.com/oauth/v1/userinfo');
  assert.equal(userCall.options.headers.authorization, 'Bearer access-token');
  assert.equal(revokeCall.url, 'https://apis.roblox.com/oauth/v1/token/revoke');

  const stored = verifications.findByDiscord(member.id);
  assert.deepEqual(
    [stored.discord_id, stored.roblox_id, stored.roblox_username, stored.roblox_display_name, stored.guild_id],
    [member.id, '123456789', 'cool_player123', 'CoolPlayer', guild.id],
  );
  assert.ok(stored.verified_at <= Date.now());

  assert.ok(member.roles.cache.has(MEMBER_ROLE));
  assert.equal(member.nickname, 'Whitee (@cool_player123)');
  assert.ok(!member.nickname.includes('CoolPlayer'), 'the Roblox display name is never used');

  assert.equal(lastEdit(interaction).title, 'Verification successful');
  assert.match(lastEdit(interaction).description, /Roblox ID: 123456789/);

  const log = guild.logChannel.sent.at(-1).embeds[0].toJSON();
  assert.equal(log.title, 'Verification • Roblox account linked');
  const fields = Object.fromEntries(log.fields.map((field) => [field.name, field.value]));
  assert.match(fields['Discord user'], new RegExp(member.id));
  assert.match(fields['Roblox username'], /cool_player123/);
  assert.equal(fields['Roblox ID'], '`123456789`');
  assert.ok(!JSON.stringify(log).match(/access-token|refresh-token|auth-code|test-secret/), 'no credentials are logged');
});

test('invalid, expired, reused and code-less callbacks fail', async () => {
  const { guild, roblox } = setup();

  assert.equal((await callback({ code: 'x', state: 'forged-state' })).status, 400);
  assert.equal((await callback({ code: 'x' })).status, 400);

  const expired = await click(guild, join(guild));
  const late = await callback({ code: 'x', state: expired.state }, Date.now() + 11 * 60_000);
  assert.equal(late.status, 400);
  assert.match(late.lines[0], /invalid, has expired or was already used/);
  assert.match(lastEdit(expired.interaction).title, /expired/);

  const used = await click(guild, join(guild));
  assert.equal((await callback({ code: 'x', state: used.state })).status, 200);
  assert.equal((await callback({ code: 'x', state: used.state })).status, 400, 'a state can only be used once');

  const missing = await click(guild, join(guild));
  const noCode = await callback({ state: missing.state });
  assert.equal(noCode.status, 400);
  assert.match(noCode.lines[0], /did not return an authorization code/);
  assert.equal((await callback({ code: 'x', state: missing.state })).status, 400, 'the state is consumed even when the code is missing');

  const denied = await click(guild, join(guild));
  const cancelled = await callback({ error: 'access_denied', state: denied.state });
  assert.equal(cancelled.title, 'Verification cancelled');

  assert.equal(roblox.calls.filter((call) => call.url.endsWith('/v1/token')).length, 1, 'Roblox is only contacted for the valid state');
});

test('Roblox failures produce clear errors and nothing is linked', async () => {
  const cases = [
    [{ tokenStatus: 400, token: { error: 'invalid_grant' } }, 400, /invalid or has expired/],
    [{ offline: true }, 502, /could not be reached/],
    [{ tokenStatus: 503 }, 502, /could not be reached/],
    [{ user: { preferred_username: undefined } }, 502, /unexpected response/],
    [{ user: { sub: 'not-a-number' } }, 502, /unexpected response/],
    [{ token: { access_token: undefined } }, 502, /unexpected response/],
  ];

  for (const [options, status, message] of cases) {
    const { guild } = setup({ roblox: fakeRoblox(options) });
    const member = join(guild);
    const { state } = await click(guild, member);
    const result = await callback({ code: 'x', state });
    assert.equal(result.status, status, JSON.stringify(options));
    assert.match(result.lines.join(' '), message);
    assert.equal(verifications.findByDiscord(member.id), undefined);
    assert.ok(!member.roles.cache.has(MEMBER_ROLE));
  }
});

test('a Roblox account linked to another Discord account is rejected without revealing or replacing it', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '555', preferred_username: 'shared_account' } }) });
  const first = join(guild);
  await callback({ code: 'x', state: (await click(guild, first)).state });

  const second = join(guild);
  const result = await callback({ code: 'x', state: (await click(guild, second)).state });
  assert.equal(result.status, 409);
  assert.deepEqual(result.lines, ['This Roblox account is already linked to another Discord account.']);
  assert.ok(!result.lines.join(' ').includes(first.id));
  assert.equal(verifications.findByRoblox('555').discord_id, first.id);
  assert.equal(verifications.findByDiscord(second.id), undefined);
  assert.ok(!second.roles.cache.has(MEMBER_ROLE));
  assert.equal(second.nickname, null);
});

test('already verified users see their linked account and cannot create a second verification', async () => {
  const { guild } = setup();
  const member = join(guild);
  const pending = await click(guild, member);
  await callback({ code: 'x', state: pending.state });

  const { reply, url } = await click(guild, member);
  assert.equal(url, undefined, 'no new OAuth link is created');
  assert.ok(reply.flags);
  assert.equal(reply.embeds[0].toJSON().title, 'You are already verified');
  assert.match(reply.embeds[0].toJSON().description, /cool_player123/);

  const raced = await click(guild, join(guild, { globalName: 'Other' }));
  setup({ roblox: fakeRoblox({ user: { sub: '777', preferred_username: 'other_account' } }) });
  verifications.link({ discordId: raced.interaction.user.id, robloxId: '888', robloxUsername: 'first_link' });
  const result = await callback({ code: 'x', state: raced.state });
  assert.equal(result.status, 409);
  assert.match(result.lines[0], /already verified with another Roblox account \(first_link\)/);
  assert.equal(verifications.findByDiscord(raced.interaction.user.id).roblox_id, '888');
});

test('role and nickname failures do not undo a successful verification', async () => {
  const { guild } = setup();
  const member = join(guild);
  member.roles.add = async () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013 }));
  member.setNickname = async () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013 }));

  const result = await callback({ code: 'x', state: (await click(guild, member)).state });
  assert.equal(result.status, 200);
  assert.equal(result.title, 'Verification successful');
  assert.match(result.lines[3], /Member role could not be assigned: The bot is missing the Manage Roles permission or the Member role is above/);
  assert.match(result.lines[4], /nickname could not be updated: The bot is missing the Manage Nicknames permission/);
  assert.ok(verifications.findByDiscord(member.id));

  const { guild: noRole } = setup({ roles: [] });
  const other = join(noRole);
  const missingRole = await callback({ code: 'x', state: (await click(noRole, other)).state });
  assert.equal(missingRole.status, 200);
  assert.match(missingRole.lines[3], /Member role no longer exists/);
  assert.equal(other.nickname, 'Whitee (@cool_player123)');
});

test('the server owner verifies even though Discord blocks owner nickname changes', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '1001', preferred_username: 'owner_account' } }) });
  const owner = join(guild);
  guild.ownerId = owner.id;

  const result = await callback({ code: 'x', state: (await click(guild, owner)).state });
  assert.equal(result.status, 200);
  assert.ok(owner.roles.cache.has(MEMBER_ROLE));
  assert.match(result.lines[4], /does not allow bots to change the server owner's nickname/);
});

test('a user who leaves the server during verification is still verified', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '2002', preferred_username: 'left_user' } }) });
  const member = join(guild);
  const { state } = await click(guild, member);
  guild.members.cache.delete(member.id);

  const result = await callback({ code: 'x', state });
  assert.equal(result.status, 200);
  assert.match(result.lines.at(-1), /no longer a member of the server/);
  assert.equal(verifications.findByDiscord(member.id).roblox_username, 'left_user');
});

test('an OAuth flow survives a bot restart', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '3003', preferred_username: 'restart_user' } }) });
  const member = join(guild);
  const { interaction, state } = await click(guild, member);
  const repliesBefore = interaction.calls.replies.length;

  database.close();
  database.open(file);
  const client = { user: { id: '900000000000000000' }, guilds: { cache: new Map([[guild.id, guild]]) } };
  verification.configure({ ...SETTINGS, client, fetch: fakeRoblox({ user: { sub: '3003', preferred_username: 'restart_user' } }).fetch });

  const result = await callback({ code: 'x', state });
  assert.equal(result.status, 200);
  assert.equal(member.nickname, 'Whitee (@restart_user)');
  assert.equal(interaction.calls.replies.length, repliesBefore, 'the pre-restart interaction is not reused');
});

test('multiple verification panels work independently and after a restart', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '4004', preferred_username: 'panel_user' } }) });
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

  const member = join(guild);
  const { state } = await click(guild, member, { id: panels[1].message_id });
  assert.equal(database.get().prepare('SELECT panel_id FROM oauth_states WHERE discord_id = ?').get(member.id).panel_id, panels[1].id);
  assert.equal((await callback({ code: 'x', state })).status, 200);

  const orphan = await click(guild, join(guild), { id: 'deleted-message' });
  assert.ok(orphan.state, 'a button on an unknown message still starts verification');
});

test('verification is disabled cleanly when Roblox OAuth is not configured', async () => {
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    assert.equal(verification.configure({}), false);
    assert.equal(verification.configure({ clientId: 'x', clientSecret: 'y' }), false);
    assert.equal(verification.configure({ ...SETTINGS, redirectUri: 'not a url' }), false);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2);
  assert.ok(!errors.join(' ').includes('y'.repeat(2)));
  assert.equal(verification.isConfigured(), false);

  const guild = makeGuild();
  await assert.rejects(click(guild, join(guild)), /not configured/);
  assert.equal((await callback({ code: 'x', state: 'y' })).status, 503);
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

const get = (port, path, method = 'GET') =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });

test('the OAuth callback server serves the configured path end to end', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '5005', preferred_username: 'http_user' } }) });
  const server = await web.start({ [verification.callbackPath()]: verification.handleCallback }, { host: '127.0.0.1', port: 0 });
  assert.ok(server);
  const { port } = server.address();

  try {
    const member = join(guild);
    const { state } = await click(guild, member);
    const success = await get(port, `/oauth/roblox/callback?code=abc&state=${encodeURIComponent(state)}`);
    assert.equal(success.status, 200);
    assert.match(success.body, /Verification successful/);
    assert.match(success.body, /http_user/);
    assert.equal(success.headers['referrer-policy'], 'no-referrer');
    assert.equal(success.headers['cache-control'], 'no-store');
    assert.match(success.headers['content-security-policy'], /default-src 'none'/);

    const replay = await get(port, `/oauth/roblox/callback?code=abc&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 400);

    const injected = await get(port, `/oauth/roblox/callback?error=x&state=<script>`);
    assert.ok(!injected.body.includes('<script>'));

    assert.equal((await get(port, '/other')).status, 404);
    assert.equal((await get(port, '/oauth/roblox/callback', 'POST')).status, 405);

    const busy = await web.start({}, { host: '127.0.0.1', port });
    assert.equal(busy, null, 'a port conflict is reported without crashing');
  } finally {
    server.close();
  }
});

const useRoblox = (guild, user) => {
  const client = { user: { id: '900000000000000000' }, guilds: { cache: new Map([[guild.id, guild]]) } };
  verification.configure({ ...SETTINGS, client, fetch: fakeRoblox({ user }).fetch });
};

const linkOf = (reply) => {
  const url = reply?.components?.[0]?.toJSON().components[0].url;
  return url ? new URL(url) : undefined;
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
  const reply = interaction.calls.replies[0];
  const url = linkOf(reply);
  return { interaction, reply, url, state: url?.searchParams.get('state') };
};

test('/verify can be used by every member, staff or not', async () => {
  const { guild } = setup();
  const ranks = {
    'no role': null,
    Member: MEMBER_ROLE,
    Support: ROLES.SUPPORT,
    Moderator: ROLES.MODERATOR,
    'Senior Moderator': ROLES.SENIOR_MODERATOR,
    Administrator: ROLES.ADMINISTRATOR,
    Owner: ROLES.CREATOR,
  };
  for (const [rank, role] of Object.entries(ranks)) {
    const member = makeMember(role, { globalName: 'Whitee' });
    guild.members.cache.set(member.id, member);
    const { reply, url } = await runVerify(guild, member);
    assert.ok(reply.flags, `${rank}: private reply`);
    assert.equal(`${url?.origin}${url?.pathname}`, 'https://apis.roblox.com/oauth/v1/authorize', `${rank} starts the official Roblox OAuth flow`);
  }
});

test('/verify starts a normal verification for an unverified Discord account', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '6000', preferred_username: 'first_account', nickname: 'Shown Name' } }) });
  const member = join(guild);
  const { reply, state } = await runVerify(guild, member);
  assert.doesNotMatch(reply.embeds[0].toJSON().description, /currently verified/);
  assert.equal(database.get().prepare('SELECT mode FROM oauth_states WHERE discord_id = ?').get(member.id).mode, 'relink');

  const result = await callback({ code: 'x', state });
  assert.equal(result.title, 'Verification successful');
  assert.equal(verifications.findByDiscord(member.id).roblox_id, '6000');
  assert.ok(member.roles.cache.has(MEMBER_ROLE));
  assert.equal(member.nickname, 'Whitee (@first_account)');
});

test('/verify replaces the linked Roblox account after a successful OAuth flow', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '6001', preferred_username: 'old_account' } }) });
  const member = join(guild);
  await callback({ code: 'x', state: (await click(guild, member)).state });
  assert.equal(verifications.findByDiscord(member.id).roblox_username, 'old_account');

  const panel = await click(guild, member);
  assert.equal(panel.url, undefined, 'the verification panel still refuses verified users');

  useRoblox(guild, { sub: '6002', preferred_username: 'new_account', name: 'Fancy Display', nickname: 'Fancy Display' });
  const { reply, state } = await runVerify(guild, member);
  assert.match(reply.embeds[0].toJSON().description, /currently verified as \*\*old_account\*\*/);
  assert.equal(verifications.findByDiscord(member.id).roblox_id, '6001', 'nothing changes until the OAuth flow succeeds');

  const result = await callback({ code: 'x', state });
  assert.equal(result.status, 200);
  assert.equal(result.title, 'Roblox account updated');
  assert.deepEqual(result.lines.slice(0, 3), ['Roblox username: new_account', 'Roblox ID: 6002', 'Previous Roblox account: old_account']);

  const stored = verifications.findByDiscord(member.id);
  assert.deepEqual([stored.roblox_id, stored.roblox_username, stored.roblox_display_name], ['6002', 'new_account', 'Fancy Display']);
  assert.equal(verifications.findByRoblox('6001'), undefined, 'the previous Roblox account is released');
  assert.equal(database.get().prepare('SELECT COUNT(*) AS total FROM verifications WHERE discord_id = ?').get(member.id).total, 1);
  assert.ok(member.roles.cache.has(MEMBER_ROLE));
  assert.equal(member.nickname, 'Whitee (@new_account)', 'the nickname uses the Roblox username, not the display name');

  const log = guild.logChannel.sent.at(-1).embeds[0].toJSON();
  assert.equal(log.title, 'Verification • Roblox account changed');
  const fields = Object.fromEntries(log.fields.map((field) => [field.name, field.value]));
  assert.match(fields['Roblox username'], /new_account/);
  assert.match(fields['Previous Roblox account'], /old_account/);

  const other = join(guild);
  useRoblox(guild, { sub: '6001', preferred_username: 'old_account' });
  assert.equal((await callback({ code: 'x', state: (await runVerify(guild, other)).state })).title, 'Verification successful', 'the released account can be linked again');
});

test('/verify rejects a Roblox account linked to another Discord and keeps the current link', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '6101', preferred_username: 'taken_account' } }) });
  const owner = join(guild);
  await callback({ code: 'x', state: (await click(guild, owner)).state });

  useRoblox(guild, { sub: '6102', preferred_username: 'my_account' });
  const member = join(guild);
  await callback({ code: 'x', state: (await click(guild, member)).state });
  const before = verifications.findByDiscord(member.id);
  const nickname = member.nickname;
  const logged = guild.logChannel.sent.length;

  useRoblox(guild, { sub: '6101', preferred_username: 'taken_account' });
  const result = await callback({ code: 'x', state: (await runVerify(guild, member)).state });
  assert.equal(result.status, 409);
  assert.deepEqual(result.lines, ['This Roblox account is already linked to another Discord account.', 'Your current verification (my_account) was not changed.']);
  assert.ok(!result.lines.join(' ').includes(owner.id), 'the other Discord account is not revealed');

  assert.deepEqual(verifications.findByDiscord(member.id), before);
  assert.equal(verifications.findByRoblox('6101').discord_id, owner.id);
  assert.equal(member.nickname, nickname);
  assert.equal(guild.logChannel.sent.length, logged, 'nothing is logged for a rejected change');
});

test('/verify states stay single-use and expire', async () => {
  const { guild } = setup({ roblox: fakeRoblox({ user: { sub: '6201', preferred_username: 'kept_account' } }) });
  const member = join(guild);
  await callback({ code: 'x', state: (await click(guild, member)).state });

  useRoblox(guild, { sub: '6202', preferred_username: 'late_account' });
  const expired = await runVerify(guild, member);
  assert.equal((await callback({ code: 'x', state: expired.state }, Date.now() + 11 * 60_000)).status, 400);
  assert.equal(verifications.findByDiscord(member.id).roblox_id, '6201', 'an expired /verify link changes nothing');

  const used = await runVerify(guild, member);
  assert.equal((await callback({ code: 'x', state: used.state })).status, 200);
  assert.equal((await callback({ code: 'x', state: used.state })).status, 400, 'the state cannot be replayed');
  assert.equal(verifications.findByDiscord(member.id).roblox_id, '6202');
});

test('concurrent /verify flows for the same Discord account stay consistent', async () => {
  const accounts = { slow: { sub: '6301', preferred_username: 'slow_account' }, fast: { sub: '6302', preferred_username: 'fast_account' } };
  const fetch = async (url, options = {}) => {
    const body = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : {};
    if (url.endsWith('/v1/token')) {
      if (body.code === 'slow') await new Promise((resolve) => setTimeout(resolve, 50));
      return json(200, { access_token: body.code, refresh_token: 'refresh' });
    }
    if (url.endsWith('/v1/userinfo')) return json(200, accounts[options.headers.authorization.slice('Bearer '.length)]);
    return json(200, {});
  };
  const { guild } = setup({ roblox: { fetch } });
  const member = join(guild);

  const replaced = await runVerify(guild, member);
  const latest = await runVerify(guild, member);
  assert.equal((await callback({ code: 'fast', state: replaced.state })).status, 400, 'a new /verify invalidates the previous link');
  assert.equal(database.get().prepare('SELECT COUNT(*) AS total FROM oauth_states WHERE discord_id = ?').get(member.id).total, 1);

  const slow = callback({ code: 'slow', state: latest.state });
  const next = await runVerify(guild, member);
  const fast = await callback({ code: 'fast', state: next.state });
  const first = await slow;

  assert.equal(first.status, 200);
  assert.equal(fast.title, 'Roblox account updated');
  assert.match(fast.lines.join(' '), /Previous Roblox account: slow_account/, 'the later flow runs after the earlier one finishes');
  assert.equal(verifications.findByDiscord(member.id).roblox_username, 'fast_account');
  assert.equal(member.nickname, 'Whitee (@fast_account)', 'nickname and stored link agree');
  assert.equal(verifications.findByRoblox('6301'), undefined);
  assert.equal(oauthStates.consume('missing'), undefined);
});
