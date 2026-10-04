const { UserError } = require('../utils/errors');

const ROLES = {
  CREATOR: '1555595294236872744',
  ADMINISTRATOR: '1555597468773777459',
  SENIOR_MODERATOR: '1555597533655474217',
  MODERATOR: '1555596754278162452',
};

const Level = { NONE: 0, MODERATOR: 1, SENIOR_MODERATOR: 2, ADMINISTRATOR: 3, CREATOR: 4 };

const ROLE_LEVELS = [
  [ROLES.CREATOR, Level.CREATOR],
  [ROLES.ADMINISTRATOR, Level.ADMINISTRATOR],
  [ROLES.SENIOR_MODERATOR, Level.SENIOR_MODERATOR],
  [ROLES.MODERATOR, Level.MODERATOR],
];

const getLevel = (member) => ROLE_LEVELS.find(([roleId]) => member?.roles.cache.has(roleId))?.[1] ?? Level.NONE;

const assertCommand = (member, required) => {
  if (required && getLevel(member) < required) throw new UserError('Você não tem permissão para usar este comando.');
};

const assertCanModerate = (moderator, { user, member }) => {
  if (user.id === moderator.id) throw new UserError('Você não pode executar esta ação em si mesmo.');
  if (user.id === moderator.client.user.id) throw new UserError('Não posso executar esta ação em mim mesmo.');

  const level = getLevel(member);
  if (level === Level.CREATOR) throw new UserError('O Creator não pode ser afetado por comandos de moderação.');
  if (level >= getLevel(moderator)) throw new UserError('Você não pode moderar um usuário com cargo igual ou superior ao seu.');
};

module.exports = { ROLES, Level, getLevel, assertCommand, assertCanModerate };
