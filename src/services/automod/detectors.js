const { findInvites, blockedInvites } = require('./invites');

const HISTORY_WINDOW = 60_000;
const INVISIBLE = /[​-‏⁠-⁯﻿]/g;
const CUSTOM_EMOJI = /<a?:[a-z0-9_]{2,32}:\d{17,20}>/gi;
const UNICODE_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

const histories = new Map();

const normalizeText = (content) =>
  String(content ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[!?.~,]+$/, '')
    .trim();

const record = (message, now) => {
  const key = `${message.guildId}:${message.author.id}`;
  const entries = (histories.get(key) ?? []).filter((entry) => entry.at > now - HISTORY_WINDOW);
  entries.push({ id: message.id, channelId: message.channelId, at: now, text: normalizeText(message.content), consumed: new Set() });
  histories.set(key, entries);
  return entries;
};

const consume = (entries, functionId) => entries.forEach((entry) => entry.consumed.add(functionId));

const sweepHistories = (now = Date.now()) => {
  for (const [key, entries] of histories) {
    if (!entries.some((entry) => entry.at > now - HISTORY_WINDOW)) histories.delete(key);
  }
};

const rate = (functionId, { messages, window }) => ({ entries, now }) => {
  const recent = entries.filter((entry) => entry.at > now - window && !entry.consumed.has(functionId));
  return recent.length >= messages ? { entries: recent, detail: `${recent.length} messages within ${window / 1000} seconds` } : null;
};

const duplicates = ({ messages, window, minLength }) => ({ entries, now }) => {
  const current = entries.at(-1);
  if (current.text.length < minLength) return null;
  const same = entries.filter((entry) => entry.at > now - window && !entry.consumed.has('antiduplicate') && entry.text === current.text);
  return same.length >= messages ? { entries: same, detail: `${same.length} identical messages within ${window / 1000} seconds` } : null;
};

const mentionedUsers = (message) => {
  const users = new Set(message.mentions.users.keys());
  users.delete(message.author.id);
  const replied = message.mentions.repliedUser?.id;
  if (replied && !new RegExp(`<@!?${replied}>`).test(message.content ?? '')) users.delete(replied);
  return users.size;
};

const massMentions = ({ users }) => ({ message, entries }) => {
  const count = mentionedUsers(message);
  return count >= users ? { entries: [entries.at(-1)], detail: `${count} users mentioned` } : null;
};

const countEmojis = (content) => {
  const text = String(content ?? '');
  const custom = text.match(CUSTOM_EMOJI)?.length ?? 0;
  let unicode = 0;
  for (const { segment } of segmenter.segment(text.replace(CUSTOM_EMOJI, ' '))) {
    if (UNICODE_EMOJI.test(segment)) unicode++;
  }
  return custom + unicode;
};

const emojis = ({ emojis: limit }) => ({ message, entries }) => {
  const count = countEmojis(message.content);
  return count >= limit ? { entries: [entries.at(-1)], detail: `${count} emojis in one message` } : null;
};

const invites = () => async ({ message, entries }) => {
  if (!findInvites(message.content).length) return null;
  const blocked = await blockedInvites(message.guild, message.content);
  return blocked.length ? { entries: [entries.at(-1)], detail: `Invite: ${blocked.map((invite) => invite.code).join(', ')}` } : null;
};

module.exports = { normalizeText, record, consume, sweepHistories, rate, duplicates, mentionedUsers, massMentions, countEmojis, emojis, invites };
