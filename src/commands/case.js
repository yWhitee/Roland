const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } = require('discord.js');
const punishments = require('../database/punishments');
const { Level } = require('../permissions');
const { ACTIONS, Colors, caseEmbed, describe, recordLabel } = require('../utils/embeds');
const moderation = require('../services/moderation');
const { UserError } = require('../utils/errors');

const PAGE_SIZE = 5;

const render = (guildId, ownerId, requestedPage) => {
  const total = punishments.countCases(guildId);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(Number.isInteger(requestedPage) ? requestedPage : 0, 0), pages - 1);
  const cases = punishments.listCases(guildId, PAGE_SIZE, page * PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Moderation Cases')
    .setDescription(total ? `**Total cases:** ${total}` : 'No cases recorded in this server.')
    .addFields(
      cases.map((record) => ({
        name: `${ACTIONS[record.type].emoji} Case #${record.case_number} • ${recordLabel(record)}${record.removed_at ? ' • Removed from Modlog' : ''}`,
        value: describe(record),
      })),
    )
    .setFooter({ text: `Page ${page + 1} / ${pages}` });

  const button = (name, label, target, disabled) =>
    new ButtonBuilder().setCustomId(`case:${ownerId}:${name}:${target}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  const navigation = new ActionRowBuilder().addComponents(
    button('first', '⏮', 0, page === 0),
    button('previous', '◀', page - 1, page === 0),
    button('next', '▶', page + 1, page >= pages - 1),
    button('last', '⏭', pages - 1, page >= pages - 1),
  );

  return { embeds: [embed], components: pages > 1 ? [navigation] : [] };
};

module.exports = {
  level: Level.MODERATOR,
  render,
  data: new SlashCommandBuilder()
    .setName('case')
    .setDescription('Show a moderation case, or all cases of this server')
    .addStringOption((option) => option.setName('case').setDescription('Case number, or "all"').setRequired(true).setMaxLength(16)),
  async execute(interaction) {
    const input = interaction.options.getString('case', true).trim().toLowerCase();
    if (input === 'all') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return interaction.editReply(render(interaction.guildId, interaction.user.id, 0));
    }

    const caseNumber = moderation.caseNumberOf(input);
    if (!caseNumber) throw new UserError('Provide a case number, e.g. /case 184, or /case all.');
    const record = punishments.findByCase(interaction.guildId, caseNumber);
    if (!record) throw new UserError(`Case #${caseNumber} does not exist in this server.`);
    return interaction.reply({ embeds: [caseEmbed(record)], flags: MessageFlags.Ephemeral });
  },
  async handleComponent(interaction) {
    const [, ownerId, , page] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) throw new UserError('Only the moderator who opened this list can change its page.');
    await interaction.update(render(interaction.guildId, ownerId, Number(page)));
  },
};
