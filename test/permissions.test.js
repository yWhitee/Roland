const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../src/loader');
const permissions = require('../src/permissions');
const { UserError } = require('../src/utils/errors');
const { BOT_ID, makeMember } = require('./helpers/discord');

const { ROLES, Level, getLevel, assertCommand, assertCanModerate } = permissions;

const RANKS = {
  member: null,
  support: ROLES.SUPPORT,
  moderator: ROLES.MODERATOR,
  senior: ROLES.SENIOR_MODERATOR,
  admin: ROLES.ADMINISTRATOR,
  owner: ROLES.CREATOR,
};
const ORDER = Object.keys(RANKS);

const target = (member) => ({ user: member.user, member });

test('each role maps to its level and the highest role wins', () => {
  assert.equal(getLevel(makeMember()), Level.NONE);
  assert.equal(getLevel(makeMember(ROLES.SUPPORT)), Level.SUPPORT);
  assert.equal(getLevel(makeMember(ROLES.MODERATOR)), Level.MODERATOR);
  assert.equal(getLevel(makeMember(ROLES.SENIOR_MODERATOR)), Level.SENIOR_MODERATOR);
  assert.equal(getLevel(makeMember(ROLES.ADMINISTRATOR)), Level.ADMINISTRATOR);
  assert.equal(getLevel(makeMember(ROLES.CREATOR)), Level.CREATOR);
  assert.equal(ROLES.SUPPORT, '1556115487757307996');

  const both = makeMember(ROLES.SUPPORT);
  both.roles.cache.set(ROLES.ADMINISTRATOR, {});
  assert.equal(getLevel(both), Level.ADMINISTRATOR);
  assert.equal(getLevel(null), Level.NONE);
});

test('command permission matrix', () => {
  const commands = Object.fromEntries(load(path.join(__dirname, '..', 'src', 'commands')).map((command) => [command.data.name, command]));
  const allowed = {
    ping: ['member', 'support', 'moderator', 'senior', 'admin', 'owner'],
    mute: ['moderator', 'senior', 'admin', 'owner'],
    clear: ['moderator', 'senior', 'admin', 'owner'],
    warn: ['moderator', 'senior', 'admin', 'owner'],
    modlog: ['moderator', 'senior', 'admin', 'owner'],
    ban: ['senior', 'admin', 'owner'],
    kick: ['senior', 'admin', 'owner'],
    unban: ['senior', 'admin', 'owner'],
    unmute: ['senior', 'admin', 'owner'],
    embed: ['senior', 'admin', 'owner'],
    logs: ['admin', 'owner'],
    ticketcreate: ['admin', 'owner'],
  };

  assert.deepEqual(Object.keys(commands).sort(), Object.keys(allowed).sort());
  for (const [name, ranks] of Object.entries(allowed)) {
    for (const rank of ORDER) {
      const run = () => assertCommand(makeMember(RANKS[rank]), commands[name].level);
      if (ranks.includes(rank)) assert.doesNotThrow(run, `${rank} should be able to use /${name}`);
      else assert.throws(run, UserError, `${rank} should not be able to use /${name}`);
    }
  }
});

test('the Creator can never be targeted', () => {
  for (const rank of ORDER) {
    assert.throws(() => assertCanModerate(makeMember(RANKS[rank]), target(makeMember(ROLES.CREATOR))), /Creator/, rank);
  }
});

test('nobody can moderate an equal or higher role', () => {
  for (const [executorIndex, executor] of ORDER.entries()) {
    for (const [targetIndex, victim] of ORDER.entries()) {
      const run = () => assertCanModerate(makeMember(RANKS[executor]), target(makeMember(RANKS[victim])));
      if (targetIndex < executorIndex) assert.doesNotThrow(run, `${executor} -> ${victim}`);
      else assert.throws(run, UserError, `${executor} -> ${victim}`);
    }
  }
});

test('users outside the server count as having no role', () => {
  assert.doesNotThrow(() => assertCanModerate(makeMember(ROLES.MODERATOR), { user: { id: '123456789012345678' }, member: null }));
});

test('cannot target yourself or the bot', () => {
  const executor = makeMember(ROLES.CREATOR);
  assert.throws(() => assertCanModerate(executor, target(executor)), UserError);
  assert.throws(() => assertCanModerate(executor, { user: { id: BOT_ID }, member: null }), UserError);
});

test('ticket staff, close and delete rules', () => {
  const staff = ORDER.filter((rank) => permissions.isTicketStaff(makeMember(RANKS[rank])));
  assert.deepEqual(staff, ['support', 'moderator', 'senior', 'admin', 'owner']);

  const claimant = makeMember(ROLES.SUPPORT);
  const ticket = { claimed_by: claimant.id };
  const closers = ORDER.filter((rank) => permissions.canCloseTicket(makeMember(RANKS[rank]), ticket));
  assert.deepEqual(closers, ['admin', 'owner']);
  assert.ok(permissions.canCloseTicket(claimant, ticket));

  const deleters = ORDER.filter((rank) => permissions.canDeleteTicket(makeMember(RANKS[rank])));
  assert.deepEqual(deleters, ['admin', 'owner']);
});
