const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const automodSettings = require('../database/automodSettings');
const automodWhitelist = require('../database/automodWhitelist');
const { Automod } = require('../permissions');
const { listPage } = require('../services/automod/messages');

const render = (guildId, page) => listPage(page, automodSettings.enabledFunctions(guildId), automodWhitelist.list(guildId));

module.exports = {
  level: Automod.VIEW,
  render,
  data: new SlashCommandBuilder().setName('automodlist').setDescription('Show every AutoMod function, its Function ID, actions and whitelist'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(render(interaction.guildId, 0));
  },
  async handleComponent(interaction) {
    await interaction.update(render(interaction.guildId, Number(interaction.customId.split(':')[1])));
  },
};
