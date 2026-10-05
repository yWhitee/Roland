const { PermissionFlagsBits, RESTJSONErrorCodes } = require('discord.js');
const settings = require('../database/noMessages');

const REQUIRED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages];
const PERMISSION_ERRORS = new Set([RESTJSONErrorCodes.MissingPermissions, RESTJSONErrorCodes.MissingAccess]);

let channels = null;
const warned = new Set();

const load = () => {
  channels = new Map(settings.listEnabled().map((row) => [row.channel_id, row.enabled_at]));
  warned.clear();
  return channels.size;
};

const active = () => {
  if (!channels) load();
  return channels;
};

const canDelete = (channel) => Boolean(channel.permissionsFor(channel.guild.members.me)?.has(REQUIRED));

const setEnabled = ({ guild, channel, enabled, updatedBy, now }) => {
  const { changed, setting } = settings.set({ guildId: guild.id, channelId: channel.id, enabled, updatedBy, now });
  if (enabled) active().set(channel.id, setting.enabled_at);
  else active().delete(channel.id);
  warned.delete(channel.id);
  return changed;
};

const report = (message, error) => {
  if (error.code === RESTJSONErrorCodes.UnknownMessage) return;
  if (PERMISSION_ERRORS.has(error.code)) {
    if (warned.has(message.channelId)) return;
    warned.add(message.channelId);
  }
  console.error(`No-messages could not delete a message in channel ${message.channelId}: ${error.message}`);
};

const handleMessage = (message) => {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return null;
  const since = active().get(message.channelId);
  if (since === undefined || message.createdTimestamp < since) return null;
  return message.delete().then(
    () => {
      warned.delete(message.channelId);
      return true;
    },
    (error) => {
      report(message, error);
      return false;
    },
  );
};

module.exports = { load, canDelete, setEnabled, handleMessage };
