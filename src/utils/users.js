const { UserError } = require('./errors');

const MENTION = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/;

const parseUserId = (input) => {
  const match = String(input ?? '').trim().match(MENTION);
  const id = match?.[1] ?? match?.[2];
  if (!id || BigInt(id) >= 2n ** 64n) throw new UserError('Invalid user. Provide a mention or a numeric user ID.');
  return id;
};

const resolveUser = async (client, input) => {
  const id = parseUserId(input);
  return client.users.fetch(id).catch((error) => {
    if (error.status === 400 || error.status === 404) throw new UserError('User not found.');
    throw error;
  });
};

const resolveTarget = async (guild, input) => {
  const user = await resolveUser(guild.client, input);
  const member = await guild.members.fetch({ user: user.id, force: true }).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  });
  return { user, member };
};

module.exports = { parseUserId, resolveUser, resolveTarget };
