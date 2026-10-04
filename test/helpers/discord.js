const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const BOT_ID = '900000000000000000';
let nextId = 100000000000000000n;
const snowflake = () => String(nextId++);

const tempDatabase = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roland-')), 'test.db');

const apiError = (code, status = 404) => Object.assign(new Error(`API error ${code}`), { code, status });

const makeMessage = (channel, payload) => {
  const message = {
    id: snowflake(),
    channel,
    content: payload.content,
    embeds: payload.embeds ?? [],
    components: payload.components ?? [],
    allowedMentions: payload.allowedMentions,
    deleted: false,
    edit: async (changes) => Object.assign(message, changes),
    delete: async () => {
      message.deleted = true;
    },
  };
  return message;
};

const makeOverwriteManager = () => {
  const cache = new Map();
  const manager = {
    cache,
    edits: [],
    set: (id, type, allow = [], deny = []) => cache.set(id, { id, type, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) }),
    edit: async (id, options, { type } = {}) => {
      const current = cache.get(id);
      const allow = new PermissionsBitField(current?.allow.bitfield ?? 0n);
      const deny = new PermissionsBitField(current?.deny.bitfield ?? 0n);
      for (const [name, value] of Object.entries(options)) {
        allow.remove(PermissionFlagsBits[name]);
        deny.remove(PermissionFlagsBits[name]);
        if (value === true) allow.add(PermissionFlagsBits[name]);
        if (value === false) deny.add(PermissionFlagsBits[name]);
      }
      cache.set(id, { id, type: current?.type ?? type, allow, deny });
      manager.edits.push({ id, options });
    },
  };
  return manager;
};

const makeTextChannel = (guild, { name = 'channel', parent = null, permissionOverwrites = [] } = {}) => {
  const id = snowflake();
  const messages = new Map();
  const channel = {
    id,
    guild,
    name,
    parentId: parent,
    type: ChannelType.GuildText,
    overwrites: permissionOverwrites,
    sent: [],
    edits: 0,
    deleted: false,
    bulkDeleted: [],
    permissionOverwrites: makeOverwriteManager(),
    bulkDelete: async (ids) => {
      channel.bulkDeleted.push(...ids);
      return new Collection(ids.map((messageId) => [messageId, {}]));
    },
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    toString: () => `<#${id}>`,
    send: async (payload) => {
      const message = makeMessage(channel, payload);
      messages.set(message.id, message);
      channel.sent.push(message);
      return message;
    },
    edit: async (changes) => {
      if (changes.name) channel.name = changes.name;
      if (changes.permissionOverwrites) channel.overwrites = changes.permissionOverwrites;
      channel.edits++;
      return channel;
    },
    delete: async () => {
      guild.channels.cache.delete(id);
      channel.deleted = true;
    },
    messages: {
      fetch: async (messageId) => messages.get(messageId) ?? Promise.reject(apiError(10008)),
    },
  };
  return channel;
};

const makeGuild = ({ roles = [] } = {}) => {
  const cache = new Map();
  const members = new Map();
  const banned = new Set();
  const guild = {
    id: snowflake(),
    name: 'Test Server',
    ownerId: snowflake(),
    client: {
      user: { id: BOT_ID },
      users: { cache: new Map() },
      fetchInvite: async () => Promise.reject(apiError(10006)),
    },
    banned,
    roles: { cache: new Map(roles.map((id) => [id, { id }])) },
    bans: {
      fetch: async ({ user }) => {
        if (!banned.has(user)) throw apiError(10026);
        return {};
      },
      remove: async (id) => {
        if (!banned.has(id)) throw apiError(10026);
        banned.delete(id);
      },
    },
    members: {
      me: { id: BOT_ID, roles: { cache: new Map() } },
      cache: members,
      ban: async (id) => banned.add(id),
      fetch: async (options) => members.get(options?.user ?? options) ?? Promise.reject(apiError(10007)),
    },
    channels: {
      cache,
      fetch: async (id) => cache.get(id) ?? Promise.reject(apiError(10003)),
      create: async (options) => {
        const channel = makeTextChannel(guild, options);
        cache.set(channel.id, channel);
        return channel;
      },
    },
  };
  guild.logChannel = makeTextChannel(guild, { name: 'logs' });
  cache.set(guild.logChannel.id, guild.logChannel);
  return guild;
};

const addCategory = (guild, name = 'Tickets') => {
  const category = { id: snowflake(), name, type: ChannelType.GuildCategory };
  guild.channels.cache.set(category.id, category);
  return category;
};

const makeMember = (role, { dm = true, globalName = null } = {}) => {
  const id = snowflake();
  const state = { kicked: false, timeoutUntil: null, dms: [] };
  const roles = new Map(role ? [[role, {}]] : []);
  const member = {
    id,
    state,
    nickname: null,
    client: { user: { id: BOT_ID } },
    roles: {
      cache: roles,
      add: async (roleId) => roles.set(roleId, {}),
      remove: async (roleId) => roles.delete(roleId),
    },
    setNickname: async (nickname) => {
      member.nickname = nickname;
    },
    user: {
      id,
      tag: `user${id}`,
      username: `user${id}`,
      globalName,
      send: async (payload) => {
        if (!dm) throw apiError(50007, 403);
        const message = { payload, deleted: false, delete: async () => (message.deleted = true) };
        state.dms.push(message);
        return message;
      },
    },
    kick: async () => {
      state.kicked = true;
    },
    isCommunicationDisabled: () => state.timeoutUntil !== null && state.timeoutUntil > Date.now(),
    disableCommunicationUntil: async (until) => {
      state.timeoutUntil = until;
    },
    timeout: async (value) => {
      state.timeoutUntil = value === null ? null : Date.now() + value;
    },
  };
  return member;
};

const makeInteraction = ({ guild, member, customId = '', message = null, fields = {} }) => {
  const calls = { replies: [], modals: [] };
  const interaction = {
    id: snowflake(),
    customId,
    guild,
    guildId: guild?.id,
    member,
    user: member.user,
    message,
    calls,
    deferred: false,
    replied: false,
    fields: { getTextInputValue: (id) => fields[id] ?? '' },
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload) => calls.replies.push(payload),
    reply: async (payload) => {
      interaction.replied = true;
      calls.replies.push(payload);
    },
    showModal: async (modal) => calls.modals.push(modal),
  };
  return interaction;
};

const canView = (channel, member) => {
  const view = PermissionFlagsBits.ViewChannel;
  const overwrites = new Map(channel.overwrites.map((overwrite) => [overwrite.id, overwrite]));
  const allows = (id) => (overwrites.get(id)?.allow ?? []).includes(view);
  const denies = (id) => (overwrites.get(id)?.deny ?? []).includes(view);

  if (allows(member.id)) return true;
  if (denies(member.id)) return false;
  if ([...member.roles.cache.keys()].some(allows)) return true;
  return !denies(channel.guild.id);
};

const collection = (items) => new Collection(items.map((item) => [item.id, item]));

module.exports = {
  BOT_ID,
  snowflake,
  tempDatabase,
  apiError,
  makeGuild,
  makeTextChannel,
  addCategory,
  makeMember,
  makeInteraction,
  canView,
  collection,
};
