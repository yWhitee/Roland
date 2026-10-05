const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const moderation = require('../services/moderation');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const options = require('../utils/options');
const { parseUserId } = require('../utils/users');

module.exports = {
  level: Level.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('caseremove')
    .setDescription("Remove one or all of a user's cases from /modlog (cases are kept)")
    .addStringOption(options.user())
    .addStringOption((option) => option.setName('case').setDescription('Case number, or "all" for every case of this user').setRequired(true).setMaxLength(16)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = parseUserId(interaction.options.getString('user', true));
    const input = interaction.options.getString('case', true).trim().toLowerCase();
    const context = { guild: interaction.guild, moderator: interaction.member, userId };

    if (input === 'all') {
      const removed = await moderation.removeUserCases(context);
      return interaction.editReply({
        embeds: [successEmbed(`${removed.length} ${removed.length === 1 ? 'case' : 'cases'} of <@${userId}> removed from the modlog. They are still available with /case.`)],
      });
    }

    const caseNumber = moderation.caseNumberOf(input);
    if (!caseNumber) throw new UserError('Provide a case number, e.g. /caseremove @user 184, or all.');
    await moderation.removeCase({ ...context, caseNumber });
    return interaction.editReply({ embeds: [successEmbed(`Case #${caseNumber} of <@${userId}> removed from the modlog. It is still available with /case ${caseNumber}.`)] });
  },
};
