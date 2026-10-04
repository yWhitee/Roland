const { Routes } = require('discord.js');

const split = (commands) => ({
  guild: commands.filter((command) => !command.global).map((command) => command.data.toJSON()),
  global: commands.filter((command) => command.global).map((command) => command.data.toJSON()),
});

const registerCommands = async (rest, { clientId, guildId, commands }) => {
  const { guild, global } = split(commands);
  const guildCommands = await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: guild });
  const globalCommands = await rest.put(Routes.applicationCommands(clientId), { body: global });
  return { guild: guildCommands.map((command) => command.name), global: globalCommands.map((command) => command.name) };
};

module.exports = { split, registerCommands };
