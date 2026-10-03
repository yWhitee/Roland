const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Testa a conexão do bot'),
  async execute(interaction) {
    await interaction.reply(`Pong! ${interaction.client.ws.ping}ms`);
  },
};
