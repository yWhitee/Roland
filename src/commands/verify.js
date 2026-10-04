const { SlashCommandBuilder } = require('discord.js');
const verification = require('../services/verification');

module.exports = {
  data: new SlashCommandBuilder().setName('verify').setDescription('Verify with Roblox or change your linked Roblox account'),
  execute: (interaction) => verification.start(interaction, { replace: true }),
};
