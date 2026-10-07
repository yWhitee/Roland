const { MessageFlags, PermissionFlagsBits, RESTJSONErrorCodes } = require('discord.js');
const verificationPanels = require('../../database/verificationPanels');
const verifications = require('../../database/verifications');
const logging = require('../logging');
const { UserError } = require('../../utils/errors');
const rover = require('./rover');
const { panelComponents, consentMessage, linkMessage, alreadyVerifiedEmbed, resultEmbed, logEmbed } = require('./messages');

const MEMBER_ROLE = '1555596685462479048';
const NICKNAME_LIMIT = 32;
const ROBLOX_SUFFIX = / \(@[A-Za-z0-9_]{3,20}\)$/;
const MANAGED = 1;
const PENDING = 2;
const COOLDOWN = 10_000;
const RETENTION = 30 * 24 * 60 * 60_000;
const CLEANUP_INTERVAL = 60 * 60_000;

let settings = null;
let blockedUntil = 0;
const lookups = new Map();
const queues = new Map();

const configure = ({ apiKey, fetch = globalThis.fetch } = {}) => {
  settings = apiKey ? { apiKey, fetch } : null;
  blockedUntil = 0;
  lookups.clear();
  return Boolean(settings);
};

const isConfigured = () => Boolean(settings);

const relative = (ms) => `<t:${Math.ceil(ms / 1000)}:R>`;

const serialize = (key, task) => {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
};

const publishPanel = async (channel, payload, { type, createdBy }) => {
  const message = await channel.send({ ...payload, components: panelComponents() });
  return verificationPanels.create({ guildId: channel.guild.id, channelId: channel.id, messageId: message.id, type, createdBy });
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

const lacks = (me, permission) => Boolean(me?.permissions?.has) && !me.permissions.has(permission);

const reaches = (role, me) => Boolean(role && me?.roles?.highest) && role.position >= me.roles.highest.position;

const roleProblem = (guild) => {
  const me = guild.members.me;
  if (lacks(me, PermissionFlagsBits.ManageRoles)) return 'Roland is missing the Manage Roles permission.';
  if (reaches(guild.roles.cache.get(MEMBER_ROLE), me)) return "The Member role is at or above Roland's highest role. A server admin must move Roland's role above Member in Server Settings → Roles.";
  return "The bot is missing the Manage Roles permission or the Member role is above the bot's highest role.";
};

const nicknameProblem = (guild, member) => {
  const me = guild.members.me;
  if (lacks(me, PermissionFlagsBits.ManageNicknames)) return 'Roland is missing the Manage Nicknames permission.';
  if (reaches(member.roles?.highest, me)) return "Your highest role is at or above Roland's highest role, so Discord does not let Roland change your nickname. A server admin must move Roland's role higher.";
  return "The bot is missing the Manage Nicknames permission or your highest role is above the bot's.";
};

const assignRole = async (guild, member) => {
  if (member.roles.cache.has(MEMBER_ROLE)) return { ok: true };
  if (!guild.roles.cache.has(MEMBER_ROLE)) return { ok: false, reason: 'The Member role no longer exists.' };
  try {
    await member.roles.add(MEMBER_ROLE, 'Roblox verification');
    return { ok: true };
  } catch (error) {
    console.error(`Failed to assign the Member role to ${member.id}: ${error.message}`);
    return { ok: false, reason: failureReason(error, roleProblem(guild)) };
  }
};

const unmanaged = (nickname) => (ROBLOX_SUFFIX.test(nickname ?? '') ? null : nickname);

const shows = (nickname, username) => Boolean(username && nickname?.endsWith(` (@${username})`));

const showsManaged = (record, nickname) =>
  shows(nickname, record.nickname_username) || (record.nickname_managed === PENDING && shows(nickname, record.roblox_username));

const setManagedNickname = async (guild, member, record, previous) => {
  const nickname = buildNickname(member.user.globalName ?? member.user.username, record.roblox_username);
  if (member.nickname === nickname) {
    verifications.manageNickname(member.id, previous);
    return { ok: true, nickname };
  }
  if (member.id === guild.ownerId) return { ok: false, reason: "Discord does not allow bots to change the server owner's nickname." };
  verifications.beginNickname(member.id, previous);
  try {
    await member.setNickname(nickname, 'Roblox verification');
    verifications.manageNickname(member.id, previous);
    return { ok: true, nickname };
  } catch (error) {
    verifications.resetNickname(member.id, record);
    console.error(`Failed to update the nickname of ${member.id}: ${error.message}`);
    return { ok: false, reason: failureReason(error, nicknameProblem(guild, member)) };
  }
};

const updateNickname = async (guild, member, record, accountChanged) => {
  if (record.nickname_managed === MANAGED && !showsManaged(record, member.nickname)) {
    if (!accountChanged) {
      verifications.resetNickname(member.id, { ...record, nickname_username: null });
      return { ok: true, kept: true };
    }
    return setManagedNickname(guild, member, record, unmanaged(member.nickname));
  }
  return setManagedNickname(guild, member, record, record.nickname_managed ? record.previous_nickname : unmanaged(member.nickname));
};

const restoreNickname = async (guild, record) => {
  if (!guild || !record.nickname_managed) return;
  const member = await guild.members.fetch({ user: record.discord_id, force: true }).catch(() => null);
  if (!member || !showsManaged(record, member.nickname) || member.id === guild.ownerId) return;
  await member.setNickname(record.previous_nickname, 'Roblox verification data removed').catch((error) => {
    console.error(`Failed to restore the nickname of ${member.id}: ${error.message}`);
  });
};

const refreshNickname = (guild, member, record) =>
  record.nickname_managed === MANAGED && record.nickname_username && !member.nickname
    ? setManagedNickname(guild, member, record, record.previous_nickname)
    : updateNickname(guild, member, record, false);

const fetchMember = (guild, discordId) =>
  guild.members.fetch({ user: discordId, force: true }).catch((error) => {
    if (error.status === 404 || error.code === RESTJSONErrorCodes.UnknownMember) return null;
    throw error;
  });

const applyMemberUpdates = async (guild, record, accountChanged) => {
  const member = await fetchMember(guild, record.discord_id);
  if (!member) return { member: null };

  return { member, role: await assignRole(guild, member), nickname: await updateNickname(guild, member, record, accountChanged) };
};

const reapply = (guild, discordId) =>
  serialize(discordId, async () => {
    const record = verifications.findByDiscord(discordId);
    if (!record) return null;
    const member = await fetchMember(guild, discordId);
    if (!member) return { member: null };
    return { member, role: await assignRole(guild, member), nickname: await refreshNickname(guild, member, record) };
  });

const isValid = (record, now) => record.expires_at === null || record.expires_at > now;

const handleJoin = (member, now = Date.now()) =>
  serialize(member.id, async () => {
    const record = verifications.findByDiscord(member.id);
    if (!record || (record.guild_id && record.guild_id !== member.guild.id) || !isValid(record, now)) return null;
    const role = await assignRole(member.guild, member);
    const reapply = record.nickname_managed === PENDING || (record.nickname_managed === MANAGED && record.nickname_username);
    return { role, nickname: reapply ? await setManagedNickname(member.guild, member, record, record.previous_nickname) : null };
  });

const result = (title, lines, success = false) => ({ embeds: [resultEmbed({ title, lines, success })], components: [] });

const UNAVAILABLE = result('Verification unavailable', ['RoVer could not be reached right now. Please try again in a few minutes.']);

const NOTICES = {
  requested: [
    'RoVer sent you a direct message asking whether this server can see your Roblox account.',
    '',
    '1. Open the DM from **RoVer** and click **Allow**.',
    '2. Come back here and click **Check again**.',
    '',
    'Your Roblox account is only shared with this server if you allow it.',
  ],
  pending: ['RoVer already sent you an authorization request.', '', 'Open the DM from **RoVer**, click **Allow**, then click **Check again**.'],
  dm_unreachable: [
    'RoVer could not send you a direct message with the authorization request.',
    '',
    'Allow direct messages from this server and make sure you can receive messages from **RoVer**, then click **Check again**.',
  ],
};

const NOT_LINKED = {
  first: [
    'Your Discord account is not linked to a Roblox account yet.',
    '',
    '**To continue:**',
    '1. Click **Verify with Roblox** below.',
    '2. Complete the Roblox verification on the official RoVer website.',
    '3. Return to this server.',
    '4. Click **Check again**.',
    '',
    'Your Roblox account will only be linked to Roland after you complete the verification.',
  ],
  again: [
    "We still couldn't find a Roblox account linked to your Discord account.",
    '',
    "If you haven't completed the verification yet, click **Verify with Roblox** below.",
    'After completing it, return here and click **Check again**.',
  ],
};

const ERRORS = {
  member_not_in_guild: result('Verification failed', ['RoVer could not find you in this server. Please try again in a few minutes.']),
  discord_error: result('Verification unavailable', ['RoVer could not reach Discord right now. Please try again in a few minutes.']),
  bot_not_in_guild: result('Verification unavailable', ['Roblox verification is not available right now. Please contact a server administrator.']),
};

const LOGGED = {
  unauthorized: 'RoVer rejected ROVER_API_KEY. Check the key in .env.',
  bot_not_in_guild: 'RoVer is not in this server. Add the RoVer bot so it can send authorization requests.',
};

const describeUpdates = (updates) => {
  if (!updates.member) return ['You are no longer a member of the server, so the Member role and nickname could not be applied.'];
  return [
    updates.role.ok ? 'You have been given the Member role.' : `The Member role could not be assigned: ${updates.role.reason}`,
    updates.nickname.kept
      ? 'Your server nickname was kept because you changed it.'
      : updates.nickname.ok
        ? 'Your server nickname has been updated.'
        : `Your nickname could not be updated: ${updates.nickname.reason}`,
  ];
};

const failure = (error, replace, now, retry) => {
  if (!(error instanceof rover.RoverError)) throw error;
  if (error.kind === 'user_not_found') return linkMessage(retry ? NOT_LINKED.again : NOT_LINKED.first, replace);
  if (NOTICES[error.kind]) return consentMessage(NOTICES[error.kind], replace);
  if (error.kind === 'rate_limited') {
    blockedUntil = Math.max(blockedUntil, now + error.retryAfter);
    return result('Too many requests', [`RoVer is receiving too many requests. Please try again ${relative(blockedUntil)}.`]);
  }
  if (error.kind !== 'member_not_in_guild') console.error(LOGGED[error.kind] ?? `RoVer lookup failed: ${error.message}`);
  return ERRORS[error.kind] ?? UNAVAILABLE;
};

const find = async (guild, discordId) => {
  try {
    return { account: await rover.lookup(settings, guild.id, discordId) };
  } catch (error) {
    if (!(error instanceof rover.RoverError) || error.kind !== 'user_not_found') throw error;
  }
  const removed = verifications.removeExpiring(discordId);
  if (removed) await restoreNickname(guild, removed);
  const access = await rover.requestAccess(settings, guild.id, discordId);
  return access === 'authorized' ? { account: await rover.lookup(settings, guild.id, discordId) } : { access };
};

const verify = async (interaction, replace, now, retry) => {
  let found;
  try {
    found = await find(interaction.guild, interaction.user.id);
  } catch (error) {
    return failure(error, replace, now, retry);
  }
  if (found.access) return consentMessage(NOTICES[found.access], replace);
  const { account } = found;

  const { status, verification, previous } = verifications.link({
    discordId: interaction.user.id,
    robloxId: account.id,
    robloxUsername: account.username,
    guildId: interaction.guildId,
    verifiedAt: now,
    expiresAt: now + RETENTION,
    replace,
  });

  if (status === 'roblox-linked') {
    const lines = ['This Roblox account is already linked to another Discord account.'];
    if (verification) lines.push(`Your current verification (${verification.roblox_username}) was not changed.`);
    return result('Verification failed', lines);
  }
  if (status === 'discord-linked') {
    return result('Verification failed', [`Your Discord account is already verified with another Roblox account (${verification.roblox_username}).`]);
  }

  const updates = await applyMemberUpdates(interaction.guild, verification, status === 'relinked');
  if (status !== 'already-verified') await logging.sendEmbed(interaction.guild, logEmbed(verification, updates, Boolean(previous)));

  const titles = { linked: 'Verification successful', relinked: 'Roblox account updated', 'already-verified': 'You are already verified' };
  return result(titles[status], [
    `Roblox username: ${verification.roblox_username}`,
    `Roblox ID: ${verification.roblox_id}`,
    ...(previous ? [`Previous Roblox account: ${previous.roblox_username}`] : []),
    '',
    ...describeUpdates(updates),
  ], true);
};

const start = async (interaction, { replace = false, update = false, now = Date.now() } = {}) => {
  const existing = verifications.findByDiscord(interaction.user.id);
  if (existing && !replace) {
    if (!isValid(existing, now)) return interaction.reply({ embeds: [alreadyVerifiedEmbed(existing)], flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const updates = await reapply(interaction.guild, interaction.user.id);
    return interaction.editReply({ embeds: [alreadyVerifiedEmbed(existing, updates ? describeUpdates(updates) : [])] });
  }
  if (!settings) throw new UserError('Roblox verification is not configured yet. Please contact a server administrator.');
  if (now < blockedUntil) throw new UserError(`RoVer is receiving too many requests. Please try again ${relative(blockedUntil)}.`);
  if (now - (lookups.get(interaction.user.id) ?? -Infinity) < COOLDOWN) throw new UserError('Please wait a few seconds before checking again.');

  lookups.set(interaction.user.id, now);
  setTimeout(() => lookups.get(interaction.user.id) === now && lookups.delete(interaction.user.id), COOLDOWN).unref();

  await (update ? interaction.deferUpdate() : interaction.deferReply({ flags: MessageFlags.Ephemeral }));
  return interaction.editReply(await serialize(interaction.user.id, () => verify(interaction, replace, now, update)));
};

const cleanup = async (now = Date.now(), client = null) => {
  const expired = verifications.purgeExpired(now);
  for (const record of expired) {
    await serialize(record.discord_id, () =>
      verifications.findByDiscord(record.discord_id) ? null : restoreNickname(client?.guilds.cache.get(record.guild_id), record),
    );
  }
  return expired.length;
};

const startCleanup = (client) => {
  const run = () => cleanup(Date.now() + CLEANUP_INTERVAL, client).catch((error) => console.error(`Failed to remove expired verification data: ${error.message}`));
  run();
  setInterval(run, CLEANUP_INTERVAL).unref();
};

module.exports = { MEMBER_ROLE, RETENTION, configure, isConfigured, publishPanel, start, buildNickname, handleJoin, cleanup, startCleanup };
