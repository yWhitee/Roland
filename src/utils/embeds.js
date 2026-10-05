const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const automodFunctions = require('../services/automod/functions');
const { formatDuration } = require('./duration');

const DEFAULT_EMBED_COLOR = 0xff7b00;

const Colors = { error: 0xed4245, success: 0x57f287, info: DEFAULT_EMBED_COLOR, warning: 0xfee75c };

const ACTIONS = {
  ban: { label: 'Ban', color: 0xed4245, emoji: '🔨' },
  kick: { label: 'Kick', color: 0xe67e22, emoji: '👢' },
  mute: { label: 'Mute', color: 0xfee75c, emoji: '🔇' },
  warn: { label: 'Warn', color: 0xf1c40f, emoji: '⚠️' },
  unban: { label: 'Unban', color: 0x57f287, emoji: '♻️' },
  unmute: { label: 'Unmute', color: 0x57f287, emoji: '🔊' },
  clear: { label: 'Clear', color: 0x5865f2, emoji: '🧹' },
};

const time = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;

const describe = (record, { user = true } = {}) => {
  const lines = [];
  const named = (name) => (name ? ` • ${escapeMarkdown(name)}` : '');
  if (user && record.user_id) lines.push(`**User:** <@${record.user_id}>${named(record.user_name)} (\`${record.user_id}\`)`);
  if (record.source === 'automod') {
    const name = automodFunctions.byId.get(record.automod_function)?.name ?? record.automod_function;
    lines.push('**Source:** AutoMod', `**Function:** ${name}`, '**Moderator:** Roland AutoMod');
  } else {
    lines.push(`**Moderator:** <@${record.moderator_id}>${named(record.moderator_name)}`);
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

const recordName = (record) => (record.case_number ? `Case #${record.case_number}` : `Record #${record.id}`);

const recordEmbed = (record, title) =>
  new EmbedBuilder()
    .setColor(ACTIONS[record.type].color)
    .setTitle(title)
    .setDescription(`${record.case_number ? `**Case:** #${record.case_number}\n` : ''}${describe(record)}`)
    .setFooter({ text: recordName(record) })
    .setTimestamp(record.created_at);

const removal = (record) => [
  '**Status:** Removed from Modlog',
  `**Removed by:** <@${record.removed_by}>${record.removed_by_name ? ` • ${escapeMarkdown(record.removed_by_name)}` : ''}`,
  `**Removed at:** ${time(record.removed_at)}`,
];

const caseRemovedEmbed = (record) =>
  new EmbedBuilder()
    .setColor(Colors.warning)
    .setTitle('Moderation • Case Removed')
    .setDescription(
      [
        `**Case:** #${record.case_number}`,
        `**User:** <@${record.user_id}> (\`${record.user_id}\`)`,
        `**Action:** ${ACTIONS[record.type].emoji} ${recordLabel(record)}`,
        `**Removed by:** <@${record.removed_by}>`,
        `**Date:** ${time(record.removed_at)}`,
      ].join('\n'),
    )
    .setTimestamp(record.removed_at);

const casesRemovedEmbed = ({ userId, caseNumbers, removedBy, removedAt }) => {
  const list = caseNumbers.map((number) => `#${number}`).join(', ');
  return new EmbedBuilder()
    .setColor(Colors.warning)
    .setTitle('Moderation • Cases Removed')
    .setDescription(
      [
        `**User:** <@${userId}> (\`${userId}\`)`,
        `**Cases removed from Modlog:** ${caseNumbers.length}`,
        `**Cases:** ${list.length > 1000 ? `${list.slice(0, list.lastIndexOf(',', 1000))}, …` : list}`,
        `**Removed by:** <@${removedBy}>`,
        `**Date:** ${time(removedAt)}`,
      ].join('\n'),
    )
    .setTimestamp(removedAt);
};

const caseEmbed = (record) => {
  const lines = [`**Action:** ${ACTIONS[record.type].emoji} ${recordLabel(record)}`, describe(record)];
  if (record.type === 'ban') lines.push(`**Ban status:** ${record.active ? 'Active' : 'Lifted'}`);
  if (record.user_display_name && record.user_display_name !== record.user_name) lines.push(`**Display name at the time:** ${escapeMarkdown(record.user_display_name)}`);
  if (record.removed_at) lines.push('', ...removal(record));
  return new EmbedBuilder()
    .setColor(ACTIONS[record.type].color)
    .setTitle(`Case #${record.case_number}`)
    .setDescription(lines.join('\n'))
    .setTimestamp(record.created_at);
};

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

module.exports = { DEFAULT_EMBED_COLOR, ACTIONS, Colors, time, describe, recordLabel, recordName, recordEmbed, caseEmbed, caseRemovedEmbed, casesRemovedEmbed, noticeEmbed, withDmStatus, errorEmbed, successEmbed };
