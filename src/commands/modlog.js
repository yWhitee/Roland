const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder, SnowflakeUtil, escapeMarkdown } = require('discord.js');
const punishments = require('../database/punishments');
const verifications = require('../database/verifications');
const { Level } = require('../permissions');
const moderation = require('../services/moderation');
const { ACTIONS, Colors, describe, recordLabel, recordName } = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const options = require('../utils/options');
const { parseUserId } = require('../utils/users');

const PAGE_SIZE = 5;
const ROLES_LIMIT = 900;

const render = (guildId, userId, requestedPage) => {
  const { total, pages, page, records } = moderation.history(guildId, userId, requestedPage, PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Moderation history')
    .setDescription(`**User:** <@${userId}> (\`${userId}\`)\n**Total records:** ${total}${total ? '' : '\n\nNo punishments recorded.'}`)
    .addFields(records.map((record) => ({ name: `${ACTIONS[record.type].emoji} ${recordName(record)} • ${recordLabel(record)}`, value: describe(record, { user: false }) })))
    .setFooter({ text: `Page ${page + 1} of ${pages}` });

  const navigation = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modlog:${userId}:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`modlog:${userId}:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  );

  return { embeds: [embed], components: pages > 1 ? [navigation] : [] };
};

const date = (ms) => `<t:${Math.floor(ms / 1000)}:D>`;

const roleList = (roles) => {
  const shown = [];
  for (const role of roles) {
    if ([...shown, `<@&${role.id}>`].join(' ').length > ROLES_LIMIT) return `${shown.join(' ')} and ${roles.length - shown.length} more`;
    shown.push(`<@&${role.id}>`);
  }
  return shown.join(' ') || 'None';
};

const profile = (guild, userId, user, member) => {
  const roles = member
    ? [...member.roles.cache.keys()].map((id) => guild.roles.cache.get(id)).filter((role) => role && role.id !== guild.id).sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    : [];
  const recorded = punishments.latestNames(guild.id, userId);
  const verification = verifications.findByDiscord(userId);
  const text = (value) => (value ? escapeMarkdown(value) : 'Not available');

  const lines = [
    `**Username:** ${text(user?.username)}`,
    `**Display Name:** ${text(member?.displayName ?? user?.globalName ?? user?.username)}`,
    `**User ID:** \`${userId}\``,
    `**Account Created:** ${date(SnowflakeUtil.timestampFrom(userId))}`,
    `**Joined:** ${member ? (member.joinedTimestamp ? date(member.joinedTimestamp) : 'Not available') : 'Not currently in this server'}`,
  ];
  if (member) {
    lines.push(`**Highest Role:** ${roles[0] ? `<@&${roles[0].id}> (position ${roles[0].position ?? 'unknown'})` : 'None'}`, `**Roles:** ${roleList(roles)}`);
  }
  lines.push(`**RoVer Verification:** ${verification ? `✓ Verified\n**Roblox:** ${escapeMarkdown(verification.roblox_username)}` : '✗ Not verified'}`);
  if (recorded && (!member || !user)) {
    lines.push(`**Name recorded in cases:** ${escapeMarkdown(recorded.user_name)}${recorded.user_display_name ? ` (${escapeMarkdown(recorded.user_display_name)})` : ''}`);
  }
  return new EmbedBuilder().setColor(Colors.info).setTitle('User Information').setDescription(lines.join('\n'));
};

module.exports = {
  level: Level.MODERATOR,
  render,
  profile,
  data: new SlashCommandBuilder()
    .setName('modlog')
    .setDescription("Show a user's punishment history")
    .addStringOption(options.user()),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = parseUserId(interaction.options.getString('user', true));
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    if (!user && !punishments.countByUser(interaction.guildId, userId)) throw new UserError('User not found.');
    const member = await interaction.guild.members.fetch({ user: userId, force: true }).catch(() => null);

    const history = render(interaction.guildId, userId, 0);
    await interaction.editReply({ ...history, embeds: [profile(interaction.guild, userId, user, member), ...history.embeds] });
  },
  async handleComponent(interaction) {
    const [, userId, page] = interaction.customId.split(':');
    const history = render(interaction.guildId, userId, Number(page));
    const kept = interaction.message?.embeds?.length > 1 ? [interaction.message.embeds[0]] : [];
    await interaction.update({ ...history, embeds: [...kept, ...history.embeds] });
  },
};
