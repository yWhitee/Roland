const { EmbedBuilder } = require('discord.js');
const guildSettings = require('../database/guildSettings');
const { ACTIONS, Colors, recordEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

const send = async (guild, record) => {
  const settings = guildSettings.get(guild.id);
  if (!settings?.logs_enabled) return;

  try {
    const channel = await guild.channels.fetch(settings.log_channel_id);
    await channel.send({ embeds: [recordEmbed(record, `Moderação • ${ACTIONS[record.type].label}`)] });
  } catch (error) {
    console.error(`Falha ao enviar log no servidor ${guild.id}: ${error.message}`);
  }
};

const enable = async (guild, channel, moderator) => {
  const embed = new EmbedBuilder()
    .setColor(Colors.info)
    .setTitle('Logs de moderação ativadas')
    .setDescription(`As ações de moderação serão registradas neste canal.\n**Ativado por:** <@${moderator.id}>`)
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => {
    throw new UserError('Não consegui enviar mensagens nesse canal. Verifique as permissões do bot.');
  });
  guildSettings.enableLogs(guild.id, channel.id);
};

const disable = (guild) => {
  if (!guildSettings.get(guild.id)?.logs_enabled) throw new UserError('As logs já estão desativadas.');
  guildSettings.disableLogs(guild.id);
};

module.exports = { send, enable, disable };
