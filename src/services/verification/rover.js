const BASE_URL = 'https://registry.rover.link/api';
const TIMEOUT = 10_000;
const DEFAULT_RETRY = 10_000;
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

class RoverError extends Error {
  constructor(kind, message, retryAfter = null) {
    super(message);
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

const retryAfter = (headers) => {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : DEFAULT_RETRY;
};

const request = async ({ apiKey, fetch }, method, path, label) => {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { method, headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (error) {
    throw new RoverError('unavailable', `${label} could not be reached: ${error.message}`);
  }

  const json = /^application\/json\b/i.test(response.headers.get('content-type') ?? '');
  const body = json ? await response.json().catch(() => null) : null;
  if (response.ok && body) return { status: response.status, body };

  const code = body?.errorCode;
  const detail = `${label} responded with ${response.status}${code ? ` (${code})` : ''}`;
  if (response.status === 429 || code === 'discord_rate_limit') throw new RoverError('rate_limited', detail, retryAfter(response.headers));
  if (response.status === 401) throw new RoverError('unauthorized', detail);
  if (response.ok) throw new RoverError('invalid_response', `${label} returned an unexpected response`);
  throw new RoverError(code ?? 'unavailable', detail);
};

const lookup = async (settings, guildId, discordId) => {
  const { body } = await request(settings, 'GET', `/guilds/${guildId}/discord-to-roblox/${discordId}`, 'RoVer');
  const id = String(body.robloxId ?? '');
  if (!/^\d+$/.test(id) || !USERNAME.test(body.cachedUsername ?? '')) throw new RoverError('invalid_response', 'RoVer returned an invalid Roblox account');
  return { id, username: body.cachedUsername };
};

const requestAccess = async (settings, guildId, discordId) => {
  const { status, body } = await request(settings, 'PUT', `/guilds/${guildId}/access-requests/${discordId}`, 'RoVer access request');
  if (body.status === 'already_authorized') return 'authorized';
  if (body.status === 'pending') return status === 201 ? 'requested' : 'pending';
  throw new RoverError('invalid_response', 'RoVer access request returned an unexpected response');
};

module.exports = { BASE_URL, RoverError, lookup, requestAccess };
