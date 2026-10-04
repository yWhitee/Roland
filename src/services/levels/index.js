const { MessageType, RESTJSONErrorCodes } = require('discord.js');
const levelRewards = require('../../database/levelRewards');
const levels = require('../../database/levels');
const { ROLES } = require('../../permissions');
const logging = require('../logging');
const { MEMBER_ROLE } = require('../verification');
const { UserError } = require('../../utils/errors');
const messages = require('./messages');

const XP_PER_LEVEL = 100;
const XP_PER_MESSAGE = 2;
const MAX_LEVEL = 200;
const MAX_XP = levels.MAX_XP;
const MULTIPLIER = 2;
const ACTIVITY_THRESHOLD = 100;
const ACTIVITY_WINDOW = 60 * 60_000;
const SWEEP_INTERVAL = 5 * 60_000;
const LEADERBOARD_SIZE = 10;
const NORMAL_TYPES = new Set([MessageType.Default, MessageType.Reply]);
const PROTECTED_ROLES = new Set([...Object.values(ROLES), MEMBER_ROLE]);

const activity = new Map();
const processed = new Map();

// Level 1 starts at 0 XP and every level needs 100 XP: 0-99 XP is level 1, 100-199 XP is level 2, capped at level 200.
const levelFor = (xp) => Math.min(MAX_LEVEL, Math.floor(xp / XP_PER_LEVEL) + 1);

const xpFor = (level) => (level - 1) * XP_PER_LEVEL;

const validateLevel = (level) => {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) throw new UserError(`The level must be a whole number from 1 to ${MAX_LEVEL}.`);
  return level;
};

const recentMessages = (key, now) => {
  const timestamps = activity.get(key);
  if (!timestamps) return [];
  while (timestamps.length && timestamps[0] <= now - ACTIVITY_WINDOW) timestamps.shift();
  if (!timestamps.length) activity.delete(key);
  return timestamps;
};

const track = (key, now) => {
  const timestamps = recentMessages(key, now);
  const before = timestamps.length;
  timestamps.push(now);
  if (timestamps.length > ACTIVITY_THRESHOLD) timestamps.shift();
  activity.set(key, timestamps);
  return { before, after: before + 1 };
};

const isEligible = (message) =>
  message.inGuild() && !message.author.bot && !message.webhookId && !message.system && NORMAL_TYPES.has(message.type) && Boolean(message.member);

const findMember = async (guild, userId) =>
  guild.members.cache.get(userId) ??
  guild.members.fetch(userId).catch((error) => {
    if (error.status === 404 || error.code === RESTJSONErrorCodes.UnknownMember) return null;
    throw error;
  });

const failureReason = (error) =>
  error.code === RESTJSONErrorCodes.MissingPermissions ? 'Roland cannot manage this role (role hierarchy or Manage Roles).' : error.message;

const syncReward = async (guild, member, level, retired = []) => {
  const rewards = levelRewards.list(guild.id);
  const target = rewards.filter((reward) => reward.level <= level).at(-1) ?? null;
  const result = { added: null, removed: [], failed: [] };

  const candidates = [...rewards.map((reward) => reward.role_id), ...retired];
  const stale = new Set(candidates.filter((roleId) => roleId !== target?.role_id && !PROTECTED_ROLES.has(roleId)));
  for (const roleId of stale) {
    if (!member.roles.cache.has(roleId)) continue;
    try {
      await member.roles.remove(roleId, 'Level reward replaced');
      result.removed.push(roleId);
    } catch (error) {
      result.failed.push({ roleId, action: 'remove', reason: failureReason(error) });
    }
  }

  if (target && !member.roles.cache.has(target.role_id)) {
    if (!guild.roles.cache.has(target.role_id)) {
      result.failed.push({ roleId: target.role_id, action: 'add', reason: 'The role no longer exists.' });
    } else {
      try {
        await member.roles.add(target.role_id, `Level ${target.level} reward`);
        result.added = target.role_id;
      } catch (error) {
        result.failed.push({ roleId: target.role_id, action: 'add', reason: failureReason(error) });
      }
    }
  }

  if (result.failed.length) {
    console.error(`Failed to update level rewards for ${member.id}: ${result.failed.map((failure) => `${failure.action} ${failure.roleId} (${failure.reason})`).join(', ')}`);
    await logging.sendEmbed(guild, messages.rewardFailureEmbed(member, result.failed));
  }
  return result;
};

const handleMessage = async (message, now = message.createdTimestamp ?? Date.now()) => {
  if (!isEligible(message) || processed.has(message.id)) return null;
  processed.set(message.id, now);

  const { guild, member } = message;
  const { before, after } = track(`${guild.id}:${member.id}`, now);
  const boosted = after >= ACTIVITY_THRESHOLD;
  const { previous, xp, gained } = levels.addXp(guild.id, member.id, XP_PER_MESSAGE * (boosted ? MULTIPLIER : 1), now);
  const level = levelFor(xp);
  const previousLevel = levelFor(previous);

  const notified = before < ACTIVITY_THRESHOLD && boosted && gained > 0;
  if (notified) await member.user.send({ embeds: [messages.boostNotice(guild)] }).catch(() => {});
  const rewards = level > previousLevel ? await syncReward(guild, member, level) : null;

  return { gained, xp, level, previousLevel, boosted, notified, rewards };
};

const profile = (guildId, userId) => {
  const xp = levels.get(guildId, userId)?.xp ?? 0;
  return { xp, level: levelFor(xp) };
};

const setLevel = async (guild, member, level, now = Date.now()) => {
  validateLevel(level);
  if (member.user.bot) throw new UserError('Bots cannot have levels.');
  const { previous, xp } = levels.setXp(guild.id, member.id, xpFor(level), now);
  const rewards = await syncReward(guild, member, level);
  return { previous: { xp: previous, level: levelFor(previous) }, xp, level, rewards };
};

const setReward = async (guild, role, level, createdBy) => {
  validateLevel(level);
  if (!role) throw new UserError('Role not found.');
  if (role.id === guild.id) throw new UserError('@everyone cannot be used as a level reward.');
  if (PROTECTED_ROLES.has(role.id)) throw new UserError('Staff roles and the Member role cannot be used as level rewards.');
  if (role.managed) throw new UserError('This role is managed by an integration and cannot be assigned.');
  if (!role.editable) throw new UserError('Roland cannot manage this role. Move the Roland role above it and make sure Roland has the Manage Roles permission.');

  const previous = levelRewards.set(guild.id, level, role.id, createdBy);
  const otherLevels = levelRewards.levelsForRole(guild.id, role.id).filter((other) => other !== level);
  const retired = previous && previous !== role.id ? [previous] : [];

  const updated = { members: 0, failed: 0 };
  for (const row of levels.atLeast(guild.id, xpFor(level))) {
    const member = await findMember(guild, row.user_id).catch(() => null);
    if (!member || member.user.bot) continue;
    const result = await syncReward(guild, member, levelFor(row.xp), retired);
    if (result.added || result.removed.length) updated.members++;
    if (result.failed.length) updated.failed++;
  }

  return { previous: previous === role.id ? null : previous, otherLevels, updated };
};

const leaderboard = async (guild) => {
  const entries = [];
  for (let offset = 0; entries.length < LEADERBOARD_SIZE; offset += 50) {
    const rows = levels.ranked(guild.id, 50, offset);
    for (const row of rows) {
      const member = await findMember(guild, row.user_id);
      if (member && !member.user.bot) entries.push({ ...row, level: levelFor(row.xp) });
      if (entries.length === LEADERBOARD_SIZE) break;
    }
    if (rows.length < 50) break;
  }
  return entries;
};

const sweep = (now = Date.now()) => {
  for (const key of [...activity.keys()]) recentMessages(key, now);
  for (const [id, at] of processed) if (at <= now - ACTIVITY_WINDOW) processed.delete(id);
};

const start = () => setInterval(() => sweep(), SWEEP_INTERVAL);

module.exports = {
  XP_PER_LEVEL,
  XP_PER_MESSAGE,
  MAX_LEVEL,
  MAX_XP,
  ACTIVITY_THRESHOLD,
  ACTIVITY_WINDOW,
  levelFor,
  xpFor,
  handleMessage,
  syncReward,
  profile,
  setLevel,
  setReward,
  leaderboard,
  sweep,
  start,
};
