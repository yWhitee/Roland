const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUserId, resolveTarget } = require('../src/utils/users');
const { UserError } = require('../src/utils/errors');

const ID = '123456789012345678';

test('menção e ID resultam no mesmo usuário', () => {
  assert.equal(parseUserId(`<@${ID}>`), ID);
  assert.equal(parseUserId(`<@!${ID}>`), ID);
  assert.equal(parseUserId(ID), ID);
  assert.equal(parseUserId(`  ${ID} `), ID);
});

test('rejeita entradas inválidas', () => {
  for (const input of ['', 'abc', '@usuario', '1234', `<@&${ID}>`, `<#${ID}>`, '99999999999999999999', `${ID}x`]) {
    assert.throws(() => parseUserId(input), UserError, input);
  }
});

const apiError = (status) => Object.assign(new Error('api'), { status });

const guild = ({ userExists = true, isMember = true } = {}) => ({
  client: {
    users: { fetch: async (id) => (userExists ? { id } : Promise.reject(apiError(404))) },
  },
  members: { fetch: async ({ user }) => (isMember ? { id: user } : Promise.reject(apiError(404))) },
});

test('resolve usuário membro e não membro', async () => {
  assert.deepEqual(await resolveTarget(guild(), `<@${ID}>`), { user: { id: ID }, member: { id: ID } });
  assert.deepEqual(await resolveTarget(guild({ isMember: false }), ID), { user: { id: ID }, member: null });
});

test('usuário inexistente gera erro amigável', async () => {
  await assert.rejects(resolveTarget(guild({ userExists: false }), ID), UserError);
});
