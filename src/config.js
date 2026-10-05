const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const missing = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'].filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`Missing environment variables in .env: ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  publicKey: process.env.DISCORD_PUBLIC_KEY,
  roverApiKey: process.env.ROVER_API_KEY,
};
