const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { formatDuration } = require('../../utils/duration');
const { Colors } = require('../../utils/embeds');
const { FLAG_DURATION, MAX_FLAGS, FUNCTIONS } = require('./functions');

const fullTime = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;

const describeAction = (action, plural) =>
  [action.delete && (plural ? 'Delete offending messages' : 'Delete message'), action.warn && 'Warn', action.mute && `Mute ${formatDuration(action.mute)}`]
    .filter(Boolean)
    .join(' + ');

const noticeTitle = ({ mute, warning, deleted }) => {
  if (mute) return 'You have been muted by AutoMod';
  if (warning) return 'You have received an AutoMod warning';
  if (deleted) return 'Your message was removed by AutoMod';
  return 'You have been flagged by AutoMod';
};

const notice = (guild, channel, outcome) => {
  const { fn, level, deleted, warning, mute } = outcome;
  const lines = [];
  if (deleted) lines.push(`Your ${deleted > 1 ? 'messages' : 'message'} in #${channel.name} ${deleted > 1 ? 'were' : 'was'} removed by AutoMod.`, '');
  lines.push(`**Server:** ${guild.name}`, `**Reason:** ${fn.reason}`);
  if (mute) lines.push(`**Duration:** ${formatDuration(mute.duration)}`);
  lines.push(`**AutoMod status:** ${level}/${MAX_FLAGS}`);
  if (warning) lines.push('', 'Your warning has been recorded in the server moderation log.');
  return new EmbedBuilder().setColor(mute ? Colors.error : Colors.warning).setTitle(noticeTitle(outcome)).setDescription(lines.join('\n')).setTimestamp();
};

const violationLog = (member, channel, outcome) => {
  const { fn, level, action, deleted, warning, mute, dmSent, errors, detail } = outcome;
  const actions = [];
  if (action.delete) actions.push(`DELETE (${deleted} ${deleted === 1 ? 'message' : 'messages'})`);
  if (warning) actions.push(`WARN (record #${warning.id}) • Case #${warning.case_number}`);
  if (mute) actions.push(`TIMEOUT ${formatDuration(mute.duration)} (record #${mute.id}) • Case #${mute.case_number}`);

  const embed = new EmbedBuilder()
    .setColor(mute ? Colors.error : Colors.warning)
    .setTitle(`AutoMod • ${fn.name}`)
    .addFields(
      { name: 'User', value: `<@${member.id}> (\`${member.id}\`)`, inline: true },
      { name: 'Function', value: `${fn.name} (\`${fn.id}\`)`, inline: true },
      { name: 'Flag', value: `${level}/${MAX_FLAGS}`, inline: true },
      { name: 'Action', value: actions.join('\n') || 'None' },
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Reason', value: fn.reason, inline: true },
      { name: 'DM', value: dmSent ? 'Delivered' : 'Not delivered', inline: true },
      { name: 'Detection', value: detail },
    )
    .setTimestamp();
  if (errors.length) embed.addFields({ name: 'Errors', value: errors.join('\n').slice(0, 1024) });
  return embed;
};

const raidActivated = (state, joins) =>
  new EmbedBuilder()
    .setColor(Colors.error)
    .setTitle('AutoMod • Anti-Raid activated')
    .setDescription('The server is on **RAID ALERT**. Channels flooded by multiple users will be locked automatically.')
    .addFields(
      { name: 'Function', value: 'Anti-Raid (`antiraid`)', inline: true },
      { name: 'Status', value: 'ACTIVATED', inline: true },
      { name: 'Duration', value: formatDuration(`${Math.round((state.expires_at - state.started_at) / 60_000)}m`), inline: true },
      { name: 'Trigger', value: `${joins} joins detected`, inline: true },
      { name: 'Ends', value: fullTime(state.expires_at), inline: true },
    )
    .setTimestamp(state.started_at);

const raidAlert = (roleIds, index, total, state) => ({
  content: `${roleIds.map((id) => `<@&${id}>`).join(' ')} 🚨 **Anti-Raid alert ${index}/${total}**: mass joins detected. Raid alert active until ${fullTime(state.expires_at)}.`,
  allowedMentions: { parse: [], roles: roleIds },
});

const lockdownActivated = (channel, reason, at) =>
  new EmbedBuilder()
    .setColor(Colors.error)
    .setTitle('AutoMod • Anti-Raid Lockdown Activated')
    .addFields(
      { name: 'Action', value: 'LOCKDOWN', inline: true },
      { name: 'Channel(s)', value: `<#${channel.id}>`, inline: true },
      { name: 'Reason', value: reason },
      { name: 'Timestamp', value: fullTime(at) },
    )
    .setTimestamp(at);

const raidEnded = (reason, results, at) => {
  const embed = new EmbedBuilder()
    .setColor(Colors.success)
    .setTitle('AutoMod • Anti-Raid alert ended')
    .addFields({ name: 'Function', value: 'Anti-Raid (`antiraid`)', inline: true }, { name: 'Reason', value: reason, inline: true })
    .setTimestamp(at);
  if (results.length) {
    embed.addFields({
      name: 'Lockdown ended',
      value: results
        .map(({ channelId, restored, skipped, missing }) =>
          missing ? `<#${channelId}>: channel no longer exists` : `<#${channelId}>: ${restored} permission(s) restored${skipped ? `, ${skipped} left unchanged (modified manually)` : ''}`,
        )
        .join('\n')
        .slice(0, 1024),
    });
  }
  return embed;
};

const errorLog = (title, message) => new EmbedBuilder().setColor(Colors.error).setTitle(`AutoMod • ${title}`).setDescription(message).setTimestamp();

const listItems = (items, format) => {
  if (!items.length) return 'None';
  const lines = items.map(format);
  let text = '';
  for (const [index, line] of lines.entries()) {
    const next = text ? `${text}, ${line}` : line;
    if (next.length > 980) return `${text} and ${lines.length - index} more`;
    text = next;
  }
  return text;
};

const status = (enabled) => (enabled ? '🟢 **ENABLED**' : '🔴 **DISABLED**');

const overviewPage = (enabled) =>
  new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('AutoMod functions')
    .setDescription(
      [
        'Use the **Function ID** with `/automod function:<functionId> state:<on|off>`.',
        `Every flag lasts ${formatDuration(`${FLAG_DURATION / 3_600_000}h`)}; flags are counted separately for each function.`,
        '',
        ...FUNCTIONS.map((fn) => `${status(enabled.has(fn.id))} — **${fn.name}** — Function ID: \`${fn.id}\``),
      ].join('\n'),
    );

const functionPage = (fn, enabled, whitelist) => {
  const embed = new EmbedBuilder()
    .setColor(enabled ? Colors.success : Colors.error)
    .setTitle(fn.name)
    .setDescription(`Function ID: \`${fn.id}\`\n\n${status(enabled)}`)
    .addFields({ name: 'Detects', value: fn.description }, { name: 'Detection', value: fn.detection });

  if (fn.serverWide) {
    embed.addFields(
      { name: 'Flags', value: 'Not applicable. Anti-Raid acts on the whole server instead of flagging individual users.' },
      { name: '1/3', value: 'Not applicable', inline: true },
      { name: '2/3', value: 'Not applicable', inline: true },
      { name: '3/3', value: 'Not applicable', inline: true },
      { name: 'Response', value: fn.response.map((line, index) => `${index + 1}. ${line}`).join('\n') },
    );
  } else {
    const plural = ['antispam', 'antiflood', 'antiduplicate'].includes(fn.id);
    embed.addFields(
      { name: 'Flags', value: `${MAX_FLAGS} flags maximum. Each flag lasts ${formatDuration(`${FLAG_DURATION / 3_600_000}h`)}.` },
      ...fn.actions.map((action, index) => ({ name: `${index + 1}/${MAX_FLAGS}`, value: describeAction(action, plural), inline: true })),
    );
    if (fn.note) embed.addFields({ name: 'Note', value: fn.note });
  }

  const users = whitelist.filter((entry) => entry.function_id === fn.id && entry.target_type === 'user');
  const roles = whitelist.filter((entry) => entry.function_id === fn.id && entry.target_type === 'role');
  return embed.addFields(
    { name: 'Whitelisted users', value: listItems(users, (entry) => `<@${entry.target_id}>`) },
    { name: 'Whitelisted roles', value: listItems(roles, (entry) => `<@&${entry.target_id}>`) },
  );
};

const listPage = (page, enabled, whitelist) => {
  const pages = FUNCTIONS.length + 1;
  const current = Math.min(Math.max(page, 0), pages - 1);
  const embed = current === 0 ? overviewPage(enabled) : functionPage(FUNCTIONS[current - 1], enabled.has(FUNCTIONS[current - 1].id), whitelist);
  embed.setFooter({ text: `Page ${current + 1} of ${pages}` });

  const navigation = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`automodlist:${current - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId(`automodlist:${current + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(current === pages - 1),
  );
  return { embeds: [embed], components: [navigation] };
};

module.exports = { describeAction, notice, violationLog, raidActivated, raidAlert, lockdownActivated, raidEnded, errorLog, listPage };
