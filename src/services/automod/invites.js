const { RESTJSONErrorCodes } = require('discord.js');

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
const CONFUSABLES = { а: 'a', с: 'c', е: 'e', о: 'o', р: 'p', х: 'x', і: 'i', ԁ: 'd', ѕ: 's', ɡ: 'g', ց: 'g', ı: 'i', ο: 'o', ν: 'v' };
const CODE = '([a-z0-9-]{2,32})';

const DISCORD_LINK = new RegExp(`discord(?:app)?\\s*\\.(?:gg|com/invite|com/servers/[a-z0-9-]+)/${CODE}`, 'gi');
const SERVICE_LINK = /(?:dsc\.gg|invite\.gg|discord\.me|discord\.io|discord\.link)\/([a-z0-9-]{2,32})/gi;
const DOT_GG = new RegExp(`(?:^|[^a-z0-9])\\.gg/${CODE}`, 'gi');
const BARE_GG = new RegExp(`(?:^|[^a-z0-9.])gg/${CODE}`, 'gi');

const CACHE_TTL = 10 * 60_000;
const cache = new Map();

const normalize = (text) =>
  String(text ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[асеорхіԁѕɡցıον]/gi, (character) => CONFUSABLES[character.toLowerCase()] ?? character)
    .replace(/<(https?:\/\/[^>\s]+)>/gi, '$1')
    .replace(/https?:\/\//gi, ' ')
    .replace(/[*_~`|]/g, '')
    .replace(/\s*[([{]\s*(?:\.|dot)\s*[)\]}]\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s*[([{]\s*(?:\/|slash)\s*[)\]}]\s*/gi, '/')
    .replace(/\s+slash\s+/gi, '/')
    .replace(/[\\⁄∕／]/g, '/')
    .replace(/[,。．｡]/g, '.')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\.\s+/g, '.')
    .replace(/([./])[\s./]*\1+/g, '$1')
    .replace(/\.\/|\/\./g, '/');

const collect = (pattern, text, strength) => [...text.matchAll(pattern)].map((match) => ({ code: match[1], strength }));

const findInvites = (content) => {
  const light = normalize(content);
  const compact = light.replace(/[^a-z0-9./]/gi, '');
  const links = collect(DISCORD_LINK, light, 'strong');
  const found = [
    ...links,
    ...collect(SERVICE_LINK, light, 'service'),
    ...collect(DOT_GG, light, 'strong'),
    ...collect(BARE_GG, light, 'weak'),
    ...(links.length ? [] : collect(DISCORD_LINK, compact, 'weak')),
  ];

  const unique = new Map();
  for (const invite of found) {
    const key = `${invite.strength === 'service' ? 'service:' : ''}${invite.code}`;
    const rank = { service: 3, strong: 2, weak: 1 };
    if (!unique.has(key) || rank[invite.strength] > rank[unique.get(key).strength]) unique.set(key, invite);
  }
  return [...unique.values()];
};

const resolve = async (client, code, now = Date.now()) => {
  const cached = cache.get(code);
  if (cached && cached.expires > now) return cached.result;

  let result;
  try {
    const invite = await client.fetchInvite(code);
    result = { status: 'resolved', guildId: invite.guild?.id ?? null };
  } catch (error) {
    result = { status: error.code === RESTJSONErrorCodes.UnknownInvite ? 'unknown' : 'error' };
  }
  if (result.status !== 'error') cache.set(code, { result, expires: now + CACHE_TTL });
  return result;
};

const blockedInvites = async (guild, content) => {
  const blocked = [];
  for (const invite of findInvites(content)) {
    if (invite.strength === 'service') {
      blocked.push(invite);
      continue;
    }
    const target = await resolve(guild.client, invite.code);
    if (target.status === 'resolved' && target.guildId === guild.id) continue;
    if (target.status === 'resolved' || invite.strength === 'strong') blocked.push({ ...invite, guildId: target.guildId ?? null });
  }
  return blocked;
};

const clearCache = () => cache.clear();

module.exports = { normalize, findInvites, blockedInvites, clearCache };
