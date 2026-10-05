const { RESTJSONErrorCodes } = require('discord.js');
const punishments = require('../database/punishments');
const permissions = require('../permissions');
const logging = require('./logging');
const { parseDuration, assertTimeout } = require('../utils/duration');
const { caseRemovedEmbed, casesRemovedEmbed, noticeEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

const MAX_CLEAR = 5000;
const BULK_DELETE_MAX_AGE = 14 * 86_400_000 - 60_000;
const CLEAR_MAX_FETCHES = 100;
const CLEAR_TIME_LIMIT = 14 * 60_000;

const requireReason = (reason) => {
  const value = reason?.trim();
  if (!value) throw new UserError('Please provide a reason.');
  return value;
};

const requireMember = (target) => {
  if (!target.member) throw new UserError('This user is not a member of the server.');
};

const names = (target, moderator) => ({
  userName: target?.user?.username ?? null,
  userDisplayName: target?.member?.displayName ?? target?.user?.globalName ?? target?.user?.username ?? null,
  moderatorName: moderator?.user?.username ?? null,
  moderatorDisplayName: moderator?.displayName ?? moderator?.user?.globalName ?? moderator?.user?.username ?? null,
});

const roland = (guild) => guild.members.me ?? { user: guild.client.user };

const auditReason = (moderator, reason) => `${moderator.user.tag}: ${reason}`.slice(0, 512);

const notify = (guild, moderator, user, notice) =>
  user.send({ embeds: [noticeEmbed(guild, moderator, { createdAt: Date.now(), ...notice })] }).catch(() => null);

const withNotice = async (guild, moderator, user, notice, action) => {
  const message = await notify(guild, moderator, user, notice);
  try {
    await action();
  } catch (error) {
    await message?.delete().catch(() => {});
    throw error;
  }
  return Boolean(message);
};

const isBanned = (guild, userId) =>
  guild.bans.fetch({ user: userId, force: true }).then(
    () => true,
    (error) => {
      if (error.code === RESTJSONErrorCodes.UnknownBan) return false;
      throw error;
    },
  );

const record = async (guild, data) => {
  const entry = punishments.create({ guildId: guild.id, ...data });
  await logging.send(guild, entry);
  return entry;
};

const ban = async ({ guild, moderator, target, duration, reason, channelId }) => {
  reason = requireReason(reason);
  permissions.assertCanModerate(moderator, target);
  const parsed = parseDuration(duration);
  if (await isBanned(guild, target.user.id)) throw new UserError('This user is already banned.');

  const notice = { type: 'ban', reason, duration: parsed.input, expiresAt: parsed.expiresAt };
  const dmSent = await withNotice(guild, moderator, target.user, notice, () =>
    guild.members.ban(target.user.id, { reason: auditReason(moderator, reason) }),
  );

  const entry = await record(guild, {
    ...names(target, moderator),
    type: 'ban',
    userId: target.user.id,
    moderatorId: moderator.id,
    reason,
    duration: parsed.input,
    expiresAt: parsed.expiresAt,
    active: true,
    channelId,
  });
  return { record: entry, dmSent };
};

const kick = async ({ guild, moderator, target, reason, channelId }) => {
  reason = requireReason(reason);
  requireMember(target);
  permissions.assertCanModerate(moderator, target);

  const dmSent = await withNotice(guild, moderator, target.user, { type: 'kick', reason }, () =>
    target.member.kick(auditReason(moderator, reason)),
  );

  const entry = await record(guild, { ...names(target, moderator), type: 'kick', userId: target.user.id, moderatorId: moderator.id, reason, channelId });
  return { record: entry, dmSent };
};

const mute = async ({ guild, moderator, target, duration, reason, channelId }) => {
  reason = requireReason(reason);
  requireMember(target);
  permissions.assertCanModerate(moderator, target);
  const parsed = parseDuration(duration);
  assertTimeout(parsed);
  if (target.member.isCommunicationDisabled()) throw new UserError('This user is already muted.');

  await target.member.disableCommunicationUntil(parsed.expiresAt, auditReason(moderator, reason));
  const entry = await record(guild, {
    ...names(target, moderator),
    type: 'mute',
    userId: target.user.id,
    moderatorId: moderator.id,
    reason,
    duration: parsed.input,
    expiresAt: parsed.expiresAt,
    channelId,
  });

  const notice = { type: 'mute', reason, duration: parsed.input, expiresAt: parsed.expiresAt, createdAt: entry.created_at };
  const dmSent = Boolean(await notify(guild, moderator, target.user, notice));
  return { record: entry, dmSent };
};

const unmute = async ({ guild, moderator, target, reason, channelId }) => {
  reason = requireReason(reason);
  requireMember(target);
  permissions.assertCanModerate(moderator, target);
  if (!target.member.isCommunicationDisabled()) throw new UserError('This user is not muted.');

  await target.member.timeout(null, auditReason(moderator, reason));
  return record(guild, { ...names(target, moderator), type: 'unmute', userId: target.user.id, moderatorId: moderator.id, reason, channelId });
};

const unban = async ({ guild, moderator, target, reason, channelId }) => {
  reason = requireReason(reason);
  if (!(await isBanned(guild, target.user.id))) throw new UserError('This user is not banned.');

  await guild.bans.remove(target.user.id, auditReason(moderator, reason));
  punishments.deactivateBans(guild.id, target.user.id);
  return record(guild, { ...names(target, moderator), type: 'unban', userId: target.user.id, moderatorId: moderator.id, reason, channelId });
};

const warn = async ({ guild, moderator, target, reason, channelId }) => {
  reason = requireReason(reason);
  requireMember(target);
  permissions.assertCanModerate(moderator, target);

  const entry = await record(guild, { ...names(target, moderator), type: 'warn', userId: target.user.id, moderatorId: moderator.id, reason, channelId });
  const dmSent = Boolean(await notify(guild, moderator, target.user, { type: 'warn', reason, createdAt: entry.created_at }));
  return { record: entry, dmSent };
};

const deleteMessages = async (channel, amount, userId) => {
  const deadline = Date.now() + CLEAR_TIME_LIMIT;
  let deleted = 0;
  let before;

  for (let fetches = 0; fetches < CLEAR_MAX_FETCHES && deleted < amount && Date.now() < deadline; fetches++) {
    const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
    if (!batch.size) break;
    before = batch.lastKey();

    const targets = [...batch.values()]
      .filter((message) => message.deletable && !message.pinned && (!userId || message.author.id === userId))
      .slice(0, amount - deleted);
    const recent = targets.filter((message) => Date.now() - message.createdTimestamp < BULK_DELETE_MAX_AGE);
    const old = targets.filter((message) => !recent.includes(message));

    if (recent.length) deleted += (await channel.bulkDelete(recent)).size;
    for (const message of old) {
      if (Date.now() >= deadline) break;
      await message.delete().then(() => deleted++, () => {});
    }
  }

  return deleted;
};

const clear = async ({ guild, moderator, channel, amount, target }) => {
  if (!channel?.messages || !channel.bulkDelete) throw new UserError('Messages cannot be cleared in this channel.');
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CLEAR) throw new UserError(`The amount must be between 1 and ${MAX_CLEAR}.`);
  if (target) permissions.assertCanModerate(moderator, target);

  const deleted = await deleteMessages(channel, amount, target?.user.id);
  return record(guild, {
    ...names(target, moderator),
    type: 'clear',
    userId: target?.user.id,
    moderatorId: moderator.id,
    channelId: channel.id,
    metadata: { requested: amount, deleted },
  });
};

const expireBan = async (client, ban) => {
  const guild = client.guilds.cache.get(ban.guild_id);
  if (!guild) return null;

  const reason = `Temporary ban expired (record #${ban.id})`;
  try {
    await guild.bans.remove(ban.user_id, reason);
  } catch (error) {
    if (error.code !== RESTJSONErrorCodes.UnknownBan) throw error;
    punishments.deactivateBans(guild.id, ban.user_id);
    return null;
  }

  punishments.deactivateBans(guild.id, ban.user_id);
  return record(guild, {
    ...names(null, { user: client.user }),
    userName: ban.user_name,
    userDisplayName: ban.user_display_name,
    type: 'unban',
    userId: ban.user_id,
    moderatorId: client.user.id,
    reason,
  });
};

const automodWarn = ({ guild, userId, member, functionId, reason, channelId }) =>
  punishments.create({
    ...names(member && { user: member.user, member }, roland(guild)),
    type: 'warn',
    guildId: guild.id,
    userId,
    moderatorId: guild.client.user.id,
    reason,
    channelId,
    source: 'automod',
    automodFunction: functionId,
  });

const automodMute = async ({ guild, member, duration, functionId, reason, channelId }) => {
  const parsed = parseDuration(duration);
  assertTimeout(parsed);
  if ((member.communicationDisabledUntilTimestamp ?? 0) < parsed.expiresAt) {
    await member.disableCommunicationUntil(parsed.expiresAt, `Roland AutoMod (${functionId}): ${reason}`.slice(0, 512));
  }
  return punishments.create({
    ...names({ user: member.user, member }, roland(guild)),
    type: 'mute',
    guildId: guild.id,
    userId: member.id,
    moderatorId: guild.client.user.id,
    reason,
    duration: parsed.input,
    expiresAt: parsed.expiresAt,
    channelId,
    source: 'automod',
    automodFunction: functionId,
  });
};

const caseNumberOf = (input) => Number(String(input).trim().match(/^#?(\d{1,15})$/)?.[1] ?? 0) || null;

const removeCase = async ({ guild, moderator, userId, caseNumber, now = Date.now() }) => {
  const result = punishments.removeCase({
    guildId: guild.id,
    userId,
    caseNumber,
    removedBy: moderator.id,
    removedByName: moderator.user?.username ?? null,
    removedAt: now,
  });
  if (result.status === 'missing') throw new UserError(`Case #${caseNumber} does not exist in this server.`);
  if (result.status === 'other-user') throw new UserError(`Case #${caseNumber} does not belong to <@${userId}>.`);
  if (result.status === 'already-removed') throw new UserError(`Case #${caseNumber} was already removed from the modlog.`);
  await logging.sendEmbed(guild, caseRemovedEmbed(result.record));
  return result.record;
};

const removeUserCases = async ({ guild, moderator, userId, now = Date.now() }) => {
  const caseNumbers = punishments.removeUserCases({
    guildId: guild.id,
    userId,
    removedBy: moderator.id,
    removedByName: moderator.user?.username ?? null,
    removedAt: now,
  });
  if (!caseNumbers.length) {
    throw new UserError(
      punishments.countUserCases(guild.id, userId)
        ? `All cases of <@${userId}> were already removed from the modlog.`
        : `<@${userId}> has no cases in this server.`,
    );
  }
  await logging.sendEmbed(guild, casesRemovedEmbed({ userId, caseNumbers, removedBy: moderator.id, removedAt: now }));
  return caseNumbers;
};

const history = (guildId, userId, page, size) => {
  const total = punishments.countByUser(guildId, userId);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(page, 0), pages - 1);
  return { total, pages, page: current, records: punishments.listByUser(guildId, userId, size, current * size) };
};

module.exports = {
  MAX_CLEAR,
  ban,
  kick,
  mute,
  unmute,
  unban,
  warn,
  clear,
  expireBan,
  automodWarn,
  automodMute,
  caseNumberOf,
  removeCase,
  removeUserCases,
  history,
};
