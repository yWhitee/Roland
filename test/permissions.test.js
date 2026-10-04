const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../src/loader');
const { ROLES, Level, getLevel, assertCommand, assertCanModerate } = require('../src/permissions');
const { UserError } = require('../src/utils/errors');

const BOT_ID = '900000000000000000';
let nextId = 100000000000000000n;

const member = (...roles) => {
  const id = String(nextId++);
  return { id, user: { id }, client: { user: { id: BOT_ID } }, roles: { cache: new Map(roles.map((role) => [role, {}])) } };
};
const target = (m) => ({ user: m.user, member: m });

const RANKS = {
  none: [],
  moderator: [ROLES.MODERATOR],
  senior: [ROLES.SENIOR_MODERATOR],
  admin: [ROLES.ADMINISTRATOR],
  creator: [ROLES.CREATOR],
};

test('nível de cada cargo, usando o maior cargo do membro', () => {
  assert.equal(getLevel(member()), Level.NONE);
  assert.equal(getLevel(member(ROLES.MODERATOR)), Level.MODERATOR);
  assert.equal(getLevel(member(ROLES.SENIOR_MODERATOR)), Level.SENIOR_MODERATOR);
  assert.equal(getLevel(member(ROLES.ADMINISTRATOR)), Level.ADMINISTRATOR);
  assert.equal(getLevel(member(ROLES.CREATOR)), Level.CREATOR);
  assert.equal(getLevel(member(ROLES.MODERATOR, ROLES.ADMINISTRATOR)), Level.ADMINISTRATOR);
  assert.equal(getLevel(null), Level.NONE);
});

test('matriz de permissões por comando', () => {
  const commands = Object.fromEntries(load(path.join(__dirname, '..', 'src', 'commands')).map((command) => [command.data.name, command]));
  const allowed = {
    ping: ['none', 'moderator', 'senior', 'admin', 'creator'],
    mute: ['moderator', 'senior', 'admin', 'creator'],
    clear: ['moderator', 'senior', 'admin', 'creator'],
    warn: ['moderator', 'senior', 'admin', 'creator'],
    modlog: ['moderator', 'senior', 'admin', 'creator'],
    ban: ['senior', 'admin', 'creator'],
    kick: ['senior', 'admin', 'creator'],
    unban: ['senior', 'admin', 'creator'],
    unmute: ['senior', 'admin', 'creator'],
    embed: ['senior', 'admin', 'creator'],
    logs: ['admin', 'creator'],
  };

  assert.deepEqual(Object.keys(commands).sort(), Object.keys(allowed).sort());
  for (const [name, ranks] of Object.entries(allowed)) {
    for (const [rank, roles] of Object.entries(RANKS)) {
      const run = () => assertCommand(member(...roles), commands[name].level);
      if (ranks.includes(rank)) assert.doesNotThrow(run, `${rank} deveria usar /${name}`);
      else assert.throws(run, UserError, `${rank} não deveria usar /${name}`);
    }
  }
});

test('Creator nunca pode ser afetado', () => {
  for (const rank of Object.keys(RANKS)) {
    assert.throws(() => assertCanModerate(member(...RANKS[rank]), target(member(ROLES.CREATOR))), /Creator/, rank);
  }
});

test('cargos não podem agir contra cargos iguais ou superiores', () => {
  const order = ['none', 'moderator', 'senior', 'admin', 'creator'];
  for (const [executorIndex, executor] of order.entries()) {
    for (const [targetIndex, victim] of order.entries()) {
      const run = () => assertCanModerate(member(...RANKS[executor]), target(member(...RANKS[victim])));
      if (targetIndex < executorIndex) assert.doesNotThrow(run, `${executor} -> ${victim}`);
      else assert.throws(run, UserError, `${executor} -> ${victim}`);
    }
  }
});

test('usuário fora do servidor é tratado como sem cargo', () => {
  const executor = member(ROLES.MODERATOR);
  assert.doesNotThrow(() => assertCanModerate(executor, { user: { id: '123456789012345678' }, member: null }));
});

test('não permite agir contra si mesmo nem contra o bot', () => {
  const executor = member(ROLES.CREATOR);
  assert.throws(() => assertCanModerate(executor, target(executor)), UserError);
  assert.throws(() => assertCanModerate(executor, { user: { id: BOT_ID }, member: null }), UserError);
});
