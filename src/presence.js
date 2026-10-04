const { ActivityType } = require('discord.js');

const ACTIVITY = {
  type: ActivityType.Playing,
  name: 'Generic Civilization Game 🚩',
  state: '> PRE-ALPHA',
};

const options = () => ({ status: 'online', activities: [{ ...ACTIVITY }] });

const report = (client) => {
  const sent = client.options.ws?.presence?.activities?.[0];
  if (!sent) {
    console.warn('Rich Presence was not configured.');
    return null;
  }
  console.log(`Rich Presence configured successfully: Playing "${sent.name}" (${sent.state}).`);
  return sent;
};

module.exports = { ACTIVITY, options, report };
