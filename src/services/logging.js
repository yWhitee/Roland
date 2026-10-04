const { EmbedBuilder } = require('discord.js');
const guildSettings = require('../database/guildSettings');
const { ACTIONS, Colors, recordEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

const isEnabled = (guild) => Boolean(guildSettings.get(guild.id)?.logs_enabled);

const post = async (guild, payload) => {
  const settings = guildSettings.get(guild.id);
  if (!settings?.logs_enabled) return false;

  try {
    const channel = await guild.channels.fetch(settings.log_channel_id);
    await channel.send(payload);
    return true;
  } catch (error) {
    console.error(`Failed to send log in guild ${guild.id}: ${error.message}`);
    return false;
  }
};

const sendEmbed = (guild, embed) => post(guild, { embeds: [embed] });

const send = (guild, record) => sendEmbed(guild, recordEmbed(record, `Moderation • ${ACTIONS[record.type].label}`));

const enable = async (guild, channel, moderator) => {
  const embed = new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Logs enabled')
    .setDescription(`Moderation and ticket events will be logged in this channel.\n**Enabled by:** <@${moderator.id}>`)
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => {
    throw new UserError('I could not send messages in that channel. Check the bot permissions.');
  });
  guildSettings.enableLogs(guild.id, channel.id);
};

const disable = (guild) => {
  if (!guildSettings.get(guild.id)?.logs_enabled) throw new UserError('Logs are already disabled.');
  guildSettings.disableLogs(guild.id);
};

module.exports = { isEnabled, post, send, sendEmbed, enable, disable };
