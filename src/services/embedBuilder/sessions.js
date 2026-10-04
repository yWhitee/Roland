const { EmbedBuilder, embedLength } = require('discord.js');
const { UserError } = require('../../utils/errors');

const TTL = 30 * 60_000;
const MAX_FIELDS = 25;
const sessions = new Map();

const URL_KEYS = {
  url: 'A URL do título',
  authorIcon: 'O ícone do autor',
  authorUrl: 'A URL do autor',
  thumbnail: 'A thumbnail',
  image: 'A imagem principal',
  footerIcon: 'O ícone do rodapé',
};

const emptyState = () => ({
  content: '',
  title: '',
  url: '',
  description: '',
  color: '',
  authorName: '',
  authorIcon: '',
  authorUrl: '',
  thumbnail: '',
  image: '',
  footer: '',
  footerIcon: '',
  timestamp: false,
  fields: [],
});

const touch = (session) => {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => sessions.delete(session.id), TTL);
  session.timer.unref();
};

const create = (id, userId) => {
  const session = { id, userId, state: emptyState() };
  sessions.set(id, session);
  touch(session);
  return session;
};

const get = (id, userId) => {
  const session = sessions.get(id);
  if (!session) throw new UserError('Esta sessão do Embed Builder expirou. Use /embed novamente.');
  if (session.userId !== userId) throw new UserError('Apenas quem iniciou este Embed Builder pode usá-lo.');
  touch(session);
  return session;
};

const remove = (session) => {
  clearTimeout(session.timer);
  sessions.delete(session.id);
};

const reset = (session) => {
  session.state = emptyState();
};

const isUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const toEmbed = (state, timestamp = Date.now()) => {
  const embed = new EmbedBuilder();
  if (state.title) embed.setTitle(state.title);
  if (state.url) embed.setURL(state.url);
  if (state.description) embed.setDescription(state.description);
  if (state.color) embed.setColor(parseInt(state.color.replace('#', ''), 16));
  if (state.authorName) embed.setAuthor({ name: state.authorName, iconURL: state.authorIcon || undefined, url: state.authorUrl || undefined });
  if (state.thumbnail) embed.setThumbnail(state.thumbnail);
  if (state.image) embed.setImage(state.image);
  if (state.footer) embed.setFooter({ text: state.footer, iconURL: state.footerIcon || undefined });
  if (state.timestamp) embed.setTimestamp(timestamp);
  if (state.fields.length) embed.addFields(state.fields);
  return embed;
};

const isEmpty = (state) =>
  !(state.title || state.description || state.authorName || state.footer || state.thumbnail || state.image || state.fields.length);

const validate = (state) => {
  for (const [key, label] of Object.entries(URL_KEYS)) {
    if (state[key] && !isUrl(state[key])) throw new UserError(`${label} deve ser uma URL válida começando com http:// ou https://.`);
  }
  if (state.color && !/^#?[0-9a-f]{6}$/i.test(state.color)) throw new UserError('Cor inválida. Use o formato hexadecimal, ex: #5865F2.');
  if (state.url && !state.title) throw new UserError('Defina um título para usar a URL do título.');
  if ((state.authorIcon || state.authorUrl) && !state.authorName) throw new UserError('Defina o nome do autor para usar o ícone ou a URL do autor.');
  if (state.footerIcon && !state.footer) throw new UserError('Defina o texto do rodapé para usar o ícone do rodapé.');
  if (state.fields.length > MAX_FIELDS) throw new UserError(`O embed pode ter no máximo ${MAX_FIELDS} campos.`);
  if (embedLength(toEmbed(state).data) > 6000) throw new UserError('O embed ultrapassa o limite de 6000 caracteres do Discord.');
};

const update = (session, changes) => {
  const state = { ...session.state, ...changes };
  validate(state);
  session.state = state;
};

const assertNotEmpty = (state) => {
  if (isEmpty(state)) throw new UserError('O embed está vazio. Configure pelo menos um título, descrição, campo, autor, rodapé ou imagem.');
};

module.exports = { MAX_FIELDS, create, get, remove, reset, update, toEmbed, isEmpty, assertNotEmpty };
