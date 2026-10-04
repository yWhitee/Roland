const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Leveling } = require('../permissions');
const levels = require('../services/levels');
const { successEmbed } = require('../utils/embeds');

module.exports = {
  level: Leveling.REWARDS,
  data: new SlashCommandBuilder()
    .setName('levelsystem')
    .setDescription('Set the role members receive when they reach a level')
    .addRoleOption((option) => option.setName('role').setDescription('Role to give').setRequired(true))
    .addIntegerOption((option) =>
      option.setName('level').setDescription('Level that grants the role (1-200)').setRequired(true).setMinValue(1).setMaxValue(levels.MAX_LEVEL),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const option = interaction.options.getRole('role', true);
    const role = interaction.guild.roles.cache.get(option.id);
    const level = interaction.options.getInteger('level', true);

    const { previous, otherLevels, updated } = await levels.setReward(interaction.guild, role, level, interaction.user.id);
    const lines = [`Members who reach **level ${level}** will receive <@&${role.id}>. Each member keeps only the reward of the highest level they reached.`];
    if (previous) lines.push(`This replaces the previous reward for that level (<@&${previous}>).`);
    if (otherLevels.length) lines.push(`<@&${role.id}> is also the reward for level ${otherLevels.join(', ')}.`);
    lines.push(`Updated ${updated.members} member(s) already at level ${level} or above.`);
    if (updated.failed) lines.push(`⚠️ ${updated.failed} member(s) could not be updated; see the logs.`);
    await interaction.editReply({ embeds: [successEmbed(lines.join('\n'))] });
  },
};
