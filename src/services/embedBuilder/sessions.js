const { EmbedBuilder, embedLength } = require('discord.js');
const { UserError } = require('../../utils/errors');

const TTL = 30 * 60_000;
const MAX_FIELDS = 25;
const sessions = new Map();

const URL_KEYS = {
  url: 'The title URL',
  authorIcon: 'The author icon',
  authorUrl: 'The author URL',
  thumbnail: 'The thumbnail',
  image: 'The main image',
  footerIcon: 'The footer icon',
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

const create = (id, userId, { initial, ...options } = {}) => {
  const session = { ...options, id, userId, state: { ...emptyState(), ...initial } };
  sessions.set(id, session);
  touch(session);
  return session;
};

const get = (id, userId) => {
  const session = sessions.get(id);
  if (!session) throw new UserError('This builder session has expired. Run the command again.');
  if (session.userId !== userId) throw new UserError('Only the person who started this builder can use it.');
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
    if (state[key] && !isUrl(state[key])) throw new UserError(`${label} must be a valid URL starting with http:// or https://.`);
  }
  if (state.color && !/^#?[0-9a-f]{6}$/i.test(state.color)) throw new UserError('Invalid color. Use a hex code, e.g. #5865F2.');
  if (state.url && !state.title) throw new UserError('Set a title before adding a title URL.');
  if ((state.authorIcon || state.authorUrl) && !state.authorName) throw new UserError('Set an author name before adding an author icon or URL.');
  if (state.footerIcon && !state.footer) throw new UserError('Set footer text before adding a footer icon.');
  if (state.fields.length > MAX_FIELDS) throw new UserError(`An embed can have at most ${MAX_FIELDS} fields.`);
  if (embedLength(toEmbed(state).data) > 6000) throw new UserError('The embed exceeds the Discord limit of 6000 characters.');
};

const update = (session, changes) => {
  const state = { ...session.state, ...changes };
  validate(state);
  session.state = state;
};

const assertNotEmpty = (state) => {
  if (isEmpty(state)) throw new UserError('The embed is empty. Add at least a title, description, field, author, footer or image.');
};

module.exports = { MAX_FIELDS, create, get, remove, reset, update, toEmbed, isEmpty, assertNotEmpty };
