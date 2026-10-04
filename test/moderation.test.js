const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection } = require('discord.js');
const database = require('../src/database');
const punishments = require('../src/database/punishments');
const guildSettings = require('../src/database/guildSettings');
const moderation = require('../src/services/moderation');
const logging = require('../src/services/logging');
const tempBans = require('../src/services/tempBans');
const { ROLES } = require('../src/permissions');
const { UserError } = require('../src/utils/errors');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roland-')), 'test.db');
const BOT_ID = '900000000000000000';
const DAY = 86_400_000;
let nextId = 100000000000000000n;

const apiError = (code, status = 404) => Object.assign(new Error('api'), { code, status });

const makeGuild = () => {
  const banned = new Set();
  const logs = [];
  const guild = {
    id: String(nextId++),
    name: 'Servidor Teste',
    client: { user: { id: BOT_ID } },
    banned,
    logs,
    bans: {
      fetch: async ({ user }) => {
        if (!banned.has(user)) throw apiError(10026);
        return {};
      },
      remove: async (id) => {
        if (!banned.has(id)) throw apiError(10026);
        banned.delete(id);
      },
    },
    members: { ban: async (id) => banned.add(id) },
    channels: { fetch: async () => ({ send: async (payload) => logs.push(payload) }) },
  };
  return guild;
};

const makeMember = (role, { dm = true } = {}) => {
  const id = String(nextId++);
  const state = { kicked: false, timeoutUntil: null, dms: [] };
  return {
    id,
    state,
    client: { user: { id: BOT_ID } },
    roles: { cache: new Map(role ? [[role, {}]] : []) },
    user: {
      id,
      tag: `user${id}`,
      send: async (payload) => {
        if (!dm) throw apiError(50007, 403);
        state.dms.push(payload);
      },
    },
    kick: async () => {
      state.kicked = true;
    },
    isCommunicationDisabled: () => state.timeoutUntil !== null && state.timeoutUntil > Date.now(),
    disableCommunicationUntil: async (until) => {
      state.timeoutUntil = until;
    },
    timeout: async (value) => {
      state.timeoutUntil = value === null ? null : Date.now() + value;
    },
  };
};

const target = (member) => ({ user: member.user, member });
const clientFor = (guild) => ({ user: { id: BOT_ID }, guilds: { cache: new Map([[guild.id, guild]]) } });

test.before(() => database.open(file));
test.after(() => database.close());

test('ban temporário registra, envia log e expira após reinicialização', async () => {
  const guild = makeGuild();
  guildSettings.enableLogs(guild.id, 'logs');
  const moderator = makeMember(ROLES.SENIOR_MODERATOR);
  const victim = makeMember();

  const start = Date.now();
  const record = await moderation.ban({ guild, moderator, target: target(victim), duration: '7d', reason: 'Spam', channelId: 'c' });
  assert.equal(record.type, 'ban');
  assert.equal(record.active, true);
  assert.equal(record.duration, '7d');
  assert.ok(Math.abs(record.expires_at - (start + 7 * DAY)) < 1000);
  assert.ok(guild.banned.has(victim.id));
  assert.equal(guild.logs.length, 1);

  database.close();
  database.open(file);

  await tempBans.sweep(clientFor(guild), start + 2 * DAY);
  assert.ok(guild.banned.has(victim.id), 'faltam 5 dias, deve continuar banido');
  assert.equal(punishments.findById(record.id).active, true);

  await tempBans.sweep(clientFor(guild), start + 30 * DAY);
  assert.ok(!guild.banned.has(victim.id), 'após o término, deve ser desbanido');
  assert.equal(punishments.findById(record.id).active, false);

  const [unban] = punishments.listByUser(guild.id, victim.id, 1);
  assert.equal(unban.type, 'unban');
  assert.equal(unban.moderator_id, BOT_ID);
  assert.match(unban.reason, /expirado/);
  assert.equal(guild.logs.length, 2);
});

test('ban permanente nunca expira automaticamente', async () => {
  const guild = makeGuild();
  const victim = makeMember();
  const record = await moderation.ban({ guild, moderator: makeMember(ROLES.ADMINISTRATOR), target: target(victim), duration: 'forever', reason: 'r' });
  assert.equal(record.expires_at, null);
  await tempBans.sweep(clientFor(guild), Date.now() + 1000 * 365 * DAY);
  assert.ok(guild.banned.has(victim.id));
});

test('ban: já banido, Creator, cargo superior, motivo vazio e duração inválida', async () => {
  const guild = makeGuild();
  const admin = makeMember(ROLES.ADMINISTRATOR);
  const victim = makeMember();
  await moderation.ban({ guild, moderator: admin, target: target(victim), duration: '1d', reason: 'r' });

  await assert.rejects(moderation.ban({ guild, moderator: admin, target: target(victim), duration: '1d', reason: 'r' }), /já está banido/);
  await assert.rejects(moderation.ban({ guild, moderator: admin, target: target(makeMember(ROLES.CREATOR)), duration: '1d', reason: 'r' }), /Creator/);
  await assert.rejects(moderation.ban({ guild, moderator: makeMember(ROLES.SENIOR_MODERATOR), target: target(makeMember(ROLES.ADMINISTRATOR)), duration: '1d', reason: 'r' }), /igual ou superior/);
  await assert.rejects(moderation.ban({ guild, moderator: admin, target: target(makeMember()), duration: '1d', reason: '   ' }), /motivo/);
  await assert.rejects(moderation.ban({ guild, moderator: admin, target: target(makeMember()), duration: '10x', reason: 'r' }), /Duração inválida/);
  assert.equal(guild.banned.size, 1);
});

test('unban manual desativa o ban temporário', async () => {
  const guild = makeGuild();
  const admin = makeMember(ROLES.ADMINISTRATOR);
  const victim = makeMember();
  const ban = await moderation.ban({ guild, moderator: admin, target: target(victim), duration: '1h', reason: 'r' });

  const unban = await moderation.unban({ guild, moderator: admin, target: { user: victim.user, member: null }, reason: 'Revisado' });
  assert.equal(unban.type, 'unban');
  assert.equal(punishments.findById(ban.id).active, false);
  await assert.rejects(moderation.unban({ guild, moderator: admin, target: { user: victim.user, member: null }, reason: 'r' }), /não está banido/);

  const before = punishments.countByUser(guild.id, victim.id);
  await tempBans.sweep(clientFor(guild), Date.now() + DAY);
  assert.equal(punishments.countByUser(guild.id, victim.id), before);
});

test('kick exige membro e registra', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.SENIOR_MODERATOR);
  const victim = makeMember(ROLES.MODERATOR);
  const record = await moderation.kick({ guild, moderator, target: target(victim), reason: 'r' });
  assert.equal(record.type, 'kick');
  assert.ok(victim.state.kicked);
  await assert.rejects(moderation.kick({ guild, moderator, target: { user: makeMember().user, member: null }, reason: 'r' }), /não está no servidor/);
});

test('mute e unmute com validações', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.MODERATOR);
  const victim = makeMember();

  await assert.rejects(moderation.mute({ guild, moderator, target: target(victim), duration: 'forever', reason: 'r' }), /permanente/);
  await assert.rejects(moderation.mute({ guild, moderator, target: target(victim), duration: '29d', reason: 'r' }), /28 dias/);
  await assert.rejects(moderation.mute({ guild, moderator, target: target(makeMember(ROLES.MODERATOR)), duration: '1h', reason: 'r' }), /igual ou superior/);

  const start = Date.now();
  const record = await moderation.mute({ guild, moderator, target: target(victim), duration: '30m', reason: 'Flood' });
  assert.equal(record.duration, '30m');
  assert.ok(Math.abs(record.expires_at - (start + 30 * 60_000)) < 1000);
  assert.equal(victim.state.timeoutUntil, record.expires_at);
  await assert.rejects(moderation.mute({ guild, moderator, target: target(victim), duration: '1h', reason: 'r' }), /já está mutado/);

  const senior = makeMember(ROLES.SENIOR_MODERATOR);
  const unmute = await moderation.unmute({ guild, moderator: senior, target: target(victim), reason: 'r' });
  assert.equal(unmute.type, 'unmute');
  assert.equal(victim.state.timeoutUntil, null);
  await assert.rejects(moderation.unmute({ guild, moderator: senior, target: target(victim), reason: 'r' }), /não está mutado/);
});

test('warn é registrado mesmo com DM fechada', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.MODERATOR);

  const open = makeMember();
  const sent = await moderation.warn({ guild, moderator, target: target(open), reason: 'Linguagem' });
  assert.equal(sent.dmSent, true);
  assert.equal(open.state.dms.length, 1);
  assert.match(open.state.dms[0].embeds[0].data.description, /Linguagem/);

  const closed = makeMember(null, { dm: false });
  const blocked = await moderation.warn({ guild, moderator, target: target(closed), reason: 'Spam' });
  assert.equal(blocked.dmSent, false);
  assert.equal(punishments.findById(blocked.record.id).type, 'warn');

  const creator = makeMember(ROLES.CREATOR);
  await assert.rejects(moderation.warn({ guild, moderator: makeMember(ROLES.ADMINISTRATOR), target: target(creator), reason: 'r' }), UserError);
  assert.equal(punishments.countByUser(guild.id, creator.id), 0);
});

const makeChannel = ({ recent, old, authors, pinned = [] }) => {
  const store = new Map();
  const now = Date.now();
  let id = 1_000_000n;
  const add = (age, index) => {
    const messageId = String(id++);
    store.set(messageId, {
      id: messageId,
      author: { id: authors[index % authors.length] },
      createdTimestamp: now - age,
      pinned: pinned.includes(store.size),
      deletable: true,
      delete: async () => store.delete(messageId),
    });
  };
  for (let index = 0; index < old; index++) add(20 * DAY + (old - index) * 1000, index);
  for (let index = 0; index < recent; index++) add((recent - index) * 1000, index);

  const bulkDeleted = [];
  return {
    id: 'canal',
    store,
    bulkDeleted,
    messages: {
      fetch: async ({ limit, before }) => {
        const list = [...store.values()]
          .filter((message) => !before || BigInt(message.id) < BigInt(before))
          .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
          .slice(0, limit);
        return new Collection(list.map((message) => [message.id, message]));
      },
    },
    bulkDelete: async (messages) => {
      assert.ok(messages.length >= 1 && messages.length <= 100);
      for (const message of messages) {
        assert.ok(now - message.createdTimestamp < 14 * DAY, 'bulk delete só pode receber mensagens recentes');
        store.delete(message.id);
      }
      bulkDeleted.push(messages.length);
      return new Collection(messages.map((message) => [message.id, message]));
    },
  };
};

test('clear geral, com mensagens antigas e respeitando fixadas', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.MODERATOR);

  const channel = makeChannel({ recent: 150, old: 100, authors: ['a', 'b'] });
  const small = await moderation.clear({ guild, moderator, channel, amount: 50 });
  assert.deepEqual(small.metadata, { requested: 50, deleted: 50 });
  assert.equal(small.channel_id, 'canal');
  assert.equal(channel.store.size, 200);

  const big = await moderation.clear({ guild, moderator, channel, amount: 5000 });
  assert.deepEqual(big.metadata, { requested: 5000, deleted: 200 });
  assert.equal(channel.store.size, 0);

  const withPinned = makeChannel({ recent: 10, old: 0, authors: ['a'], pinned: [9] });
  const result = await moderation.clear({ guild, moderator, channel: withPinned, amount: 10 });
  assert.equal(result.metadata.deleted, 9);
  assert.equal(withPinned.store.size, 1);

  await assert.rejects(moderation.clear({ guild, moderator, channel, amount: 5001 }), /entre 1 e 5000/);
  await assert.rejects(moderation.clear({ guild, moderator, channel: {}, amount: 1 }), /não suporta/);
});

test('clear direcionado apaga apenas mensagens do usuário', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.MODERATOR);
  const victim = makeMember();
  const channel = makeChannel({ recent: 300, old: 60, authors: [victim.id, 'outro', 'outro'] });

  const record = await moderation.clear({ guild, moderator, channel, amount: 50, target: target(victim) });
  assert.equal(record.user_id, victim.id);
  assert.deepEqual(record.metadata, { requested: 50, deleted: 50 });
  assert.equal([...channel.store.values()].filter((message) => message.author.id === 'outro').length, 240);

  const all = await moderation.clear({ guild, moderator, channel, amount: 5000, target: target(victim) });
  assert.equal(all.metadata.deleted, 70);
  assert.equal(channel.store.size, 240);

  await assert.rejects(moderation.clear({ guild, moderator, channel, amount: 5, target: target(makeMember(ROLES.CREATOR)) }), /Creator/);
});

test('modlog lista todo o histórico com paginação', async () => {
  const guild = makeGuild();
  const admin = makeMember(ROLES.ADMINISTRATOR);
  const victim = makeMember();

  await moderation.warn({ guild, moderator: admin, target: target(victim), reason: 'w' });
  await moderation.mute({ guild, moderator: admin, target: target(victim), duration: '1h', reason: 'm' });
  await moderation.unmute({ guild, moderator: admin, target: target(victim), reason: 'u' });
  await moderation.clear({ guild, moderator: admin, channel: makeChannel({ recent: 3, old: 0, authors: [victim.id] }), amount: 3, target: target(victim) });
  await moderation.kick({ guild, moderator: admin, target: target(victim), reason: 'k' });
  await moderation.ban({ guild, moderator: admin, target: { user: victim.user, member: null }, duration: '1d', reason: 'b' });
  await moderation.unban({ guild, moderator: admin, target: { user: victim.user, member: null }, reason: 'ub' });

  database.close();
  database.open(file);

  const first = moderation.history(guild.id, victim.id, 0, 5);
  assert.equal(first.total, 7);
  assert.equal(first.pages, 2);
  assert.deepEqual(first.records.map((record) => record.type), ['unban', 'ban', 'kick', 'clear', 'unmute']);
  assert.deepEqual(moderation.history(guild.id, victim.id, 1, 5).records.map((record) => record.type), ['mute', 'warn']);
  assert.equal(moderation.history(guild.id, victim.id, 99, 5).page, 1);

  const { render } = require('../src/commands/modlog');
  const page = render(guild.id, victim.id, 0);
  assert.equal(page.embeds[0].data.fields.length, 5);
  assert.equal(page.components.length, 1);
  assert.ok(JSON.stringify(page.embeds[0].toJSON()).length < 6000);
});

test('logs: on, off e reativação', async () => {
  const guild = makeGuild();
  const moderator = makeMember(ROLES.ADMINISTRATOR);
  const sent = [];
  const channel = { id: 'logs', send: async (payload) => sent.push(payload) };

  await logging.enable(guild, channel, moderator);
  assert.equal(sent.length, 1);
  assert.equal(guildSettings.get(guild.id).logs_enabled, 1);

  await moderation.warn({ guild, moderator, target: target(makeMember()), reason: 'r' });
  assert.equal(guild.logs.length, 1);

  logging.disable(guild);
  assert.deepEqual(guildSettings.get(guild.id), { guild_id: guild.id, log_channel_id: 'logs', logs_enabled: 0 });
  assert.throws(() => logging.disable(guild), /já estão desativadas/);

  const victim = makeMember();
  await moderation.warn({ guild, moderator, target: target(victim), reason: 'r' });
  assert.equal(guild.logs.length, 1);
  assert.equal(punishments.countByUser(guild.id, victim.id), 1, 'modlog continua com logs desativadas');

  const broken = { id: 'x', send: async () => Promise.reject(apiError(50013, 403)) };
  await assert.rejects(logging.enable(guild, broken, moderator), UserError);
  assert.equal(guildSettings.get(guild.id).logs_enabled, 0);
});
