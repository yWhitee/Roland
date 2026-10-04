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
  roblox: {
    clientId: process.env.ROBLOX_CLIENT_ID,
    clientSecret: process.env.ROBLOX_CLIENT_SECRET,
    redirectUri: process.env.ROBLOX_REDIRECT_URI,
  },
  oauthServer: {
    host: process.env.OAUTH_SERVER_HOST || '127.0.0.1',
    port: Number(process.env.OAUTH_SERVER_PORT) || 3000,
  },
};
