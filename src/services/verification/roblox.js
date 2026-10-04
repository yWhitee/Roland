const crypto = require('node:crypto');

const BASE_URL = 'https://apis.roblox.com/oauth';
const ENDPOINTS = {
  authorize: `${BASE_URL}/v1/authorize`,
  token: `${BASE_URL}/v1/token`,
  userinfo: `${BASE_URL}/v1/userinfo`,
  revoke: `${BASE_URL}/v1/token/revoke`,
};
const SCOPES = 'openid profile';
const TIMEOUT = 10_000;
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

class RobloxError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const codeChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

const authorizationUrl = (settings, { state, verifier }) => {
  const url = new URL(ENDPOINTS.authorize);
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    scope: SCOPES,
    response_type: 'code',
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return url.toString();
};

const request = async (settings, url, options) => {
  let response;
  try {
    response = await settings.fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (error) {
    throw new RobloxError('unavailable', `Request to ${url} failed: ${error.message}`);
  }

  const body = await response.json().catch(() => null);
  if (response.ok && body) return body;
  if (response.status === 429 || response.status >= 500) throw new RobloxError('unavailable', `${url} responded with ${response.status}`);
  if (body?.error === 'invalid_grant') throw new RobloxError('invalid_grant', `${url} rejected the authorization code`);
  throw new RobloxError('invalid_response', `${url} responded with ${response.status}${body?.error ? ` (${body.error})` : ''}`);
};

const credentials = (settings) => ({ client_id: settings.clientId, client_secret: settings.clientSecret });

const form = (fields) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
});

const exchangeCode = async (settings, code, verifier) => {
  const tokens = await request(
    settings,
    ENDPOINTS.token,
    form({ grant_type: 'authorization_code', code, code_verifier: verifier, ...credentials(settings) }),
  );
  if (typeof tokens.access_token !== 'string') throw new RobloxError('invalid_response', 'The token response did not include an access token');
  return tokens;
};

const fetchUser = async (settings, accessToken) => {
  const user = await request(settings, ENDPOINTS.userinfo, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!/^\d+$/.test(String(user.sub)) || !USERNAME.test(user.preferred_username ?? '')) {
    throw new RobloxError('invalid_response', 'The user info response did not include a valid user ID and username');
  }
  return { id: String(user.sub), username: user.preferred_username, displayName: user.nickname ?? user.name ?? null };
};

const revoke = async (settings, token) => {
  if (!token) return;
  await request(settings, ENDPOINTS.revoke, form({ token, ...credentials(settings) })).catch(() => {});
};

module.exports = { ENDPOINTS, RobloxError, codeChallenge, authorizationUrl, exchangeCode, fetchUser, revoke };
