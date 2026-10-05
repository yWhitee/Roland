const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { MAX_BYTES } = require('./jsonImport');
const { MAX_FIELDS, toEmbed, isEmpty } = require('./sessions');

const SECTIONS = {
  body: {
    label: 'Title & description',
    inputs: [
      ['title', 'Title', { max: 256 }],
      ['url', 'Title URL', { max: 2000 }],
      ['description', 'Description', { max: 4000, style: TextInputStyle.Paragraph }],
      ['color', 'Color (hex)', { max: 7, placeholder: '#5865F2' }],
    ],
  },
  author: {
    label: 'Author',
    inputs: [
      ['authorName', 'Author name', { max: 256 }],
      ['authorIcon', 'Author icon URL', { max: 2000 }],
      ['authorUrl', 'Author URL', { max: 2000 }],
    ],
  },
  images: {
    label: 'Images',
    inputs: [
      ['thumbnail', 'Thumbnail URL', { max: 2000 }],
      ['image', 'Main image URL', { max: 2000 }],
    ],
  },
  footer: {
    label: 'Footer',
    inputs: [
      ['footer', 'Footer text', { max: 2048, style: TextInputStyle.Paragraph }],
      ['footerIcon', 'Footer icon URL', { max: 2000 }],
    ],
  },
  content: {
    label: 'Message content',
    inputs: [['content', 'Message content (outside the embed)', { max: 2000, style: TextInputStyle.Paragraph }]],
  },
};

const VIEWS = {
  main: 'configure the embed using the buttons below.',
  editfield: 'choose the field you want to edit.',
  removefield: 'choose the field you want to remove.',
  send: 'choose the channel to send the embed to.',
};

const customId = (session, ...parts) => [session.prefix, session.id, ...parts].join(':');

const button = (session, action, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(customId(session, action)).setLabel(label).setStyle(style).setDisabled(disabled);

const row = (...components) => new ActionRowBuilder().addComponents(components);

const fieldSelect = (session, action) =>
  new StringSelectMenuBuilder()
    .setCustomId(customId(session, action))
    .setPlaceholder('Select a field')
    .addOptions(session.state.fields.map((field, index) => ({ label: `${index + 1}. ${field.name}`.slice(0, 100), value: String(index) })));

const components = (session, view) => {
  const { fields, timestamp } = session.state;
  const back = row(button(session, 'back', 'Back'));

  if (view === 'editfield') return [row(fieldSelect(session, 'pickedit')), back];
  if (view === 'removefield') return [row(fieldSelect(session, 'pickremove')), back];
  if (view === 'send') {
    const channels = new ChannelSelectMenuBuilder()
      .setCustomId(customId(session, 'channel'))
      .setPlaceholder('Choose a destination channel')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    return [row(channels), back];
  }

  return [
    row(...Object.entries(SECTIONS).map(([key, section]) => button(session, `section:${key}`, section.label))),
    row(
      button(session, 'addfield', 'Add field', ButtonStyle.Primary, fields.length >= MAX_FIELDS),
      button(session, 'editfield', 'Edit field', ButtonStyle.Secondary, !fields.length),
      button(session, 'removefield', 'Remove field', ButtonStyle.Secondary, !fields.length),
      button(session, 'timestamp', `Timestamp: ${timestamp ? 'on' : 'off'}`),
    ),
    row(
      button(session, 'import', 'Import JSON'),
      button(session, 'preview', 'Preview'),
      button(session, 'reset', 'Clear', ButtonStyle.Danger),
      button(session, 'send', 'Send', ButtonStyle.Success),
      button(session, 'cancel', 'Cancel', ButtonStyle.Danger),
    ),
  ];
};

const panel = (session, view = 'main', notice = null) => {
  const { state } = session;
  const lines = [`**${session.title}** — ${VIEWS[view]}`];
  if (session.note) lines.push(session.note);
  if (notice) lines.push(notice);
  if (state.content) lines.push('', '**Message content:**', state.content.length > 1500 ? `${state.content.slice(0, 1500)}…` : state.content);

  const preview = isEmpty(state)
    ? new EmbedBuilder().setDescription('*The embed is empty. Use the buttons below to configure it.*')
    : toEmbed(state);

  return { content: lines.join('\n'), embeds: [preview], components: components(session, view), allowedMentions: { parse: [] } };
};

const textInput = (id, label, { max, style = TextInputStyle.Short, placeholder, value, required = false }) => {
  const input = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
  if (placeholder) input.setPlaceholder(placeholder);
  if (value) input.setValue(value);
  return new LabelBuilder().setLabel(label).setTextInputComponent(input);
};

const sectionModal = (session, key) => {
  const section = SECTIONS[key];
  return new ModalBuilder()
    .setCustomId(customId(session, 'modal', key))
    .setTitle(section.label)
    .addLabelComponents(section.inputs.map(([id, label, options]) => textInput(id, label, { ...options, value: session.state[id] })));
};

const fieldModal = (session, index) => {
  const field = session.state.fields[index] ?? { name: '', value: '', inline: false };
  const inline = new StringSelectMenuBuilder()
    .setCustomId('inline')
    .addOptions({ label: 'Yes', value: 'yes', default: field.inline }, { label: 'No', value: 'no', default: !field.inline });

  return new ModalBuilder()
    .setCustomId(customId(session, 'field', index ?? 'new'))
    .setTitle(index === undefined ? 'Add field' : 'Edit field')
    .addLabelComponents(
      textInput('name', 'Field name', { max: 256, value: field.name, required: true }),
      textInput('value', 'Field value', { max: 1024, style: TextInputStyle.Paragraph, value: field.value, required: true }),
      new LabelBuilder().setLabel('Display inline').setStringSelectMenuComponent(inline),
    );
};

const importModal = (session) =>
  new ModalBuilder()
    .setCustomId(customId(session, 'importfile'))
    .setTitle('Import JSON')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('JSON file')
        .setDescription(`One .json file up to ${MAX_BYTES / 1024} KB. It replaces everything in the editor; nothing is sent yet.`)
        .setFileUploadComponent(new FileUploadBuilder().setCustomId('file').setMinValues(1).setMaxValues(1).setRequired(true)),
    );

module.exports = { SECTIONS, panel, sectionModal, fieldModal, importModal };
