const { ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');

const GAME_URL = 'https://www.roblox.com/games/138399961471218';

module.exports = {
  global: true,
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play Slime Odyssey: Anime Realms on Roblox')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  execute: (interaction) =>
    interaction.reply({
      content: 'Go play **Slime Odyssey: Anime Realms**!',
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Play on Roblox').setStyle(ButtonStyle.Link).setURL(GAME_URL))],
      flags: MessageFlags.Ephemeral,
    }),
};
