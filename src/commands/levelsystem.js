const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Leveling } = require('../permissions');
const levels = require('../services/levels');
const { number } = require('../services/levels/messages');
const { successEmbed } = require('../utils/embeds');

module.exports = {
  level: Leveling.REWARDS,
  data: new SlashCommandBuilder()
    .setName('levelsystem')
    .setDescription('Set the role members receive when they reach a level')
    .addRoleOption((option) => option.setName('role').setDescription('Role to give').setRequired(true))
    .addIntegerOption((option) => option.setName('level').setDescription('Level that grants the role (1 or more)').setRequired(true).setMinValue(1)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const option = interaction.options.getRole('role', true);
    const role = interaction.guild.roles.cache.get(option.id);
    const level = interaction.options.getInteger('level', true);

    const { previous, otherLevels } = levels.setReward(interaction.guild, role, level, interaction.user.id);
    const lines = [`Members who reach **level ${number(level)}** will receive <@&${role.id}>.`];
    if (previous) lines.push(`This replaces the previous reward for that level (<@&${previous}>).`);
    if (otherLevels.length) lines.push(`<@&${role.id}> is also the reward for level ${otherLevels.map(number).join(', ')}; members keep it from the first of those levels they reach.`);
    lines.push('Members already above this level receive the role at their next level-up or when they use /level.');
    await interaction.editReply({ embeds: [successEmbed(lines.join('\n'))] });
  },
};
