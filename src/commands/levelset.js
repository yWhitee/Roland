const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Leveling } = require('../permissions');
const logging = require('../services/logging');
const levels = require('../services/levels');
const { levelSetEmbed, number } = require('../services/levels/messages');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  level: Leveling.SET,
  data: new SlashCommandBuilder()
    .setName('levelset')
    .setDescription("Set a member's level")
    .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
    .addIntegerOption((option) => option.setName('level').setDescription('New level (1 or more)').setRequired(true).setMinValue(1)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = interaction.options.getMember('user');
    if (!member) throw new UserError('This user is not a member of this server.');

    const result = await levels.setLevel(interaction.guild, member, interaction.options.getInteger('level', true));
    await logging.sendEmbed(interaction.guild, levelSetEmbed(interaction.user, member, result.previous, result));

    const lines = [`<@${member.id}> is now **level ${number(result.level)}** with **${number(result.xp)} XP**.`];
    if (result.rewards.granted.length) lines.push(`Role rewards granted: ${result.rewards.granted.map((reward) => `<@&${reward.role_id}>`).join(', ')}`);
    if (result.rewards.failed.length) lines.push(`⚠️ Could not grant: ${result.rewards.failed.map(({ reward, reason }) => `<@&${reward.role_id}> (${reason})`).join(', ')}`);
    await interaction.editReply({ embeds: [successEmbed(lines.join('\n'))] });
  },
};
