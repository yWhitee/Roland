const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Leveling } = require('../permissions');
const logging = require('../services/logging');
const levels = require('../services/levels');
const { levelSetEmbed } = require('../services/levels/messages');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  level: Leveling.SET,
  data: new SlashCommandBuilder()
    .setName('levelset')
    .setDescription("Set a member's level")
    .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
    .addIntegerOption((option) => option.setName('level').setDescription('New level (1-200)').setRequired(true).setMinValue(1).setMaxValue(levels.MAX_LEVEL)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = interaction.options.getMember('user');
    if (!member) throw new UserError('This user is not a member of this server.');

    const result = await levels.setLevel(interaction.guild, member, interaction.options.getInteger('level', true));
    await logging.sendEmbed(interaction.guild, levelSetEmbed(interaction.user, member, result.previous, result));

    const { added, removed, failed } = result.rewards;
    const lines = [`<@${member.id}> is now **level ${result.level}** with **${result.xp} XP**.`];
    if (added) lines.push(`Level reward added: <@&${added}>`);
    if (removed.length) lines.push(`Previous level reward removed: ${removed.map((roleId) => `<@&${roleId}>`).join(', ')}`);
    if (failed.length) lines.push(`⚠️ Could not update: ${failed.map(({ roleId, reason }) => `<@&${roleId}> (${reason})`).join(', ')}`);
    await interaction.editReply({ embeds: [successEmbed(lines.join('\n'))] });
  },
};
