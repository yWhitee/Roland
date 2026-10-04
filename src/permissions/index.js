const { UserError } = require('../utils/errors');

const ROLES = {
  CREATOR: '1555595294236872744',
  ADMINISTRATOR: '1555597468773777459',
  SENIOR_MODERATOR: '1555597533655474217',
  MODERATOR: '1555596754278162452',
  SUPPORT: '1556115487757307996',
};

const Level = { NONE: 0, SUPPORT: 1, MODERATOR: 2, SENIOR_MODERATOR: 3, ADMINISTRATOR: 4, CREATOR: 5 };

const ROLE_LEVELS = [
  [ROLES.CREATOR, Level.CREATOR],
  [ROLES.ADMINISTRATOR, Level.ADMINISTRATOR],
  [ROLES.SENIOR_MODERATOR, Level.SENIOR_MODERATOR],
  [ROLES.MODERATOR, Level.MODERATOR],
  [ROLES.SUPPORT, Level.SUPPORT],
];

const getLevel = (member) => ROLE_LEVELS.find(([roleId]) => member?.roles.cache.has(roleId))?.[1] ?? Level.NONE;

const rolesAtLeast = (level) => ROLE_LEVELS.filter(([, roleLevel]) => roleLevel >= level).map(([roleId]) => roleId);

const assertCommand = (member, required) => {
  if (required && getLevel(member) < required) throw new UserError('You do not have permission to use this command.');
};

const assertCanModerate = (moderator, { user, member }) => {
  if (user.id === moderator.id) throw new UserError('You cannot perform this action on yourself.');
  if (user.id === moderator.client.user.id) throw new UserError('I cannot perform this action on myself.');

  const level = getLevel(member);
  if (level === Level.CREATOR) throw new UserError('The Creator cannot be targeted by moderation actions.');
  if (level >= getLevel(moderator)) throw new UserError('You cannot moderate a user with an equal or higher role than yours.');
};

const Tickets = {
  STAFF: Level.SUPPORT,
  RETAINED_AFTER_CLAIM: Level.SENIOR_MODERATOR,
  MANAGER: Level.ADMINISTRATOR,
};

const isTicketStaff = (member) => getLevel(member) >= Tickets.STAFF;

const canCloseTicket = (member, ticket) => member.id === ticket.claimed_by || getLevel(member) >= Tickets.MANAGER;

const canDeleteTicket = (member) => getLevel(member) >= Tickets.MANAGER;

module.exports = {
  ROLES,
  Level,
  Tickets,
  getLevel,
  rolesAtLeast,
  assertCommand,
  assertCanModerate,
  isTicketStaff,
  canCloseTicket,
  canDeleteTicket,
};
