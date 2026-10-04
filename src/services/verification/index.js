const crypto = require('node:crypto');
const { MessageFlags, RESTJSONErrorCodes } = require('discord.js');
const oauthStates = require('../../database/oauthStates');
const verificationPanels = require('../../database/verificationPanels');
const verifications = require('../../database/verifications');
const logging = require('../logging');
const { UserError } = require('../../utils/errors');
const roblox = require('./roblox');
const { panelComponents, startMessage, alreadyVerifiedEmbed, resultEmbed, logEmbed } = require('./messages');

const MEMBER_ROLE = '1555596685462479048';
const STATE_TTL = 10 * 60_000;
const INTERACTION_TTL = 15 * 60_000;
const NICKNAME_LIMIT = 32;
const LINK_LIMIT = 512;
const REQUIRED = ['clientId', 'clientSecret', 'redirectUri'];

let settings = null;
const pending = new Map();
const queues = new Map();

const isUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const configure = ({ client = null, fetch = globalThis.fetch, ...options } = {}) => {
  pending.clear();
  settings = null;

  const missing = REQUIRED.filter((key) => !options[key]);
  if (missing.length === REQUIRED.length) return false;
  if (missing.length) {
    console.error('Roblox verification is disabled: ROBLOX_CLIENT_ID, ROBLOX_CLIENT_SECRET and ROBLOX_REDIRECT_URI must all be set.');
    return false;
  }
  if (!isUrl(options.redirectUri)) {
    console.error('Roblox verification is disabled: ROBLOX_REDIRECT_URI must be a valid http(s) URL.');
    return false;
  }

  settings = { clientId: options.clientId, clientSecret: options.clientSecret, redirectUri: options.redirectUri, client, fetch };
  return true;
};

const isConfigured = () => Boolean(settings);

const callbackPath = () => new URL(settings.redirectUri).pathname;

const hashState = (state) => crypto.createHash('sha256').update(state).digest('hex');

const verifierFor = (state) => crypto.createHmac('sha256', settings.clientSecret).update(state).digest('base64url');

const remember = (stateHash, interaction) => {
  pending.set(stateHash, interaction);
  setTimeout(() => pending.delete(stateHash), INTERACTION_TTL).unref();
};

const serialize = (key, task) => {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
};

const take = (stateHash) => {
  const interaction = pending.get(stateHash);
  pending.delete(stateHash);
  return interaction;
};

const publishPanel = async (channel, payload, { type, createdBy }) => {
  const message = await channel.send({ ...payload, components: panelComponents() });
  return verificationPanels.create({ guildId: channel.guild.id, channelId: channel.id, messageId: message.id, type, createdBy });
};

const start = async (interaction, { replace = false, now = Date.now() } = {}) => {
  const existing = verifications.findByDiscord(interaction.user.id);
  if (existing && !replace) return interaction.reply({ embeds: [alreadyVerifiedEmbed(existing)], flags: MessageFlags.Ephemeral });
  if (!settings) throw new UserError('Roblox verification is not configured yet. Please contact a server administrator.');

  const state = crypto.randomBytes(32).toString('base64url');
  const url = roblox.authorizationUrl(settings, { state, verifier: verifierFor(state) });
  if (url.length > LINK_LIMIT) throw new UserError('Roblox verification is misconfigured (the redirect URI is too long). Please contact a server administrator.');

  const stateHash = hashState(state);
  const expiresAt = now + STATE_TTL;
  const panel = interaction.message ? verificationPanels.findByMessage(interaction.message.id) : null;
  const mode = replace ? 'relink' : 'link';
  oauthStates.create({ stateHash, discordId: interaction.user.id, guildId: interaction.guildId, panelId: panel?.id ?? null, mode, createdAt: now, expiresAt });
  remember(stateHash, interaction);

  return interaction.reply({ ...startMessage(url, expiresAt, existing), flags: MessageFlags.Ephemeral });
};

const buildNickname = (displayName, robloxUsername) => {
  const suffix = ` (@${robloxUsername})`;
  const room = NICKNAME_LIMIT - suffix.length;
  const characters = [...displayName.trim()];
  const name = characters.length > room ? `${characters.slice(0, room - 1).join('').trimEnd()}…` : characters.join('');
  return `${name}${suffix}`.trim();
};

const failureReason = (error, permission) => {
  if (error.code === RESTJSONErrorCodes.MissingPermissions) return permission;
  if (error.code === RESTJSONErrorCodes.UnknownRole) return 'The Member role no longer exists.';
  if (error.code === RESTJSONErrorCodes.UnknownMember) return 'You are no longer a member of the server.';
  return 'Discord rejected the change.';
};

const assignRole = async (guild, member) => {
  if (member.roles.cache.has(MEMBER_ROLE)) return { ok: true };
  if (!guild.roles.cache.has(MEMBER_ROLE)) return { ok: false, reason: 'The Member role no longer exists.' };
  try {
    await member.roles.add(MEMBER_ROLE, 'Roblox verification');
    return { ok: true };
  } catch (error) {
    console.error(`Failed to assign the Member role to ${member.id}: ${error.message}`);
    return { ok: false, reason: failureReason(error, "The bot is missing the Manage Roles permission or the Member role is above the bot's highest role.") };
  }
};

const updateNickname = async (guild, member, robloxUsername) => {
  const nickname = buildNickname(member.user.globalName ?? member.user.username, robloxUsername);
  if (member.nickname === nickname) return { ok: true, nickname };
  if (member.id === guild.ownerId) return { ok: false, reason: "Discord does not allow bots to change the server owner's nickname." };
  try {
    await member.setNickname(nickname, 'Roblox verification');
    return { ok: true, nickname };
  } catch (error) {
    console.error(`Failed to update the nickname of ${member.id}: ${error.message}`);
    return { ok: false, reason: failureReason(error, "The bot is missing the Manage Nicknames permission or your highest role is above the bot's.") };
  }
};

const applyMemberUpdates = async (guildId, discordId, robloxUsername) => {
  const guild = settings.client?.guilds.cache.get(guildId);
  if (!guild) return { guild: null, member: null };

  const member = await guild.members.fetch({ user: discordId, force: true }).catch((error) => {
    if (error.status === 404 || error.code === RESTJSONErrorCodes.UnknownMember) return null;
    throw error;
  });
  if (!member) return { guild, member: null };

  return { guild, member, role: await assignRole(guild, member), nickname: await updateNickname(guild, member, robloxUsername) };
};

const page = (status, title, lines, success = false) => ({ status, title, lines, success });

const ROBLOX_FAILURES = {
  invalid_grant: page(400, 'Verification failed', ['The Roblox authorization code is invalid or has expired.', 'Return to Discord and click Verify with Roblox again.']),
  unavailable: page(502, 'Roblox is unavailable', ['Roblox could not be reached. Please try again in a few minutes.']),
  invalid_response: page(502, 'Verification failed', ['Roblox returned an unexpected response. Please try again later.']),
};

const INVALID_STATE = page(400, 'Verification link expired', [
  'This verification link is invalid, has expired or was already used.',
  'Return to Discord and click Verify with Roblox again.',
]);

const describeUpdates = (updates) => {
  if (!updates.guild) return ['The server could not be reached, so the Member role and nickname were not updated.'];
  if (!updates.member) return ['You are no longer a member of the server, so the Member role and nickname could not be applied.'];
  return [
    updates.role.ok ? 'You have been given the Member role.' : `The Member role could not be assigned: ${updates.role.reason}`,
    updates.nickname.ok ? 'Your server nickname has been updated.' : `Your nickname could not be updated: ${updates.nickname.reason}`,
  ];
};

const authenticate = async (record, params, state) => {
  const error = params.get('error');
  if (error) {
    return error === 'access_denied'
      ? page(400, 'Verification cancelled', ['You cancelled the Roblox authorization. No account was linked.'])
      : page(400, 'Verification failed', ['Roblox could not complete the authorization. Please try again.']);
  }

  const code = params.get('code');
  if (!code) return page(400, 'Verification failed', ['Roblox did not return an authorization code. Please try again.']);

  const tokens = await roblox.exchangeCode(settings, code, verifierFor(state));
  const user = await roblox.fetchUser(settings, tokens.access_token);
  await roblox.revoke(settings, tokens.refresh_token);

  const { status, verification, previous } = verifications.link({
    discordId: record.discord_id,
    robloxId: user.id,
    robloxUsername: user.username,
    robloxDisplayName: user.displayName,
    guildId: record.guild_id,
    replace: record.mode === 'relink',
  });

  if (status === 'roblox-linked') {
    const lines = ['This Roblox account is already linked to another Discord account.'];
    if (verification) lines.push(`Your current verification (${verification.roblox_username}) was not changed.`);
    return page(409, 'Verification failed', lines);
  }
  if (status === 'discord-linked') {
    return page(409, 'Verification failed', [`Your Discord account is already verified with another Roblox account (${verification.roblox_username}).`]);
  }

  const updates = await applyMemberUpdates(record.guild_id, record.discord_id, verification.roblox_username);
  if (status !== 'already-verified' && updates.guild) await logging.sendEmbed(updates.guild, logEmbed(verification, updates, previous));

  const titles = { linked: 'Verification successful', relinked: 'Roblox account updated', 'already-verified': 'You are already verified' };
  return page(200, titles[status], [
    `Roblox username: ${verification.roblox_username}`,
    `Roblox ID: ${verification.roblox_id}`,
    ...(previous ? [`Previous Roblox account: ${previous.roblox_username}`] : []),
    '',
    ...describeUpdates(updates),
  ], true);
};

const settle = async (record, params, state) => {
  try {
    return await serialize(record.discord_id, () => authenticate(record, params, state));
  } catch (error) {
    console.error(`Roblox verification failed for ${record.discord_id}: ${error.message}`);
    return ROBLOX_FAILURES[error.kind] ?? page(500, 'Verification failed', ['An unexpected error occurred during verification. Please try again later.']);
  }
};

const handleCallback = async (params, now = Date.now()) => {
  if (!settings) return page(503, 'Verification unavailable', ['Roblox verification is not configured.']);
  const state = params.get('state');
  if (!state) return INVALID_STATE;

  const stateHash = hashState(state);
  const record = oauthStates.consume(stateHash);
  const interaction = take(stateHash);
  const result = record && record.expires_at > now ? await settle(record, params, state) : INVALID_STATE;

  await interaction?.editReply({ embeds: [resultEmbed(result)], components: [] }).catch(() => {});
  return result;
};

module.exports = { MEMBER_ROLE, configure, isConfigured, callbackPath, publishPanel, start, buildNickname, handleCallback };
