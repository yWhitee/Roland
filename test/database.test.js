const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const database = require('../src/database');
const punishments = require('../src/database/punishments');
const guildSettings = require('../src/database/guildSettings');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roland-')), 'test.db');

test.before(() => database.open(file));
test.after(() => database.close());

test('registros sobrevivem à reinicialização', () => {
  const ban = punishments.create({ type: 'ban', guildId: 'g', userId: 'u', moderatorId: 'm', reason: 'r', duration: '7d', expiresAt: 1000, active: true, channelId: 'c' });
  const clear = punishments.create({ type: 'clear', guildId: 'g', userId: 'u', moderatorId: 'm', channelId: 'c', metadata: { requested: 50, deleted: 42 } });

  database.close();
  database.open(file);

  assert.equal(database.get().pragma('user_version', { simple: true }), 1);
  assert.deepEqual(punishments.findById(ban.id), ban);
  assert.deepEqual(punishments.findById(clear.id).metadata, { requested: 50, deleted: 42 });
  assert.equal(punishments.countByUser('g', 'u'), 2);
  assert.deepEqual(punishments.listByUser('g', 'u', 10).map((record) => record.type), ['clear', 'ban']);
  assert.equal(ban.active, true);
  assert.equal(ban.expires_at, 1000);
});

test('bans temporários pendentes e desativação', () => {
  const due = punishments.create({ type: 'ban', guildId: 'g2', userId: 'a', moderatorId: 'm', expiresAt: 500, active: true });
  punishments.create({ type: 'ban', guildId: 'g2', userId: 'b', moderatorId: 'm', expiresAt: 5000, active: true });
  punishments.create({ type: 'ban', guildId: 'g2', userId: 'c', moderatorId: 'm', active: true });

  const ids = (now) => punishments.dueBans(now).filter((ban) => ban.guild_id === 'g2').map((ban) => ban.user_id);
  assert.deepEqual(ids(1000), ['a']);
  assert.deepEqual(ids(10_000), ['a', 'b']);

  assert.equal(punishments.deactivateBans('g2', 'a'), 1);
  assert.equal(punishments.findById(due.id).active, false);
  assert.deepEqual(ids(10_000), ['b']);
});

test('configuração de logs persiste e off mantém o canal', () => {
  guildSettings.enableLogs('g', 'canal1');
  database.close();
  database.open(file);
  assert.deepEqual(guildSettings.get('g'), { guild_id: 'g', log_channel_id: 'canal1', logs_enabled: 1 });

  guildSettings.disableLogs('g');
  assert.deepEqual(guildSettings.get('g'), { guild_id: 'g', log_channel_id: 'canal1', logs_enabled: 0 });

  guildSettings.enableLogs('g', 'canal2');
  assert.equal(guildSettings.get('g').log_channel_id, 'canal2');
  assert.equal(guildSettings.get('g').logs_enabled, 1);
});
