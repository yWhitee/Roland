const { EmbedBuilder } = require('discord.js');
const { Colors } = require('../../utils/embeds');

const BAR_SIZE = 10;

const number = (value) => value.toLocaleString('en-US');

const bar = (current, total) => {
  const filled = Math.min(BAR_SIZE, Math.floor((current / total) * BAR_SIZE));
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_SIZE - filled)} ${Math.floor((current / total) * 100)}%`;
};

const profileEmbed = (user, profile) =>
  new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Level')
    .setThumbnail(user.displayAvatarURL?.() ?? null)
    .addFields(
      { name: 'User', value: `<@${user.id}>`, inline: true },
      { name: 'Level', value: number(profile.level), inline: true },
      { name: 'XP', value: number(profile.xp), inline: true },
      { name: 'Next level', value: `Level ${number(profile.level + 1)} at ${number(profile.nextLevelXp)} XP (${number(profile.remaining)} XP to go)` },
      { name: 'Progress', value: `${bar(profile.current, profile.perLevel)}\n${number(profile.current)} / ${number(profile.perLevel)} XP` },
      {
        name: 'Activity',
        value: profile.boosted
          ? `🔥 2x XP active: ${profile.recent} messages in the last 60 minutes (4 XP per message)`
          : `${profile.recent} / ${profile.threshold} messages in the last 60 minutes (2x XP at ${profile.threshold})`,
      },
    );

const leaderboardEmbed = (rows, levelFor) =>
  new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Leaderboard')
    .setDescription(
      rows.length
        ? rows.map((row, index) => `**${index + 1}.** <@${row.user_id}> — Level ${number(levelFor(row.xp))} • ${number(row.xp)} XP`).join('\n')
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
      { name: 'Failed rewards', value: failures.map(({ reward, reason }) => `Level ${reward.level} → <@&${reward.role_id}>: ${reason}`).join('\n').slice(0, 1024) },
    )
    .setTimestamp();

const levelSetEmbed = (actor, member, previous, result) =>
  new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Levels • Level set')
    .addFields(
      { name: 'User', value: `<@${member.id}> (\`${member.id}\`)` },
      { name: 'Staff', value: `<@${actor.id}>`, inline: true },
      { name: 'Level', value: `${number(previous.level)} → ${number(result.level)}`, inline: true },
      { name: 'XP', value: `${number(previous.xp)} → ${number(result.xp)}`, inline: true },
    )
    .setTimestamp();

module.exports = { number, bar, profileEmbed, leaderboardEmbed, boostNotice, rewardFailureEmbed, levelSetEmbed };
