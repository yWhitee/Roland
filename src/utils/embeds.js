const { EmbedBuilder } = require('discord.js');
const automodFunctions = require('../services/automod/functions');
const { formatDuration } = require('./duration');

const Colors = { error: 0xed4245, success: 0x57f287, info: 0x5865f2, warning: 0xfee75c };

const ACTIONS = {
  ban: { label: 'Ban', color: 0xed4245 },
  kick: { label: 'Kick', color: 0xe67e22 },
  mute: { label: 'Mute', color: 0xfee75c },
  warn: { label: 'Warn', color: 0xf1c40f },
  unban: { label: 'Unban', color: 0x57f287 },
  unmute: { label: 'Unmute', color: 0x57f287 },
  clear: { label: 'Clear', color: 0x5865f2 },
};

const time = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;

const describe = (record, { user = true } = {}) => {
  const lines = [];
  if (user && record.user_id) lines.push(`**User:** <@${record.user_id}> (\`${record.user_id}\`)`);
  if (record.source === 'automod') {
    const name = automodFunctions.byId.get(record.automod_function)?.name ?? record.automod_function;
    lines.push('**Source:** AutoMod', `**Function:** ${name}`, '**Moderator:** Roland AutoMod');
  } else {
    lines.push(`**Moderator:** <@${record.moderator_id}>`);
  }
  lines.push(`**Date:** ${time(record.created_at)}`);
  if (record.duration) {
    lines.push(`**Duration:** ${formatDuration(record.duration)}`);
    lines.push(`**Expires:** ${record.expires_at ? time(record.expires_at) : 'Never'}`);
  }
  if (record.channel_id) lines.push(`**Channel:** <#${record.channel_id}>`);
  if (record.metadata?.requested) lines.push(`**Messages deleted:** ${record.metadata.deleted} of ${record.metadata.requested} requested`);
  if (record.reason) lines.push(`**Reason:** ${record.reason}`);
  return lines.join('\n');
};

const recordLabel = (record) => `${ACTIONS[record.type].label}${record.source === 'automod' ? ' (AutoMod)' : ''}`;

const recordEmbed = (record, title) =>
  new EmbedBuilder()
    .setColor(ACTIONS[record.type].color)
    .setTitle(title)
    .setDescription(describe(record))
    .setFooter({ text: `Record #${record.id}` })
    .setTimestamp(record.created_at);

const NOTICES = {
  warn: 'You have received a warning',
  mute: 'You have been muted',
  ban: 'You have been banned',
  kick: 'You have been kicked',
};

const noticeEmbed = (guild, moderator, { type, reason, duration, expiresAt, createdAt }) => {
  const lines = [`**Server:** ${guild.name}`, `**Date:** ${time(createdAt)}`];
  if (duration) lines.push(`**Duration:** ${formatDuration(duration)}`);
  if (expiresAt) lines.push(`**Expires:** ${time(expiresAt)}`);
  lines.push(`**Moderator:** ${moderator.user.tag}`, `**Reason:** ${reason}`);

  return new EmbedBuilder().setColor(ACTIONS[type].color).setTitle(NOTICES[type]).setDescription(lines.join('\n')).setTimestamp(createdAt);
};

const withDmStatus = (embed, dmSent) =>
  embed.addFields({ name: 'Direct message', value: dmSent ? 'Delivered to the user.' : 'Could not be delivered (DMs closed or blocked).' });

const errorEmbed = (message) => new EmbedBuilder().setColor(Colors.error).setDescription(`❌ ${message}`);

const successEmbed = (message) => new EmbedBuilder().setColor(Colors.success).setDescription(`✅ ${message}`);

module.exports = { ACTIONS, Colors, time, describe, recordLabel, recordEmbed, noticeEmbed, withDmStatus, errorEmbed, successEmbed };
