const { RESTJSONErrorCodes } = require('discord.js');
const punishments = require('../database/punishments');
const permissions = require('../permissions');
const logging = require('./logging');
const { parseDuration, assertTimeout } = require('../utils/duration');
const { warnDmEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

const MAX_CLEAR = 5000;
const BULK_DELETE_MAX_AGE = 14 * 86_400_000 - 60_000;
const CLEAR_MAX_FETCHES = 100;
const CLEAR_TIME_LIMIT = 14 * 60_000;

const requireReason = (reason) => {
  const value = reason?.trim();
  if (!value) throw new UserError('Informe um motivo.');
  return value;
};

const requireMember = (target) => {
  if (!target.member) throw new UserError('Este usuário não está no servidor.');
};

const auditReason = (moderator, reason) => `${moderator.user.tag}: ${reason}`.slice(0, 512);

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
  if (await isBanned(guild, target.user.id)) throw new UserError('Este usuário já está banido.');

  await guild.members.ban(target.user.id, { reason: auditReason(moderator, reason) });
  return record(guild, {
    type: 'ban',
    userId: target.user.id,
    moderatorId: moderator.id,
    reason,
    duration: parsed.input,
    expiresAt: parsed.expiresAt,
    active: true,
    channelId,
  });
};

const kick = async ({ guild, moderator, target, reason, channelId }) => {
  reason = requireReason(reason);
  requireMember(target);
  permissions.assertCanModerate(moderator, target);

  await target.member.kick(auditReason(moderator, reason));
  return record(guild, { type: 'kick', userId: target.user.id, moderatorId: moderator.id, reason, channelId });
};

const mute = async ({ guild, moderator, target, duration, reason, channelId }) => {
  reason = requireReason(reason);
  requireMember(target);
  permissions.assertCanModerate(moderator, target);
  const parsed = parseDuration(duration);
  assertTimeout(parsed);
  if (target.member.isCommunicationDisabled()) throw new UserError('Este usuário já está mutado.');

  await target.member.disableCommunicationUntil(parsed.expiresAt, auditReason(moderator, reason));
  return record(guild, {
    type: 'mute',
    userId: target.user.id,
    moderatorId: moderator.id,
    reason,
    duration: parsed.input,
    expiresAt: parsed.expiresAt,
    channelId,
  });
};

const unmute = async ({ guild, moderator, target, reason, channelId }) => {
  reason = requireReason(reason);
  requireMember(target);
  permissions.assertCanModerate(moderator, target);
  if (!target.member.isCommunicationDisabled()) throw new UserError('Este usuário não está mutado.');

  await target.member.timeout(null, auditReason(moderator, reason));
  return record(guild, { type: 'unmute', userId: target.user.id, moderatorId: moderator.id, reason, channelId });
};

const unban = async ({ guild, moderator, target, reason, channelId }) => {
  reason = requireReason(reason);
  if (!(await isBanned(guild, target.user.id))) throw new UserError('Este usuário não está banido.');

  await guild.bans.remove(target.user.id, auditReason(moderator, reason));
  punishments.deactivateBans(guild.id, target.user.id);
  return record(guild, { type: 'unban', userId: target.user.id, moderatorId: moderator.id, reason, channelId });
};

const warn = async ({ guild, moderator, target, reason, channelId }) => {
  reason = requireReason(reason);
  requireMember(target);
  permissions.assertCanModerate(moderator, target);

  const entry = await record(guild, { type: 'warn', userId: target.user.id, moderatorId: moderator.id, reason, channelId });
  const dmSent = await target.user.send({ embeds: [warnDmEmbed(guild, moderator, entry)] }).then(() => true, () => false);
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
  if (!channel?.messages || !channel.bulkDelete) throw new UserError('Este canal não suporta a limpeza de mensagens.');
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CLEAR) throw new UserError(`A quantidade deve estar entre 1 e ${MAX_CLEAR}.`);
  if (target) permissions.assertCanModerate(moderator, target);

  const deleted = await deleteMessages(channel, amount, target?.user.id);
  return record(guild, {
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

  const reason = `Ban temporário expirado (registro #${ban.id})`;
  try {
    await guild.bans.remove(ban.user_id, reason);
  } catch (error) {
    if (error.code !== RESTJSONErrorCodes.UnknownBan) throw error;
    punishments.deactivateBans(guild.id, ban.user_id);
    return null;
  }

  punishments.deactivateBans(guild.id, ban.user_id);
  return record(guild, { type: 'unban', userId: ban.user_id, moderatorId: client.user.id, reason });
};

const history = (guildId, userId, page, size) => {
  const total = punishments.countByUser(guildId, userId);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(page, 0), pages - 1);
  return { total, pages, page: current, records: punishments.listByUser(guildId, userId, size, current * size) };
};

module.exports = { MAX_CLEAR, ban, kick, mute, unmute, unban, warn, clear, expireBan, history };
