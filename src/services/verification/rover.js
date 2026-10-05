const BASE_URL = 'https://registry.rover.link/api';
const TIMEOUT = 10_000;
const DEFAULT_RETRY = 60_000;
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

class RoverError extends Error {
  constructor(kind, message, retryAfter = null) {
    super(message);
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

const retryAfter = (headers) => {
  const seconds = Number(headers.get('retry-after') ?? headers.get('x-ratelimit-reset-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : DEFAULT_RETRY;
};

const lookup = async ({ apiKey, fetch }, guildId, discordId) => {
  let response;
  try {
    response = await fetch(`${BASE_URL}/guilds/${guildId}/discord-to-roblox/${discordId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (error) {
    throw new RoverError('unavailable', `RoVer could not be reached: ${error.message}`);
  }

  const body = await response.json().catch(() => null);
  const detail = `RoVer responded with ${response.status}${body?.errorCode ? ` (${body.errorCode})` : ''}`;
  if (response.ok) {
    const id = String(body?.robloxId ?? '');
    if (!/^\d+$/.test(id) || !USERNAME.test(body?.cachedUsername ?? '')) throw new RoverError('invalid_response', 'RoVer returned an invalid Roblox account');
    return { id, username: body.cachedUsername };
  }
  if (response.status === 404 || response.status === 403) throw new RoverError('not_linked', detail);
  if (response.status === 429) throw new RoverError('rate_limited', detail, retryAfter(response.headers));
  if (response.status === 401) throw new RoverError('unauthorized', detail);
  throw new RoverError('unavailable', detail);
};

module.exports = { BASE_URL, RoverError, lookup };
