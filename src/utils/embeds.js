const { EmbedBuilder } = require('discord.js');
const { formatDuration } = require('./duration');

const Colors = { error: 0xed4245, success: 0x57f287, info: 0x5865f2 };

const ACTIONS = {
  ban: { label: 'Ban', color: 0xed4245 },
  kick: { label: 'Kick', color: 0xe67e22 },
  mute: { label: 'Mute', color: 0xfee75c },
  warn: { label: 'Warn', color: 0xf1c40f },
  unban: { label: 'Unban', color: 0x57f287 },
  unmute: { label: 'Unmute', color: 0x57f287 },
  clear: { label: 'Clear', color: 0x5865f2 },
};

const time = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;

const describe = (record, { user = true } = {}) => {
  const lines = [];
  if (user && record.user_id) lines.push(`**Usuário:** <@${record.user_id}> (\`${record.user_id}\`)`);
  lines.push(`**Moderador:** <@${record.moderator_id}>`);
  lines.push(`**Data:** ${time(record.created_at)}`);
  if (record.duration) {
    lines.push(`**Duração:** ${formatDuration(record.duration)}`);
    lines.push(`**Término:** ${record.expires_at ? time(record.expires_at) : 'Nunca'}`);
  }
  if (record.channel_id) lines.push(`**Canal:** <#${record.channel_id}>`);
  if (record.metadata?.requested) lines.push(`**Mensagens apagadas:** ${record.metadata.deleted} de ${record.metadata.requested} solicitadas`);
  if (record.reason) lines.push(`**Motivo:** ${record.reason}`);
  return lines.join('\n');
};

const recordEmbed = (record, title) =>
  new EmbedBuilder()
    .setColor(ACTIONS[record.type].color)
    .setTitle(title)
    .setDescription(describe(record))
    .setFooter({ text: `Registro #${record.id}` })
    .setTimestamp(record.created_at);

const warnDmEmbed = (guild, moderator, record) =>
  new EmbedBuilder()
    .setColor(ACTIONS.warn.color)
    .setTitle('Você recebeu um aviso')
    .setDescription([
      `**Servidor:** ${guild.name}`,
      `**Data:** ${time(record.created_at)}`,
      `**Aplicado por:** ${moderator.user.tag}`,
      `**Motivo:** ${record.reason}`,
    ].join('\n'))
    .setTimestamp(record.created_at);

const errorEmbed = (message) => new EmbedBuilder().setColor(Colors.error).setDescription(`❌ ${message}`);

const successEmbed = (message) => new EmbedBuilder().setColor(Colors.success).setDescription(`✅ ${message}`);

module.exports = { ACTIONS, Colors, time, describe, recordEmbed, warnDmEmbed, errorEmbed, successEmbed };
