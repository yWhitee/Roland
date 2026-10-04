const { ActivityType, StatusDisplayType } = require('discord.js');

const GAME_URL = 'https://www.roblox.com/games/138399961471218';
const ASSETS = { large: 'slime_odyssey_large', small: 'roland_small' };

let activity = null;

const buildActivity = ({ applicationId, startedAt = Date.now() }) => ({
  type: ActivityType.Playing,
  name: 'Slime Odyssey: Anime Realms',
  details: 'Exploring the world',
  details_url: GAME_URL,
  state: 'Development build',
  state_url: GAME_URL,
  url: GAME_URL,
  application_id: applicationId,
  status_display_type: StatusDisplayType.Name,
  platform: 'desktop',
  instance: false,
  timestamps: { start: startedAt },
  party: { id: 'roland-development', size: [1, 1] },
  assets: {
    large_image: ASSETS.large,
    large_text: 'Slime Odyssey: Anime Realms',
    large_url: GAME_URL,
    small_image: ASSETS.small,
    small_text: 'Roland',
    small_url: GAME_URL,
  },
  buttons: [{ label: 'Play on Roblox', url: GAME_URL }],
});

const fieldPaths = (value, prefix = '') =>
  Object.entries(value ?? {}).flatMap(([key, field]) => {
    if (field === undefined || field === null) return [];
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof field === 'object' && !Array.isArray(field) ? fieldPaths(field, path) : [path];
  });

const configure = ({ applicationId, startedAt } = {}) => {
  activity = buildActivity({ applicationId, startedAt });
  return { status: 'online', activities: [activity] };
};

const diagnose = (attempted, sent) => {
  const sentFields = fieldPaths(sent);
  const attemptedFields = fieldPaths(attempted);
  return { attempted: attemptedFields, sent: sentFields, omitted: attemptedFields.filter((path) => !sentFields.includes(path)) };
};

const report = (client) => {
  const sent = client.options.ws?.presence?.activities?.[0];
  if (!activity || !sent) {
    console.warn('Rich Presence was not configured.');
    return null;
  }

  const result = diagnose(activity, sent);
  console.log(`Rich Presence configured successfully: Playing "${sent.name}" (sent: ${result.sent.join(', ')}).`);
  if (result.omitted.length) {
    console.log(`Rich Presence fields not sent: ${result.omitted.join(', ')}. Bot presence updates only carry type, name, state and url.`);
  }
  if (sent.url && sent.type !== ActivityType.Streaming) console.log('Rich Presence note: url is only used by Discord for Streaming activities.');
  return result;
};

module.exports = { GAME_URL, ASSETS, buildActivity, fieldPaths, configure, diagnose, report };
