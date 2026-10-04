const punishments = require('../database/punishments');
const moderation = require('./moderation');

const INTERVAL = 10_000;
let running = false;

const sweep = async (client, now = Date.now()) => {
  if (running) return;
  running = true;
  try {
    for (const ban of punishments.dueBans(now)) {
      await moderation.expireBan(client, ban).catch((error) => {
        console.error(`Failed to lift temporary ban #${ban.id}: ${error.message}`);
      });
    }
  } finally {
    running = false;
  }
};

const start = (client) => {
  const run = () => sweep(client).catch((error) => console.error(`Failed to check temporary bans: ${error.message}`));
  run();
  setInterval(run, INTERVAL);
};

module.exports = { sweep, start };
