const { EmbedBuilder, embedLength } = require('discord.js');
const { UserError } = require('../../utils/errors');

const TTL = 30 * 60_000;
const MAX_FIELDS = 25;
const sessions = new Map();

const MAX_URL = 2000;
const TEXT_LIMITS = {
  content: ['The message content', 2000],
  title: ['The title', 256],
  description: ['The description', 4000],
  authorName: ['The author name', 256],
  footer: ['The footer text', 2048],
};

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

const problems = (state) => {
  const found = [];
  for (const [key, label] of Object.entries(URL_KEYS)) {
    if (state[key] && (state[key].length > MAX_URL || !isUrl(state[key]))) found.push(`${label} must be a valid URL starting with http:// or https:// (at most ${MAX_URL} characters).`);
  }
  if (state.color && !/^#?[0-9a-f]{6}$/i.test(state.color)) found.push('Invalid color. Use a hex code, e.g. #5865F2.');
  if (state.url && !state.title) found.push('Set a title before adding a title URL.');
  if ((state.authorIcon || state.authorUrl) && !state.authorName) found.push('Set an author name before adding an author icon or URL.');
  if (state.footerIcon && !state.footer) found.push('Set footer text before adding a footer icon.');
  if (state.fields.length > MAX_FIELDS) found.push(`An embed can have at most ${MAX_FIELDS} fields.`);
  for (const [key, [label, max]] of Object.entries(TEXT_LIMITS)) {
    if (state[key].length > max) found.push(`${label} must be at most ${max} characters (it has ${state[key].length}).`);
  }
  state.fields.forEach((field, index) => {
    if (!field.name || !field.value) found.push(`Field ${index + 1} needs both a name and a value.`);
    if (field.name.length > 256) found.push(`The name of field ${index + 1} must be at most 256 characters (it has ${field.name.length}).`);
    if (field.value.length > 1024) found.push(`The value of field ${index + 1} must be at most 1024 characters (it has ${field.value.length}).`);
  });
  if (!found.length && embedLength(toEmbed(state).data) > 6000) found.push('The embed exceeds the Discord limit of 6000 characters.');
  return found;
};

const validate = (state) => {
  const [problem] = problems(state);
  if (problem) throw new UserError(problem);
};

const update = (session, changes) => {
  const state = { ...session.state, ...changes };
  validate(state);
  session.state = state;
};

const assertNotEmpty = (state) => {
  if (isEmpty(state)) throw new UserError('The embed is empty. Add at least a title, description, field, author, footer or image.');
};

module.exports = { MAX_FIELDS, MAX_URL, emptyState, create, get, remove, reset, update, problems, toEmbed, isEmpty, assertNotEmpty };
