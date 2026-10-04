const { EmbedBuilder } = require('discord.js');
const { Colors } = require('../../utils/embeds');

const profileEmbed = (user, profile) =>
  new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Level')
    .addFields(
      { name: 'User', value: `<@${user.id}>`, inline: true },
      { name: 'Level', value: String(profile.level), inline: true },
      { name: 'XP', value: String(profile.xp), inline: true },
    );

const leaderboardEmbed = (entries) =>
  new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Leaderboard')
    .setDescription(
      entries.length
        ? entries.map((entry, index) => `#${index + 1} <@${entry.user_id}> — Level ${entry.level} — ${entry.xp} XP`).join('\n')
        : 'Nobody has earned XP yet.',
    );

const boostNotice = (guild) =>
  new EmbedBuilder()
    .setColor(Colors.success)
    .setTitle('🔥 2x XP activated')
    .setDescription(
      [
        `You sent **100 messages in the last 60 minutes** in **${guild.name}**.`,
        'Your XP is now doubled: you earn **4 XP per message** instead of 2.',
        'Keep up the pace to keep the bonus!',
      ].join('\n'),
    );

const rewardFailureEmbed = (member, failures) =>
  new EmbedBuilder()
    .setColor(Colors.error)
    .setTitle('Levels • Role reward failed')
    .addFields(
      { name: 'User', value: `<@${member.id}> (\`${member.id}\`)` },
      {
        name: 'Failed changes',
        value: failures.map(({ roleId, action, reason }) => `${action === 'add' ? 'Add' : 'Remove'} <@&${roleId}>: ${reason}`).join('\n').slice(0, 1024),
      },
    )
    .setTimestamp();

const levelSetEmbed = (actor, member, previous, result) =>
  new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Levels • Level set')
    .addFields(
      { name: 'User', value: `<@${member.id}> (\`${member.id}\`)` },
      { name: 'Staff', value: `<@${actor.id}>`, inline: true },
      { name: 'Level', value: `${previous.level} → ${result.level}`, inline: true },
      { name: 'XP', value: `${previous.xp} → ${result.xp}`, inline: true },
    )
    .setTimestamp();

module.exports = { profileEmbed, leaderboardEmbed, boostNotice, rewardFailureEmbed, levelSetEmbed };
