const detectors = require('./detectors');

const FLAG_DURATION = 4 * 60 * 60_000;
const MAX_FLAGS = 3;

const RAID = {
  joins: 8,
  window: 20_000,
  duration: 30 * 60_000,
  alerts: 10,
  lockdownUsers: 3,
  lockdownWindow: 30_000,
};

const FUNCTIONS = [
  {
    id: 'antiflood',
    name: 'Anti-Flood',
    description: 'Detects bursts of messages sent much faster than normal conversation.',
    reason: 'Flooding',
    config: { messages: 8, window: 2_000 },
    detection: '8 messages within 2 seconds',
    raidSignal: true,
    actions: [{ delete: true }, { delete: true, mute: '30m' }, { delete: true, mute: '6h' }],
  },
  {
    id: 'antispam',
    name: 'Anti-Spam',
    description: 'Detects users sending messages too quickly.',
    reason: 'Spam',
    config: { messages: 5, window: 5_000 },
    detection: '5 messages within 5 seconds',
    raidSignal: true,
    actions: [{ delete: true }, { delete: true, warn: true }, { delete: true, mute: '3h' }],
  },
  {
    id: 'antimassping',
    name: 'Anti-Mass Mention',
    description: 'Detects messages that mention many individual users. Role, @everyone and @here mentions are not counted.',
    reason: 'Mass mentions',
    config: { users: 5 },
    detection: '5 or more mentioned users in one message',
    actions: [{ delete: true, warn: true }, { delete: true, mute: '3h' }, { delete: true, mute: '24h' }],
  },
  {
    id: 'antiinvite',
    requires: 'messageContent',
    name: 'Anti-Invite',
    description: 'Detects Discord server invitations and common invite obfuscation. Invites to this server are allowed.',
    reason: 'Discord invite',
    config: {},
    detection: 'Invite links such as discord.gg/, discord.com/invite/, .gg/ and gg/ (including obfuscated forms)',
    note: 'No separate 3/3 action is defined, so 3/3 repeats the 2/3 action.',
    actions: [{ delete: true, warn: true }, { delete: true, mute: '24h' }, { delete: true, mute: '24h' }],
  },
  {
    id: 'antiduplicate',
    requires: 'messageContent',
    name: 'Anti-Duplicate',
    description: 'Detects the same message being repeated in a short period, in any channel.',
    reason: 'Duplicate messages',
    config: { messages: 3, window: 30_000, minLength: 5 },
    detection: '3 identical messages within 30 seconds (messages under 5 characters are ignored)',
    note: 'No separate 3/3 action is defined, so 3/3 repeats the 2/3 action.',
    actions: [{ delete: true, warn: true }, { delete: true, mute: '6h' }, { delete: true, mute: '6h' }],
  },
  {
    id: 'antiemojispam',
    requires: 'messageContent',
    name: 'Anti-Emoji Spam',
    description: 'Detects messages with an excessive number of Unicode or custom emojis.',
    reason: 'Emoji spam',
    config: { emojis: 10 },
    detection: '10 or more emojis in one message',
    actions: [{ delete: true }, { delete: true, warn: true }, { delete: true, mute: '1h' }],
  },
  {
    id: 'antiraid',
    requires: 'members',
    name: 'Anti-Raid',
    description: 'Detects mass joins and puts the server on a raid alert. During the alert, channels flooded by several users are locked.',
    reason: 'Raid',
    config: RAID,
    detection: '8 joins within 20 seconds',
    serverWide: true,
    response: [
      'Raid alert for 30 minutes and 10 staff alerts in the log channel (when logs are enabled).',
      'During the alert, a channel where 3 or more users trigger Anti-Spam/Anti-Flood within 30 seconds is locked. Staff keep access.',
      'When the alert ends, locked channels are restored without overwriting manual permission changes.',
    ],
  },
];

const DETECTORS = {
  antiflood: (config) => detectors.rate('antiflood', config),
  antispam: (config) => detectors.rate('antispam', config),
  antimassping: (config) => detectors.massMentions(config),
  antiinvite: () => detectors.invites(),
  antiduplicate: (config) => detectors.duplicates(config),
  antiemojispam: (config) => detectors.emojis(config),
};

for (const definition of FUNCTIONS) {
  if (DETECTORS[definition.id]) definition.detect = DETECTORS[definition.id](definition.config);
}

const byId = new Map(FUNCTIONS.map((definition) => [definition.id, definition]));

const MESSAGE_FUNCTIONS = FUNCTIONS.filter((definition) => definition.detect);

const choices = () => FUNCTIONS.map((definition) => ({ name: `${definition.id} (${definition.name})`, value: definition.id }));

module.exports = { FLAG_DURATION, MAX_FLAGS, RAID, FUNCTIONS, MESSAGE_FUNCTIONS, byId, choices };
