const { MessageFlags } = require('discord.js');
const { errorEmbed } = require('./embeds');
const { userMessage } = require('./errors');

const context = (interaction) => ({ guild: interaction.guild, moderator: interaction.member, channelId: interaction.channelId });

const replyError = async (interaction, error) => {
  const embeds = [errorEmbed(userMessage(error))];
  try {
    if (interaction.isChatInputCommand() && interaction.deferred && !interaction.replied) await interaction.editReply({ embeds });
    else if (interaction.deferred || interaction.replied) await interaction.followUp({ embeds, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
  } catch (failure) {
    console.error(`Falha ao responder interação: ${failure.message}`);
  }
};

module.exports = { context, replyError };
