const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const moderation = require('../services/moderation');
const { ACTIONS, Colors, describe } = require('../utils/embeds');
const options = require('../utils/options');
const { resolveUser } = require('../utils/users');

const PAGE_SIZE = 5;

const render = (guildId, userId, requestedPage) => {
  const { total, pages, page, records } = moderation.history(guildId, userId, requestedPage, PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Histórico de moderação')
    .setDescription(`**Usuário:** <@${userId}> (\`${userId}\`)\n**Total de registros:** ${total}${total ? '' : '\n\nNenhuma punição registrada.'}`)
    .addFields(records.map((record) => ({ name: `#${record.id} • ${ACTIONS[record.type].label}`, value: describe(record, { user: false }) })))
    .setFooter({ text: `Página ${page + 1} de ${pages}` });

  const navigation = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modlog:${userId}:${page - 1}`).setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`modlog:${userId}:${page + 1}`).setLabel('Próxima').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  );

  return { embeds: [embed], components: pages > 1 ? [navigation] : [] };
};

module.exports = {
  level: Level.MODERATOR,
  render,
  data: new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('Mostra o histórico de punições de um usuário')
    .addStringOption(options.user()),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = await resolveUser(interaction.client, interaction.options.getString('usuario', true));
    await interaction.editReply(render(interaction.guildId, user.id, 0));
  },
  async handleComponent(interaction) {
    const [, userId, page] = interaction.customId.split(':');
    await interaction.update(render(interaction.guildId, userId, Number(page)));
  },
};
