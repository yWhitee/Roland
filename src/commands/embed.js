const { SlashCommandBuilder } = require('discord.js');
const { Level } = require('../permissions');
const embedBuilder = require('../services/embedBuilder');

module.exports = {
  level: Level.SENIOR_MODERATOR,
  data: new SlashCommandBuilder().setName('embed').setDescription('Open the interactive embed builder'),
  execute: (interaction) => embedBuilder.start(interaction, { prefix: 'embed' }),
  handleComponent: embedBuilder.handle,
};
