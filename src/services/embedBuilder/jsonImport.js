const sessions = require('./sessions');
const { UserError } = require('../../utils/errors');

const MAX_BYTES = 64 * 1024;
const DOWNLOAD_TIMEOUT = 10_000;
const MAX_REPORTED = 10;
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

const KEYS = {
  root: ['content', 'embed'],
  embed: ['title', 'description', 'color', 'url', 'timestamp', 'author', 'thumbnail', 'image', 'footer', 'fields'],
  author: ['name', 'url', 'iconURL'],
  footer: ['text', 'iconURL'],
  field: ['name', 'value', 'inline'],
};

const UNSUPPORTED = new Map([
  ['buttons', 'Buttons cannot be imported: the embed editor does not create buttons. /createverify and /ticketcreate add their own button automatically.'],
  ['components', 'Components cannot be imported: the embed editor does not create buttons or menus. /createverify and /ticketcreate add their own button automatically.'],
  ['embeds', 'Only one embed is supported. Put it in "embed" as an object, not in an "embeds" list.'],
]);

let settings = { fetch: (...args) => globalThis.fetch(...args) };

const configure = ({ fetch } = {}) => {
  settings = { fetch: fetch ?? ((...args) => globalThis.fetch(...args)) };
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const shown = (value) => String(value).replace(/[`\n\r]/g, '').slice(0, 100);

const reader = (errors) => {
  const object = (value, path, keys) => {
    if (value === undefined || value === null) return {};
    if (!isObject(value)) {
      errors.push(`${path} must be an object.`);
      return {};
    }
    for (const key of Object.keys(value)) {
      if (keys.includes(key)) continue;
      const root = path === 'The file';
      if (root && UNSUPPORTED.has(key)) errors.push(UNSUPPORTED.get(key));
      else errors.push(`Unknown property "${root ? '' : `${path}.`}${shown(key)}". Supported: ${keys.join(', ')}.`);
    }
    return value;
  };

  const text = (value, path) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
      errors.push(`${path} must be text.`);
      return '';
    }
    return value.trim();
  };

  const flag = (value, path) => {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'boolean') {
      errors.push(`${path} must be true or false.`);
      return false;
    }
    return value;
  };

  const color = (value, path) => {
    if (value === undefined || value === null || value === '') return '';
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffff) return `#${value.toString(16).padStart(6, '0')}`;
    if (typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value.trim())) return `#${value.trim().replace('#', '')}`;
    errors.push(`${path} must be a hex color like "#5865F2" or a number from 0 to 16777215.`);
    return '';
  };

  const fields = (value, path) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      errors.push(`${path} must be a list.`);
      return [];
    }
    if (value.length > sessions.MAX_FIELDS) {
      errors.push(`${path} has ${value.length} fields; an embed can have at most ${sessions.MAX_FIELDS}.`);
      return [];
    }
    return value.map((entry, index) => {
      const where = `${path}[${index}]`;
      const field = object(entry, where, KEYS.field);
      if (!isObject(entry)) return { name: '', value: '', inline: false };
      return { name: text(field.name, `${where}.name`), value: text(field.value, `${where}.value`), inline: flag(field.inline, `${where}.inline`) };
    });
  };

  return { object, text, flag, color, fields };
};

const toState = (data) => {
  const errors = [];
  if (!isObject(data)) throw new UserError('The file must contain a JSON object, like { "embed": { "title": "Hello" } }.');
  const read = reader(errors);
  const root = read.object(data, 'The file', KEYS.root);
  const embed = read.object(root.embed, 'embed', KEYS.embed);
  const author = read.object(embed.author, 'embed.author', KEYS.author);
  const footer = read.object(embed.footer, 'embed.footer', KEYS.footer);

  const state = {
    ...sessions.emptyState(),
    content: read.text(root.content, 'content'),
    title: read.text(embed.title, 'embed.title'),
    url: read.text(embed.url, 'embed.url'),
    description: read.text(embed.description, 'embed.description'),
    color: read.color(embed.color, 'embed.color'),
    authorName: read.text(author.name, 'embed.author.name'),
    authorUrl: read.text(author.url, 'embed.author.url'),
    authorIcon: read.text(author.iconURL, 'embed.author.iconURL'),
    thumbnail: read.text(embed.thumbnail, 'embed.thumbnail'),
    image: read.text(embed.image, 'embed.image'),
    footer: read.text(footer.text, 'embed.footer.text'),
    footerIcon: read.text(footer.iconURL, 'embed.footer.iconURL'),
    timestamp: read.flag(embed.timestamp, 'embed.timestamp'),
    fields: read.fields(embed.fields, 'embed.fields'),
  };

  if (!errors.length) errors.push(...sessions.problems(state));
  if (!errors.length && sessions.isEmpty(state)) errors.push('The embed is empty. Add at least a title, description, field, author, footer or image in "embed".');
  if (errors.length) {
    const listed = errors.slice(0, MAX_REPORTED).map((error) => `• ${error}`);
    if (errors.length > MAX_REPORTED) listed.push(`• …and ${errors.length - MAX_REPORTED} more.`);
    throw new UserError(['The file was not imported:', ...listed].join('\n'));
  }
  return state;
};

const parse = (text) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new UserError(`The file is not valid JSON: ${error.message.slice(0, 200)}`);
  }
  return toState(data);
};

const tooLarge = () => new UserError(`The file is larger than ${MAX_BYTES / 1024} KB.`);

const receive = async (url) => {
  const response = await settings.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
  if (!response.ok) throw new UserError(`Discord did not return the file (HTTP ${response.status}). Try uploading it again.`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const download = async (url) => {
  try {
    return await receive(url);
  } catch (error) {
    if (error instanceof UserError) throw error;
    console.error(`Could not download an embed JSON file: ${error.message}`);
    throw new UserError(error.name === 'TimeoutError' ? 'Downloading the file took too long. Try again.' : 'The file could not be downloaded from Discord. Try again.');
  }
};

const decode = (bytes) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch (error) {
    throw new UserError(`The file is not UTF-8 text (${error.message}).`);
  }
};

const isDiscordFile = (value) => {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && CDN_HOSTS.has(url.hostname);
};

const read = async (files) => {
  const uploaded = files ? [...files.values()] : [];
  if (!uploaded.length) throw new UserError('No file was uploaded. Attach a .json file.');
  if (uploaded.length > 1) throw new UserError('Upload only one .json file.');
  const [file] = uploaded;
  const name = shown(file.name ?? 'file');
  if (!/\.json$/i.test(file.name ?? '')) throw new UserError(`"${name}" is not a .json file.`);
  if (!file.size) throw new UserError(`"${name}" is empty.`);
  if (file.size > MAX_BYTES) throw new UserError(`"${name}" is larger than ${MAX_BYTES / 1024} KB.`);
  if (!isDiscordFile(file.url)) throw new UserError('The file must be uploaded to Discord.');

  const text = decode(await download(file.url));
  if (!text.trim()) throw new UserError(`"${name}" is empty.`);
  return { name, state: parse(text) };
};

module.exports = { MAX_BYTES, configure, toState, parse, read };
