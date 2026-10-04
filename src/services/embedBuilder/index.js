const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const sessions = require('./sessions');
const { SECTIONS, panel, sectionModal, fieldModal } = require('./panel');
const { UserError } = require('../../utils/errors');

const start = (interaction) => {
  const session = sessions.create(interaction.id, interaction.user.id);
  return interaction.reply({ ...panel(session), flags: MessageFlags.Ephemeral });
};

const deliver = async (interaction, session) => {
  sessions.assertNotEmpty(session.state);

  const channel = await interaction.guild.channels.fetch(interaction.values[0]).catch(() => null);
  if (!channel?.isTextBased()) throw new UserError('Canal inválido.');

  const allowed = channel.permissionsFor(interaction.member);
  if (!allowed?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new UserError('Você não tem permissão para enviar mensagens nesse canal.');
  }

  const parse = allowed.has(PermissionFlagsBits.MentionEveryone) ? ['users', 'roles', 'everyone'] : ['users'];
  await channel
    .send({ content: session.state.content || undefined, embeds: [sessions.toEmbed(session.state)], allowedMentions: { parse } })
    .catch(() => {
      throw new UserError('Não consegui enviar a mensagem nesse canal. Verifique as permissões do bot.');
    });

  sessions.remove(session);
  await interaction.update({ content: `✅ Embed enviado em ${channel}.`, embeds: [], components: [] });
};

const saveField = (interaction, session, index) => {
  const field = {
    name: interaction.fields.getTextInputValue('name').trim(),
    value: interaction.fields.getTextInputValue('value').trim(),
    inline: interaction.fields.getStringSelectValues('inline')[0] === 'yes',
  };
  if (!field.name || !field.value) throw new UserError('O campo precisa de nome e valor.');

  const fields = [...session.state.fields];
  if (index === 'new') fields.push(field);
  else if (fields[index]) fields[index] = field;
  else throw new UserError('Este campo não existe mais.');

  sessions.update(session, { fields });
  return interaction.update(panel(session));
};

const actions = {
  section: (interaction, session, key) => interaction.showModal(sectionModal(session, key)),
  modal: (interaction, session, key) => {
    const values = SECTIONS[key].inputs.map(([id]) => [id, interaction.fields.getTextInputValue(id).trim()]);
    sessions.update(session, Object.fromEntries(values));
    return interaction.update(panel(session));
  },
  addfield: (interaction, session) => {
    if (session.state.fields.length >= sessions.MAX_FIELDS) throw new UserError(`O embed pode ter no máximo ${sessions.MAX_FIELDS} campos.`);
    return interaction.showModal(fieldModal(session));
  },
  editfield: (interaction, session) => interaction.update(panel(session, 'editfield')),
  removefield: (interaction, session) => interaction.update(panel(session, 'removefield')),
  pickedit: (interaction, session) => interaction.showModal(fieldModal(session, Number(interaction.values[0]))),
  pickremove: (interaction, session) => {
    const index = Number(interaction.values[0]);
    sessions.update(session, { fields: session.state.fields.filter((_, position) => position !== index) });
    return interaction.update(panel(session));
  },
  field: (interaction, session, index) => saveField(interaction, session, index === 'new' ? index : Number(index)),
  timestamp: (interaction, session) => {
    session.state.timestamp = !session.state.timestamp;
    return interaction.update(panel(session));
  },
  preview: (interaction, session) => {
    sessions.assertNotEmpty(session.state);
    return interaction.reply({
      content: session.state.content || undefined,
      embeds: [sessions.toEmbed(session.state)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
  reset: (interaction, session) => {
    sessions.reset(session);
    return interaction.update(panel(session));
  },
  send: (interaction, session) => {
    sessions.assertNotEmpty(session.state);
    return interaction.update(panel(session, 'send'));
  },
  channel: deliver,
  back: (interaction, session) => interaction.update(panel(session)),
  cancel: (interaction, session) => {
    sessions.remove(session);
    return interaction.update({ content: 'Embed Builder cancelado. Nenhuma mensagem foi enviada.', embeds: [], components: [] });
  },
};

const handle = async (interaction) => {
  const [, sessionId, action, argument] = interaction.customId.split(':');
  const session = sessions.get(sessionId, interaction.user.id);
  const run = actions[action];
  if (!run) throw new UserError('Ação desconhecida.');
  await run(interaction, session, argument);
};

module.exports = { start, handle };
