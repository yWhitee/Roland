const { ApplicationFlags, GatewayIntentBits, REST, Routes } = require('discord.js');

const BASE = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages];

const hasAny = (flags, ...values) => values.some((value) => (flags & value) === value);

const resolveIntents = async (token, rest = new REST().setToken(token)) => {
  let flags = 0;
  try {
    ({ flags = 0 } = await rest.get(Routes.currentApplication()));
  } catch (error) {
    console.error(`Could not read the application's privileged intents: ${error.message}`);
  }

  const capabilities = {
    messageContent: hasAny(flags, ApplicationFlags.GatewayMessageContent, ApplicationFlags.GatewayMessageContentLimited),
    members: hasAny(flags, ApplicationFlags.GatewayGuildMembers, ApplicationFlags.GatewayGuildMembersLimited),
  };

  const intents = [...BASE];
  if (capabilities.messageContent) intents.push(GatewayIntentBits.MessageContent);
  else console.warn('Message Content intent is disabled in the Developer Portal: Anti-Invite, Anti-Duplicate and Anti-Emoji Spam cannot read messages.');
  if (capabilities.members) intents.push(GatewayIntentBits.GuildMembers);
  else console.warn('Server Members intent is disabled in the Developer Portal: Anti-Raid cannot detect member joins.');

  return { intents, capabilities };
};

module.exports = { BASE, resolveIntents };
