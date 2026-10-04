const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const moderation = require('../services/moderation');
const { Colors, describe, recordLabel } = require('../utils/embeds');
const options = require('../utils/options');
const { resolveUser } = require('../utils/users');

const PAGE_SIZE = 5;

const render = (guildId, userId, requestedPage) => {
  const { total, pages, page, records } = moderation.history(guildId, userId, requestedPage, PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Moderation history')
    .setDescription(`**User:** <@${userId}> (\`${userId}\`)\n**Total records:** ${total}${total ? '' : '\n\nNo punishments recorded.'}`)
    .addFields(records.map((record) => ({ name: `#${record.id} • ${recordLabel(record)}`, value: describe(record, { user: false }) })))
    .setFooter({ text: `Page ${page + 1} of ${pages}` });

  const navigation = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modlog:${userId}:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`modlog:${userId}:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  );

  return { embeds: [embed], components: pages > 1 ? [navigation] : [] };
};

module.exports = {
  level: Level.MODERATOR,
  render,
  data: new SlashCommandBuilder()
    .setName('modlog')
    .setDescription("Show a user's punishment history")
    .addStringOption(options.user()),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = await resolveUser(interaction.client, interaction.options.getString('user', true));
    await interaction.editReply(render(interaction.guildId, user.id, 0));
  },
  async handleComponent(interaction) {
    const [, userId, page] = interaction.customId.split(':');
    await interaction.update(render(interaction.guildId, userId, Number(page)));
  },
};
