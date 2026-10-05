const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const jsonImport = require('./jsonImport');
const sessions = require('./sessions');
const { SECTIONS, panel, sectionModal, fieldModal, importModal } = require('./panel');
const { errorEmbed } = require('../../utils/embeds');
const { UserError, userMessage } = require('../../utils/errors');

const send = (channel, payload) => channel.send(payload);

const start = (interaction, { prefix, title = 'Embed Builder', note = null, channel = null, initial = {}, deliver = send }) => {
  const session = sessions.create(interaction.id, interaction.user.id, { prefix, title, note, channel, initial, deliver });
  return interaction.reply({ ...panel(session), flags: MessageFlags.Ephemeral });
};

const deliver = async (interaction, session, channelId) => {
  sessions.assertNotEmpty(session.state);

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new UserError('Invalid channel.');

  const allowed = channel.permissionsFor(interaction.member);
  if (!allowed?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new UserError('You do not have permission to send messages in that channel.');
  }

  const parse = allowed.has(PermissionFlagsBits.MentionEveryone) ? ['users', 'roles', 'everyone'] : ['users'];
  await session.deliver(channel, { content: session.state.content || undefined, embeds: [sessions.toEmbed(session.state)], allowedMentions: { parse } });

  sessions.remove(session);
  await interaction.update({ content: `✅ ${session.title}: sent to ${channel}.`, embeds: [], components: [] });
};

const saveField = (interaction, session, index) => {
  const field = {
    name: interaction.fields.getTextInputValue('name').trim(),
    value: interaction.fields.getTextInputValue('value').trim(),
    inline: interaction.fields.getStringSelectValues('inline')[0] === 'yes',
  };
  if (!field.name || !field.value) throw new UserError('A field needs both a name and a value.');

  const fields = [...session.state.fields];
  if (index === 'new') fields.push(field);
  else if (fields[index]) fields[index] = field;
  else throw new UserError('This field no longer exists.');

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
    if (session.state.fields.length >= sessions.MAX_FIELDS) throw new UserError(`An embed can have at most ${sessions.MAX_FIELDS} fields.`);
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
  import: (interaction, session) => interaction.showModal(importModal(session)),
  importfile: async (interaction, session) => {
    await interaction.deferUpdate();
    let imported;
    try {
      imported = await jsonImport.read(interaction.fields.getUploadedFiles('file'));
      sessions.update(sessions.get(session.id, interaction.user.id), imported.state);
    } catch (error) {
      return interaction.followUp({ embeds: [errorEmbed(userMessage(error))], flags: MessageFlags.Ephemeral });
    }
    return interaction.editReply(panel(session, 'main', `✅ Imported \`${imported.name}\`. Review and edit it below, then press **Send**. Nothing has been sent yet.`));
  },
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
    if (session.channel) return deliver(interaction, session, session.channel.id);
    sessions.assertNotEmpty(session.state);
    return interaction.update(panel(session, 'send'));
  },
  channel: (interaction, session) => deliver(interaction, session, interaction.values[0]),
  back: (interaction, session) => interaction.update(panel(session)),
  cancel: (interaction, session) => {
    sessions.remove(session);
    return interaction.update({ content: `${session.title} cancelled. Nothing was sent.`, embeds: [], components: [] });
  },
};

const handle = async (interaction) => {
  const [, sessionId, action, argument] = interaction.customId.split(':');
  const session = sessions.get(sessionId, interaction.user.id);
  const run = Object.hasOwn(actions, action) ? actions[action] : null;
  if (!run) throw new UserError('Unknown action.');
  await run(interaction, session, argument);
};

module.exports = { start, handle };
