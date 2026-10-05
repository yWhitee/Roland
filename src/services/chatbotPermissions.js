const store = require('../database/chatbotPermissions');
const { UserError } = require('../utils/errors');

const ACCESS = { SERVER_OWNER: 'SERVER_OWNER', AUTHORIZED_USER: 'AUTHORIZED_USER', NONE: 'NONE' };
const OWNER_ONLY_TOOLS = new Set(['kick_member', 'ban_member', 'unban_member']);

const isAuthorized = (guildId, userId) => Boolean(store.get(guildId, userId)?.enabled);

const getChatbotAccess = (guild, userId) => {
  if (!guild?.id || !userId) return ACCESS.NONE;
  if (userId === guild.ownerId) return ACCESS.SERVER_OWNER;
  return isAuthorized(guild.id, userId) ? ACCESS.AUTHORIZED_USER : ACCESS.NONE;
};

const canExecuteChatbotAction = (access, toolName) => access !== ACCESS.NONE && (!OWNER_ONLY_TOOLS.has(toolName) || access === ACCESS.SERVER_OWNER);

const assertServerOwner = (interaction) => {
  if (!interaction.guild || interaction.user.id !== interaction.guild.ownerId) throw new UserError('Only the server owner can use this command.');
};

const assertChatbotAccess = (interaction) => {
  const access = getChatbotAccess(interaction.guild, interaction.user.id);
  if (access === ACCESS.NONE) throw new UserError('You do not have access to the chatbot. The server owner can grant it with /chatbotperm.');
  return access;
};

const setPermission = ({ guild, userId, enabled, updatedBy, now }) => store.set({ guildId: guild.id, userId, enabled, updatedBy, now });

module.exports = { ACCESS, OWNER_ONLY_TOOLS, getChatbotAccess, canExecuteChatbotAction, assertServerOwner, assertChatbotAccess, setPermission };
