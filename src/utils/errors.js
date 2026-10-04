const { RESTJSONErrorCodes } = require('discord.js');

class UserError extends Error {}

const API_MESSAGES = {
  [RESTJSONErrorCodes.MissingPermissions]: 'O bot não tem permissão ou posição de cargo suficiente para executar esta ação.',
  [RESTJSONErrorCodes.MissingAccess]: 'O bot não tem acesso a este canal.',
  [RESTJSONErrorCodes.UnknownMember]: 'Este usuário não está no servidor.',
  [RESTJSONErrorCodes.UnknownUser]: 'Usuário não encontrado.',
  [RESTJSONErrorCodes.UnknownBan]: 'Este usuário não está banido.',
};

const userMessage = (error) => {
  if (error instanceof UserError) return error.message;
  if (API_MESSAGES[error?.code]) return API_MESSAGES[error.code];
  console.error(error);
  return 'Ocorreu um erro inesperado ao executar esta ação.';
};

module.exports = { UserError, userMessage };
