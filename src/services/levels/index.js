const { MessageType, RESTJSONErrorCodes } = require('discord.js');
const levelRewards = require('../../database/levelRewards');
const levels = require('../../database/levels');
const logging = require('../logging');
const { UserError } = require('../../utils/errors');
const messages = require('./messages');

const XP_PER_LEVEL = 100;
const XP_PER_MESSAGE = 2;
const MULTIPLIER = 2;
const ACTIVITY_THRESHOLD = 100;
const ACTIVITY_WINDOW = 60 * 60_000;
const SWEEP_INTERVAL = 5 * 60_000;
const NORMAL_TYPES = new Set([MessageType.Default, MessageType.Reply]);

const activity = new Map();
const processed = new Map();

// Level 0 covers 0-99 XP; every following level needs another 100 XP, so level = floor(xp / 100).
const levelFor = (xp) => Math.floor(xp / XP_PER_LEVEL);

const xpFor = (level) => level * XP_PER_LEVEL;

const validateLevel = (level) => {
  if (!Number.isSafeInteger(level) || level < 1) throw new UserError('The level must be a whole number of 1 or more.');
  if (!Number.isSafeInteger(xpFor(level))) throw new UserError('That level is too large to store.');
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

const grantRewards = async (guild, member, level) => {
  const granted = [];
  const failed = [];
  const owned = new Set(member.roles.cache.keys());

  for (const reward of levelRewards.upTo(guild.id, level)) {
    if (owned.has(reward.role_id)) continue;
    if (!guild.roles.cache.has(reward.role_id)) {
      failed.push({ reward, reason: 'The role no longer exists.' });
      continue;
    }
    try {
      await member.roles.add(reward.role_id, `Level ${reward.level} reward`);
      owned.add(reward.role_id);
      granted.push(reward);
    } catch (error) {
      const reason = error.code === RESTJSONErrorCodes.MissingPermissions ? "Roland cannot manage this role (role hierarchy or Manage Roles)." : error.message;
      failed.push({ reward, reason });
    }
  }

  if (failed.length) {
    console.error(`Failed to grant level rewards to ${member.id}: ${failed.map(({ reward, reason }) => `level ${reward.level} (${reason})`).join(', ')}`);
    await logging.sendEmbed(guild, messages.rewardFailureEmbed(member, failed));
  }
  return { granted, failed };
};

const handleMessage = async (message, now = message.createdTimestamp ?? Date.now()) => {
  if (!isEligible(message) || processed.has(message.id)) return null;
  processed.set(message.id, now);

  const { guild, member } = message;
  const { before, after } = track(`${guild.id}:${member.id}`, now);
  const boosted = after >= ACTIVITY_THRESHOLD;
  const gained = XP_PER_MESSAGE * (boosted ? MULTIPLIER : 1);
  const { xp } = levels.addXp(guild.id, member.id, gained, now);
  const level = levelFor(xp);
  const previousLevel = levelFor(xp - gained);

  const notified = before < ACTIVITY_THRESHOLD && boosted;
  if (notified) await member.user.send({ embeds: [messages.boostNotice(guild)] }).catch(() => {});
  const rewards = level > previousLevel ? await grantRewards(guild, member, level) : null;

  return { gained, xp, level, previousLevel, boosted, notified, rewards };
};

const profile = (guildId, userId, now = Date.now()) => {
  const xp = levels.get(guildId, userId)?.xp ?? 0;
  const level = levelFor(xp);
  const recent = recentMessages(`${guildId}:${userId}`, now).length;
  return {
    xp,
    level,
    current: xp - xpFor(level),
    perLevel: XP_PER_LEVEL,
    nextLevelXp: xpFor(level + 1),
    remaining: xpFor(level + 1) - xp,
    recent,
    threshold: ACTIVITY_THRESHOLD,
    boosted: recent >= ACTIVITY_THRESHOLD,
  };
};

const setLevel = async (guild, member, level, now = Date.now()) => {
  validateLevel(level);
  if (member.user.bot) throw new UserError('Bots cannot have levels.');
  const { previous, xp } = levels.setXp(guild.id, member.id, xpFor(level), now);
  const rewards = await grantRewards(guild, member, level);
  return { previous: { xp: previous, level: levelFor(previous) }, xp, level, rewards };
};

const setReward = (guild, role, level, createdBy) => {
  validateLevel(level);
  if (!role) throw new UserError('Role not found.');
  if (role.id === guild.id) throw new UserError('@everyone cannot be used as a level reward.');
  if (role.managed) throw new UserError('This role is managed by an integration and cannot be assigned.');
  if (!role.editable) throw new UserError('Roland cannot manage this role. Move the Roland role above it and make sure Roland has the Manage Roles permission.');

  const previous = levelRewards.set(guild.id, level, role.id, createdBy);
  return { previous: previous === role.id ? null : previous, otherLevels: levelRewards.levelsForRole(guild.id, role.id).filter((other) => other !== level) };
};

const leaderboard = (guild, limit = 10) =>
  levels
    .top(guild.id, limit + 15)
    .filter((row) => !(guild.client.users.cache.get(row.user_id)?.bot))
    .slice(0, limit);

const sweep = (now = Date.now()) => {
  for (const key of [...activity.keys()]) recentMessages(key, now);
  for (const [id, at] of processed) if (at <= now - ACTIVITY_WINDOW) processed.delete(id);
};

const start = () => setInterval(() => sweep(), SWEEP_INTERVAL);

module.exports = {
  XP_PER_LEVEL,
  XP_PER_MESSAGE,
  ACTIVITY_THRESHOLD,
  ACTIVITY_WINDOW,
  levelFor,
  xpFor,
  handleMessage,
  grantRewards,
  profile,
  setLevel,
  setReward,
  leaderboard,
  sweep,
  start,
};
