const { Events } = require('discord.js');
const permissions = require('../permissions');
const { UserError } = require('../utils/errors');
const { replyError } = require('../utils/interactions');

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction) {
    const isCommand = interaction.isChatInputCommand();
    if (!isCommand && !interaction.isMessageComponent() && !interaction.isModalSubmit()) return;

    const command = interaction.client.commands.get(isCommand ? interaction.commandName : interaction.customId.split(':')[0]);
    const handler = isCommand ? command?.execute : command?.handleComponent;
    if (!handler) return;

    try {
      if (!interaction.inCachedGuild()) throw new UserError('Este comando só pode ser usado dentro de um servidor.');
      permissions.assertCommand(interaction.member, command.level);
      await handler(interaction);
    } catch (error) {
      await replyError(interaction, error);
    }
  },
};
