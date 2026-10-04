const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const moderation = require('../services/moderation');
const { recordEmbed } = require('../utils/embeds');
const { context } = require('../utils/interactions');
const options = require('../utils/options');
const { resolveTarget } = require('../utils/users');

module.exports = {
  level: Level.MODERATOR,
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Apaga mensagens recentes deste canal')
    .addIntegerOption((option) =>
      option
        .setName('quantidade')
        .setDescription(`Quantidade de mensagens (1-${moderation.MAX_CLEAR})`)
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(moderation.MAX_CLEAR),
    )
    .addStringOption(options.user(false)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const input = interaction.options.getString('usuario');
    const record = await moderation.clear({
      ...context(interaction),
      channel: interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId)),
      amount: interaction.options.getInteger('quantidade', true),
      target: input ? await resolveTarget(interaction.guild, input) : null,
    });
    await interaction.editReply({ embeds: [recordEmbed(record, 'Mensagens apagadas')] });
  },
};
