const { Events } = require('discord.js');
const permissions = require('../permissions');
const { UserError } = require('../utils/errors');
const { replyError } = require('../utils/interactions');

const route = (interaction) => {
  const { commands, components } = interaction.client;
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName);
    return command && { level: command.level, global: command.global, run: command.execute };
  }

  const prefix = interaction.customId.split(':')[0];
  const command = commands.get(prefix);
  if (command?.handleComponent) return { level: command.level, run: command.handleComponent };
  const component = components.get(prefix);
  return component && { level: component.level, run: component.execute };
};

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (!interaction.isChatInputCommand() && !interaction.isMessageComponent() && !interaction.isModalSubmit()) return;

    const handler = route(interaction);
    if (!handler) return;

    try {
      if (!handler.global && !interaction.inCachedGuild()) throw new UserError('This can only be used inside a server.');
      permissions.assertCommand(interaction.member, handler.level);
      await handler.run(interaction);
    } catch (error) {
      await replyError(interaction, error);
    }
  },
};
