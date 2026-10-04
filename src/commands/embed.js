const { SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const embedBuilder = require('../services/embedBuilder');

module.exports = {
  level: Level.SENIOR_MODERATOR,
  data: new SlashCommandBuilder().setName('embed').setDescription('Abre o construtor interativo de embeds'),
  execute: embedBuilder.start,
  handleComponent: embedBuilder.handle,
};
