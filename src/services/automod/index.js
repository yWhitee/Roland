const { PermissionFlagsBits } = require('discord.js');
const automodFlags = require('../../database/automodFlags');
const automodRaids = require('../../database/automodRaids');
const automodSettings = require('../../database/automodSettings');
const automodWhitelist = require('../../database/automodWhitelist');
const permissions = require('../../permissions');
const logging = require('../logging');
const moderation = require('../moderation');
const { userMessage } = require('../../utils/errors');
const detectors = require('./detectors');
const { FLAG_DURATION, MAX_FLAGS, MESSAGE_FUNCTIONS, byId } = require('./functions');
const messages = require('./messages');
const raid = require('./raid');

const SWEEP_INTERVAL = 15_000;
const CAPABILITY_WARNINGS = {
  messageContent: 'The Message Content intent is disabled in the Discord Developer Portal, so this function cannot read message text until it is enabled.',
  members: 'The Server Members intent is disabled in the Discord Developer Portal, so member joins cannot be detected until it is enabled.',
};

let capabilities = { messageContent: true, members: true };
let sweeping = false;

const configure = (options = {}) => {
  capabilities = { messageContent: true, members: true, ...options };
};

const capabilityWarning = (functionId) => {
  const requirement = byId.get(functionId)?.requires;
  return requirement && !capabilities[requirement] ? CAPABILITY_WARNINGS[requirement] : null;
};

const deleteMessages = async (guild, entries, errors) => {
  const byChannel = new Map();
  for (const entry of entries) byChannel.set(entry.channelId, [...(byChannel.get(entry.channelId) ?? []), entry.id]);

  let deleted = 0;
  for (const [channelId, ids] of byChannel) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.bulkDelete || !channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) {
      errors.push(`Missing access or Manage Messages permission in <#${channelId}>.`);
      continue;
    }
    try {
      deleted += (await channel.bulkDelete(ids, true)).size;
    } catch (error) {
      errors.push(`Message deletion failed in <#${channelId}>: ${userMessage(error)}`);
    }
  }
  return deleted;
};

const enforce = async ({ fn, message, member, detection, now }) => {
  const { guild, channel } = message;
  const count = automodFlags.add({ guildId: guild.id, userId: member.id, functionId: fn.id, channelId: channel.id, createdAt: now, duration: FLAG_DURATION });
  const level = Math.min(count, MAX_FLAGS);
  const action = fn.actions[level - 1];
  const reason = `${fn.reason} detection`;
  const outcome = { fn, level, action, detail: detection.detail, deleted: 0, warning: null, mute: null, dmSent: false, errors: [] };

  if (action.delete) outcome.deleted = await deleteMessages(guild, detection.entries, outcome.errors);
  if (action.warn) outcome.warning = moderation.automodWarn({ guild, userId: member.id, functionId: fn.id, reason, channelId: channel.id });
  if (action.mute) {
    try {
      outcome.mute = await moderation.automodMute({ guild, member, duration: action.mute, functionId: fn.id, reason, channelId: channel.id });
    } catch (error) {
      outcome.errors.push(`Timeout failed: ${userMessage(error)}`);
    }
  }

  outcome.dmSent = await member.user.send({ embeds: [messages.notice(guild, channel, outcome)] }).then(() => true, () => false);
  await logging.sendEmbed(guild, messages.violationLog(member, channel, outcome));
  return outcome;
};

const handleMessage = async (message, now = message.createdTimestamp ?? Date.now()) => {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return null;
  const { guild, member } = message;
  if (!member || permissions.isAutomodImmune(member)) return null;

  const enabled = automodSettings.enabledFunctions(guild.id);
  const raidActive = Boolean(automodRaids.active(guild.id, now));
  if (!enabled.size && !raidActive) return null;

  const bypass = automodWhitelist.bypasses(guild.id, member.id, [...member.roles.cache.keys()]);
  const entries = detectors.record(message, now);

  for (const fn of MESSAGE_FUNCTIONS) {
    const enforced = enabled.has(fn.id) && !bypass.has(fn.id);
    const monitored = raidActive && fn.raidSignal && !bypass.has('antiraid');
    if (!enforced && !monitored) continue;

    const detection = await fn.detect({ message, entries, now });
    if (!detection) continue;
    detectors.consume(detection.entries, fn.id);

    if (monitored) await raid.reportOffender(guild, message.channel, member.id, now);
    if (enforced) return enforce({ fn, message, member, detection, now });
  }
  return null;
};

const handleJoin = (member, now = Date.now()) => raid.handleJoin(member, now);

const setEnabled = async (guild, functionId, enabled, updatedBy) => {
  automodSettings.set(guild.id, functionId, enabled, updatedBy);
  if (functionId === 'antiraid' && !enabled) await raid.endRaid(guild, 'Anti-Raid was disabled by staff.');
  return enabled ? capabilityWarning(functionId) : null;
};

const sweep = async (client, now = Date.now()) => {
  if (sweeping) return;
  sweeping = true;
  try {
    automodFlags.purgeExpired(now);
    detectors.sweepHistories(now);
    await raid.sweep(client, now);
  } finally {
    sweeping = false;
  }
};

const start = (client) => {
  const run = () => sweep(client).catch((error) => console.error(`AutoMod maintenance failed: ${error.message}`));
  run();
  setInterval(run, SWEEP_INTERVAL);
};

module.exports = { configure, capabilityWarning, handleMessage, handleJoin, setEnabled, sweep, start };
