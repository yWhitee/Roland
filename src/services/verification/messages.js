const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { Colors } = require('../../utils/embeds');

const PANEL = {
  title: 'Roblox Verification',
  description: 'Verify your Roblox account to gain access to the server.\n\nClick the button below to connect your Roblox account with your Discord account.',
  color: '#335FFF',
};

const ROVER_VERIFY_URL = 'https://rover.link/verify/';

const fullTime = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;

const profileUrl = (robloxId) => `https://www.roblox.com/users/${robloxId}/profile`;

const panelEmbed = () => new EmbedBuilder().setColor(PANEL.color).setTitle(PANEL.title).setDescription(PANEL.description);

const panelComponents = () => [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify:start').setLabel('Verify with Roblox').setEmoji('🔗').setStyle(ButtonStyle.Success),
  ),
];

const checkButton = (relink) =>
  new ButtonBuilder().setCustomId(relink ? 'verify:check:relink' : 'verify:check').setLabel('Check again').setEmoji('🔄').setStyle(ButtonStyle.Primary);

const consentMessage = (lines, relink = false) => ({
  embeds: [new EmbedBuilder().setColor(Colors.info).setTitle('Verify with Roblox').setDescription(lines.join('\n'))],
  components: [new ActionRowBuilder().addComponents(checkButton(relink))],
});

const linkMessage = (lines, relink = false) => ({
  embeds: [new EmbedBuilder().setColor(Colors.info).setTitle(PANEL.title).setDescription(lines.join('\n'))],
  components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Verify with Roblox').setEmoji('🔗').setStyle(ButtonStyle.Link).setURL(ROVER_VERIFY_URL),
      checkButton(relink),
    ),
  ],
});

const alreadyVerifiedEmbed = (verification, lines = []) =>
  new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('You are already verified')
    .setDescription([`Roblox username: **${verification.roblox_username}**`, ...(lines.length ? ['', ...lines] : [])].join('\n'));

const resultEmbed = ({ title, lines, success }) =>
  new EmbedBuilder()
    .setColor(success ? Colors.success : Colors.error)
    .setTitle(title)
    .setDescription(lines.join('\n'));

const logEmbed = (verification, updates, changed = false) =>
  new EmbedBuilder()
    .setColor(Colors.success)
    .setTitle(changed ? 'Verification • Roblox account changed' : 'Verification • Roblox account linked')
    .addFields(
      { name: 'Discord user', value: `<@${verification.discord_id}> (\`${verification.discord_id}\`)` },
      { name: 'Member role', value: updates.role?.ok ? 'Assigned' : `Not assigned${updates.role?.reason ? `: ${updates.role.reason}` : ''}`.slice(0, 1024), inline: true },
      {
        name: 'Nickname',
        value: updates.nickname?.ok ? 'Updated' : `Not updated${updates.nickname?.reason ? `: ${updates.nickname.reason}` : ''}`.slice(0, 1024),
        inline: true,
      },
      { name: 'Timestamp', value: fullTime(verification.verified_at) },
    )
    .setTimestamp(verification.verified_at);

const infoEmbed = (user, verification) => {
  const embed = new EmbedBuilder().setColor(Colors.info).setTitle('Verification info');
  if (!verification) return embed.setDescription(`<@${user.id}> (\`${user.id}\`) is not verified.`);
  return embed.addFields(
    { name: 'Discord user', value: `<@${user.id}> (\`${user.id}\`)` },
    { name: 'Roblox username', value: `[${verification.roblox_username}](${profileUrl(verification.roblox_id)})`, inline: true },
    { name: 'Roblox ID', value: `\`${verification.roblox_id}\``, inline: true },
    { name: 'Verification date', value: fullTime(verification.verified_at) },
  );
};

module.exports = { PANEL, ROVER_VERIFY_URL, panelEmbed, panelComponents, consentMessage, linkMessage, alreadyVerifiedEmbed, resultEmbed, logEmbed, infoEmbed };
