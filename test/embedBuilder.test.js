const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const sessions = require('../src/services/embedBuilder/sessions');
const embedBuilder = require('../src/services/embedBuilder');
const { UserError } = require('../src/utils/errors');

const OWNER = '111111111111111111';

const interaction = (sessionId, action, extra = {}) => {
  const calls = { update: [], modal: [], reply: [] };
  return {
    calls,
    customId: `embed:${sessionId}:${action}`,
    user: { id: OWNER },
    fields: {
      getTextInputValue: (id) => extra.values?.[id] ?? '',
      getStringSelectValues: () => extra.select ?? [],
    },
    values: extra.selected ?? [],
    update: async (payload) => calls.update.push(payload),
    showModal: async (modal) => calls.modal.push(modal),
    reply: async (payload) => calls.reply.push(payload),
    ...extra.props,
  };
};

const newSession = async () => {
  const start = { id: String(Date.now() + Math.random()), user: { id: OWNER }, reply: async (payload) => payload };
  await embedBuilder.start(start);
  return start.id;
};

test('validação do embed', () => {
  const session = sessions.create('validacao', OWNER);
  assert.throws(() => sessions.update(session, { image: 'nao-e-url' }), /URL válida/);
  assert.throws(() => sessions.update(session, { color: 'azul' }), /Cor inválida/);
  assert.throws(() => sessions.update(session, { authorIcon: 'https://a.com/i.png' }), /nome do autor/);
  assert.throws(() => sessions.update(session, { footerIcon: 'https://a.com/i.png' }), /texto do rodapé/);
  assert.throws(() => sessions.update(session, { url: 'https://a.com' }), /título/);
  assert.throws(() => sessions.update(session, { description: 'a'.repeat(4000), fields: [{ name: 'n', value: 'v'.repeat(1024) }, { name: 'n', value: 'v'.repeat(1024) }] }), /6000/);
  assert.throws(() => sessions.assertNotEmpty(session.state), /vazio/);

  sessions.update(session, {
    title: 'Título',
    url: 'https://example.com',
    description: 'Descrição',
    color: '#5865F2',
    authorName: 'Autor',
    authorIcon: 'https://example.com/a.png',
    authorUrl: 'https://example.com',
    thumbnail: 'https://example.com/t.png',
    image: 'https://example.com/i.png',
    footer: 'Rodapé',
    footerIcon: 'https://example.com/f.png',
    timestamp: true,
    fields: [{ name: 'Campo', value: 'Valor', inline: true }],
  });
  const json = sessions.toEmbed(session.state, 1_000).toJSON();
  assert.equal(json.color, 0x5865f2);
  assert.equal(json.author.url, 'https://example.com');
  assert.equal(json.footer.icon_url, 'https://example.com/f.png');
  assert.equal(json.timestamp, new Date(1_000).toISOString());
  assert.equal(json.fields.length, 1);
  sessions.remove(session);
});

test('fluxo do builder: seções, campos, timestamp e cancelamento', async () => {
  const id = await newSession();

  const open = interaction(id, 'section:body');
  await embedBuilder.handle(open);
  assert.equal(open.calls.modal[0].toJSON().custom_id, `embed:${id}:modal:body`);

  await embedBuilder.handle(interaction(id, 'modal:body', { values: { title: ' Olá ', description: 'Mundo', color: '#ff0000' } }));
  await embedBuilder.handle(interaction(id, 'field:new', { values: { name: 'A', value: '1' }, select: ['yes'] }));
  await embedBuilder.handle(interaction(id, 'field:new', { values: { name: 'B', value: '2' }, select: ['no'] }));
  await embedBuilder.handle(interaction(id, 'field:0', { values: { name: 'A2', value: '1b' }, select: ['no'] }));
  await embedBuilder.handle(interaction(id, 'timestamp'));

  const remove = interaction(id, 'pickremove', { selected: ['1'] });
  await embedBuilder.handle(remove);
  const embed = remove.calls.update[0].embeds[0].toJSON();
  assert.equal(embed.title, 'Olá');
  assert.equal(embed.color, 0xff0000);
  assert.deepEqual(embed.fields, [{ name: 'A2', value: '1b', inline: false }]);
  assert.ok(embed.timestamp);

  const preview = interaction(id, 'preview');
  await embedBuilder.handle(preview);
  assert.equal(preview.calls.reply[0].embeds[0].toJSON().title, 'Olá');

  await assert.rejects(embedBuilder.handle({ ...interaction(id, 'reset'), user: { id: '222222222222222222' } }), /Apenas quem iniciou/);

  const cancel = interaction(id, 'cancel');
  await embedBuilder.handle(cancel);
  assert.deepEqual(cancel.calls.update[0].components, []);
  await assert.rejects(embedBuilder.handle(interaction(id, 'preview')), /expirou/);
});

test('envio exige permissão no canal e restringe menções', async () => {
  const id = await newSession();
  await embedBuilder.handle(interaction(id, 'modal:content', { values: { content: '@everyone novidade' } }));
  await assert.rejects(embedBuilder.handle(interaction(id, 'send')), /vazio/);
  await embedBuilder.handle(interaction(id, 'modal:body', { values: { title: 'Aviso' } }));

  const sent = [];
  const channel = (granted) => ({
    isTextBased: () => true,
    toString: () => '<#canal>',
    permissionsFor: () => ({ has: (permissions) => [].concat(permissions).every((permission) => granted.includes(permission)) }),
    send: async (payload) => sent.push(payload),
  });
  const deliver = (granted) =>
    interaction(id, 'channel', { selected: ['canal'], props: { member: {}, guild: { channels: { fetch: async () => channel(granted) } } } });

  await assert.rejects(embedBuilder.handle(deliver([PermissionFlagsBits.ViewChannel])), /permissão/);
  assert.equal(sent.length, 0);

  const ok = deliver([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  await embedBuilder.handle(ok);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '@everyone novidade');
  assert.deepEqual(sent[0].allowedMentions, { parse: ['users'] });
  assert.match(ok.calls.update[0].content, /Embed enviado/);
  await assert.rejects(embedBuilder.handle(interaction(id, 'preview')), UserError);
});
