const { OverwriteType, PermissionFlagsBits } = require('discord.js');
const automodRaids = require('../../database/automodRaids');
const automodSettings = require('../../database/automodSettings');
const automodWhitelist = require('../../database/automodWhitelist');
const permissions = require('../../permissions');
const logging = require('../logging');
const { RAID } = require('./functions');
const messages = require('./messages');

const LOCKED = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];
const STAFF_ALLOWED = ['SendMessages', 'SendMessagesInThreads'];
const RESTORE_RETRY = 5 * 60_000;

const joins = new Map();
const offenders = new Map();
const retryAfter = new Map();

const staffRoles = (guild) => permissions.rolesAtLeast(permissions.Automod.ALERTED).filter((id) => guild.roles.cache.has(id));

const stateOf = (overwrite, permission) => {
  if (overwrite?.allow.has(PermissionFlagsBits[permission])) return 'allow';
  if (overwrite?.deny.has(PermissionFlagsBits[permission])) return 'deny';
  return 'inherit';
};

const valueOf = (state) => (state === 'inherit' ? null : state === 'allow');

const handleJoin = async (member, now = Date.now()) => {
  if (member.user.bot) return null;
  const { guild } = member;
  if (!automodSettings.enabledFunctions(guild.id).has('antiraid')) return null;
  if (automodWhitelist.bypasses(guild.id, member.id, [...member.roles.cache.keys()]).has('antiraid')) return null;

  const recent = (joins.get(guild.id) ?? []).filter((at) => at > now - RAID.window);
  recent.push(now);
  joins.set(guild.id, recent);
  if (recent.length < RAID.joins) return null;

  const state = automodRaids.activate(guild.id, now, RAID.duration);
  if (!state) return null;
  joins.delete(guild.id);

  await logging.sendEmbed(guild, messages.raidActivated(state, recent.length));
  if (logging.isEnabled(guild)) {
    const roles = staffRoles(guild);
    for (let index = 1; index <= RAID.alerts; index++) await logging.post(guild, messages.raidAlert(roles, index, RAID.alerts, state));
  }
  return state;
};

const plan = (guild, channel) => {
  const staff = new Set(staffRoles(guild));
  const exempt = new Set([guild.id, ...staff, ...(guild.members.me?.roles.cache.keys() ?? [])]);
  const changes = [];
  const add = (targetId, targetType, list, applied) => {
    const overwrite = channel.permissionOverwrites.cache.get(targetId);
    for (const permission of list) {
      const previous = stateOf(overwrite, permission);
      if (previous !== applied) changes.push({ targetId, targetType, permission, previous, applied });
    }
  };

  add(guild.id, OverwriteType.Role, LOCKED, 'deny');
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.type !== OverwriteType.Role || exempt.has(overwrite.id)) continue;
    add(overwrite.id, OverwriteType.Role, LOCKED.filter((permission) => stateOf(overwrite, permission) === 'allow'), 'deny');
  }
  for (const roleId of staff) add(roleId, OverwriteType.Role, STAFF_ALLOWED, 'allow');
  return changes;
};

const apply = async (channel, changes, state, reason) => {
  const targets = new Map();
  for (const change of changes) {
    const target = targets.get(change.targetId) ?? { type: change.targetType, options: {} };
    target.options[change.permission] = valueOf(state(change));
    targets.set(change.targetId, target);
  }
  for (const [targetId, { type, options }] of targets) await channel.permissionOverwrites.edit(targetId, options, { type, reason });
};

const lockdown = async (guild, channel, reason, now = Date.now()) => {
  const lockdownId = automodRaids.createLockdown({ guildId: guild.id, channelId: channel.id, reason, createdAt: now });
  if (!lockdownId) return null;

  const changes = plan(guild, channel);
  changes.forEach((change) => automodRaids.addOverwrite(lockdownId, change));
  try {
    await apply(channel, changes, (change) => change.applied, 'Anti-Raid lockdown');
  } catch (error) {
    console.error(`Failed to lock channel ${channel.id}: ${error.message}`);
    await logging.sendEmbed(guild, messages.errorLog('Anti-Raid lockdown failed', `Could not fully lock <#${channel.id}>: ${error.message}`));
    return { lockdownId, changes, failed: true };
  }

  await logging.sendEmbed(guild, messages.lockdownActivated(channel, reason, now));
  return { lockdownId, changes, failed: false };
};

const reportOffender = async (guild, source, userId, now = Date.now()) => {
  if (!automodRaids.active(guild.id, now)) return null;
  const channel = source.permissionOverwrites ? source : source.parent;
  if (!channel?.permissionOverwrites) return null;
  const key = `${guild.id}:${channel.id}`;
  const recent = new Map([...(offenders.get(key) ?? [])].filter(([, at]) => at > now - RAID.lockdownWindow));
  recent.set(userId, now);
  offenders.set(key, recent);
  if (recent.size < RAID.lockdownUsers) return null;

  offenders.delete(key);
  return lockdown(guild, channel, `${recent.size} users triggered Anti-Spam/Anti-Flood within ${RAID.lockdownWindow / 1000} seconds during a raid alert.`, now);
};

const restore = async (guild, lockdown) => {
  const channel = guild.channels.cache.get(lockdown.channel_id);
  if (!channel) {
    automodRaids.removeLockdown(lockdown.id);
    return { channelId: lockdown.channel_id, missing: true };
  }

  const reverts = lockdown.overwrites.filter((change) => stateOf(channel.permissionOverwrites.cache.get(change.target_id), change.permission) === change.applied);
  await apply(
    channel,
    reverts.map((change) => ({ targetId: change.target_id, targetType: change.target_type, permission: change.permission, previous: change.previous })),
    (change) => change.previous,
    'Anti-Raid lockdown ended',
  );
  automodRaids.removeLockdown(lockdown.id);
  return { channelId: channel.id, restored: reverts.length, skipped: lockdown.overwrites.length - reverts.length };
};

const endRaid = async (guild, reason, now = Date.now()) => {
  const results = [];
  let failed = false;
  for (const entry of automodRaids.lockdowns(guild.id)) {
    try {
      results.push(await restore(guild, entry));
    } catch (error) {
      failed = true;
      console.error(`Failed to restore channel ${entry.channel_id}: ${error.message}`);
      await logging.sendEmbed(guild, messages.errorLog('Lockdown restore failed', `Could not restore <#${entry.channel_id}>: ${error.message}. Retrying in 5 minutes.`));
    }
  }
  if (failed) retryAfter.set(guild.id, now + RESTORE_RETRY);
  else retryAfter.delete(guild.id);

  joins.delete(guild.id);
  for (const key of offenders.keys()) if (key.startsWith(`${guild.id}:`)) offenders.delete(key);

  const ended = automodRaids.deactivate(guild.id) > 0;
  if (ended || results.length) await logging.sendEmbed(guild, messages.raidEnded(reason, results, now));
  return { ended, results, failed };
};

const sweep = async (client, now = Date.now()) => {
  for (const state of automodRaids.expired(now)) {
    const guild = client.guilds.cache.get(state.guild_id);
    if (guild) await endRaid(guild, 'The 30-minute raid alert expired.', now);
  }
  for (const guildId of automodRaids.lockedGuilds()) {
    if (automodRaids.active(guildId, now) || (retryAfter.get(guildId) ?? 0) > now) continue;
    const guild = client.guilds.cache.get(guildId);
    if (guild) await endRaid(guild, 'Restoring channels that were still locked after the raid alert.', now);
  }
};

module.exports = { LOCKED, STAFF_ALLOWED, staffRoles, handleJoin, reportOffender, lockdown, endRaid, sweep };
