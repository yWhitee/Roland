const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { MAX_FIELDS, toEmbed, isEmpty } = require('./sessions');

const SECTIONS = {
  body: {
    label: 'Título e descrição',
    inputs: [
      ['title', 'Título', { max: 256 }],
      ['url', 'URL do título', { max: 2000 }],
      ['description', 'Descrição', { max: 4000, style: TextInputStyle.Paragraph }],
      ['color', 'Cor (hexadecimal)', { max: 7, placeholder: '#5865F2' }],
    ],
  },
  author: {
    label: 'Autor',
    inputs: [
      ['authorName', 'Nome do autor', { max: 256 }],
      ['authorIcon', 'Ícone do autor (URL)', { max: 2000 }],
      ['authorUrl', 'URL do autor', { max: 2000 }],
    ],
  },
  images: {
    label: 'Imagens',
    inputs: [
      ['thumbnail', 'Thumbnail (URL)', { max: 2000 }],
      ['image', 'Imagem principal (URL)', { max: 2000 }],
    ],
  },
  footer: {
    label: 'Rodapé',
    inputs: [
      ['footer', 'Texto do rodapé', { max: 2048, style: TextInputStyle.Paragraph }],
      ['footerIcon', 'Ícone do rodapé (URL)', { max: 2000 }],
    ],
  },
  content: {
    label: 'Conteúdo',
    inputs: [['content', 'Conteúdo da mensagem (fora do embed)', { max: 2000, style: TextInputStyle.Paragraph }]],
  },
};

const VIEWS = {
  main: 'configure o embed usando os botões abaixo.',
  editfield: 'escolha o campo que deseja editar.',
  removefield: 'escolha o campo que deseja remover.',
  send: 'escolha o canal onde o embed será enviado.',
};

const customId = (session, ...parts) => ['embed', session.id, ...parts].join(':');

const button = (session, action, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(customId(session, action)).setLabel(label).setStyle(style).setDisabled(disabled);

const row = (...components) => new ActionRowBuilder().addComponents(components);

const fieldSelect = (session, action) =>
  new StringSelectMenuBuilder()
    .setCustomId(customId(session, action))
    .setPlaceholder('Selecione um campo')
    .addOptions(session.state.fields.map((field, index) => ({ label: `${index + 1}. ${field.name}`.slice(0, 100), value: String(index) })));

const components = (session, view) => {
  const { fields, timestamp } = session.state;
  const back = row(button(session, 'back', 'Voltar'));

  if (view === 'editfield') return [row(fieldSelect(session, 'pickedit')), back];
  if (view === 'removefield') return [row(fieldSelect(session, 'pickremove')), back];
  if (view === 'send') {
    const channels = new ChannelSelectMenuBuilder()
      .setCustomId(customId(session, 'channel'))
      .setPlaceholder('Escolha o canal de envio')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    return [row(channels), back];
  }

  return [
    row(...Object.entries(SECTIONS).map(([key, section]) => button(session, `section:${key}`, section.label))),
    row(
      button(session, 'addfield', 'Adicionar campo', ButtonStyle.Primary, fields.length >= MAX_FIELDS),
      button(session, 'editfield', 'Editar campo', ButtonStyle.Secondary, !fields.length),
      button(session, 'removefield', 'Remover campo', ButtonStyle.Secondary, !fields.length),
      button(session, 'timestamp', `Timestamp: ${timestamp ? 'ativado' : 'desativado'}`),
    ),
    row(
      button(session, 'preview', 'Visualizar'),
      button(session, 'reset', 'Limpar', ButtonStyle.Danger),
      button(session, 'send', 'Enviar', ButtonStyle.Success),
      button(session, 'cancel', 'Cancelar', ButtonStyle.Danger),
    ),
  ];
};

const panel = (session, view = 'main') => {
  const { state } = session;
  const lines = [`**Embed Builder** — ${VIEWS[view]}`];
  if (state.content) lines.push('', '**Conteúdo da mensagem:**', state.content.length > 1500 ? `${state.content.slice(0, 1500)}…` : state.content);

  const preview = isEmpty(state)
    ? new EmbedBuilder().setDescription('*O embed está vazio. Use os botões abaixo para configurá-lo.*')
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
    .addOptions({ label: 'Sim', value: 'yes', default: field.inline }, { label: 'Não', value: 'no', default: !field.inline });

  return new ModalBuilder()
    .setCustomId(customId(session, 'field', index ?? 'new'))
    .setTitle(index === undefined ? 'Adicionar campo' : 'Editar campo')
    .addLabelComponents(
      textInput('name', 'Nome do campo', { max: 256, value: field.name, required: true }),
      textInput('value', 'Valor do campo', { max: 1024, style: TextInputStyle.Paragraph, value: field.value, required: true }),
      new LabelBuilder().setLabel('Exibir em linha (inline)').setStringSelectMenuComponent(inline),
    );
};

module.exports = { SECTIONS, panel, sectionModal, fieldModal };
