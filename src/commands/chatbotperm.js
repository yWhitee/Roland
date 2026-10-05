const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const chatbot = require('../services/chatbot');
const chatbotAccess = require('../services/chatbotPermissions');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const options = require('../utils/options');
const { parseUserId } = require('../utils/users');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chatbotperm')
    .setDescription('Allow or remove chatbot access for a user (server owner only)')
    .addStringOption(options.user())
    .addBooleanOption((option) => option.setName('enabled').setDescription('true to allow the chatbot, false to remove access').setRequired(true)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    chatbotAccess.assertServerOwner(interaction);
    const userId = parseUserId(interaction.options.getString('user', true));
    const enabled = interaction.options.getBoolean('enabled', true);
    if (userId === interaction.guild.ownerId) throw new UserError('The server owner always has chatbot access, so it cannot be changed.');

    const changed = chatbotAccess.setPermission({ guild: interaction.guild, userId, enabled, updatedBy: interaction.user.id, now: interaction.createdTimestamp });
    if (enabled) {
      if (!changed) throw new UserError(`<@${userId}> already has chatbot access.`);
      return interaction.editReply({ embeds: [successEmbed(`<@${userId}> can now use /chatbot. Kick, ban and unban stay reserved to the server owner.`)] });
    }

    const ended = await chatbot.revokeUser(interaction.guild, userId, 'its owner lost chatbot access');
    if (!changed && !ended.sessions && !ended.actions) throw new UserError(`<@${userId}> does not have chatbot access.`);
    return interaction.editReply({
      embeds: [successEmbed(`<@${userId}> no longer has chatbot access. Sessions ended: ${ended.sessions}. Pending actions cancelled: ${ended.actions}.`)],
    });
  },
};
