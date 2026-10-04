const { RESTJSONErrorCodes } = require('discord.js');

class UserError extends Error {}

const API_MESSAGES = {
  [RESTJSONErrorCodes.MissingPermissions]: 'The bot does not have enough permissions or role hierarchy to perform this action.',
  [RESTJSONErrorCodes.MissingAccess]: 'The bot does not have access to this channel.',
  [RESTJSONErrorCodes.UnknownMember]: 'This user is not a member of the server.',
  [RESTJSONErrorCodes.UnknownUser]: 'User not found.',
  [RESTJSONErrorCodes.UnknownBan]: 'This user is not banned.',
  [RESTJSONErrorCodes.UnknownChannel]: 'The channel no longer exists.',
  [RESTJSONErrorCodes.UnknownMessage]: 'The message no longer exists.',
  [RESTJSONErrorCodes.UnknownRole]: 'One of the configured roles no longer exists.',
  [RESTJSONErrorCodes.MaximumNumberOfGuildChannelsReached]: 'The server has reached the maximum number of channels.',
};

const userMessage = (error) => {
  if (error instanceof UserError) return error.message;
  if (API_MESSAGES[error?.code]) return API_MESSAGES[error.code];
  console.error(error);
  return 'An unexpected error occurred while performing this action.';
};

module.exports = { UserError, userMessage };
