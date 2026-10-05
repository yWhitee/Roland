const { ChannelType, PermissionFlagsBits: P } = require('discord.js');
const guildSettings = require('../database/guildSettings');
const permissions = require('../permissions');
const { ACCESS, canExecuteChatbotAction } = require('./chatbotPermissions');
const moderation = require('./moderation');
const { UserError } = require('../utils/errors');

class ToolError extends Error {
  constructor(message, outcome = null, cause = undefined) {
    super(message, { cause });
    this.outcome = outcome;
  }
}

const fail = (message) => {
  throw new ToolError(message);
};

const unless = (...codes) => (error) => {
  if (codes.includes(error?.code)) return null;
  throw error;
};

const STAFF_ROLES = new Set(Object.values(permissions.ROLES));
const MAX_SENT = 1000;
const sentByChatbot = new Set();

const remember = (id) => {
  sentByChatbot.add(id);
  if (sentByChatbot.size > MAX_SENT) sentByChatbot.delete(sentByChatbot.values().next().value);
};
const SAFE_OVERWRITES = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions', 'AttachFiles', 'EmbedLinks', 'Connect', 'Speak', 'SendMessagesInThreads'];
const CHANNEL_TYPES = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory };
const MENTION = /^(?:<[@#]?[!&]?(\d{17,20})>|(\d{17,20}))$/;
const COLOR = /^#?[0-9a-f]{6}$/i;

const API_ERRORS = {
  50013: 'Discord denied it: Roland is missing a permission or the target is above Roland in the role hierarchy (Missing Permissions).',
  50001: 'Roland cannot access that channel (Missing Access).',
  50034: 'Discord only bulk deletes messages younger than 14 days.',
  50035: 'Discord rejected the values (Invalid Form Body).',
  10003: 'The channel does not exist.',
  10007: 'The member is not in the server.',
  10008: 'The message does not exist.',
  10011: 'The role does not exist.',
  10013: 'The user does not exist.',
  10026: 'The user is not banned.',
  30005: 'The server has reached the maximum number of roles.',
  30013: 'The server has reached the maximum number of channels.',
};

const isDiscordError = (error) => typeof error?.code === 'number';

const isExpected = (error) => (error instanceof ToolError && (!error.cause || isExpected(error.cause))) || error instanceof UserError || isDiscordError(error);

const describeError = (error) => {
  if (error instanceof ToolError || error instanceof UserError) return error.message;
  if (API_ERRORS[error?.code]) return API_ERRORS[error.code];
  if (error?.status === 429) return 'Discord rate limited the request.';
  if (isDiscordError(error)) return `Discord error ${error.code}: ${error.message}`;
  return `Internal error: ${error?.message ?? 'unknown error'}`;
};

const idFrom = (value) => {
  const match = String(value ?? '').trim().match(MENTION);
  return match ? match[1] ?? match[2] : null;
};

const label = (value) => String(value ?? '').trim().replace(/^[@#]/, '').toLowerCase();

const text = (value, name, max, optional = false) => {
  const result = value === undefined || value === null ? '' : String(value).trim();
  if (!result) return optional ? undefined : fail(`${name} is required.`);
  if (result.length > max) fail(`${name} must be at most ${max} characters.`);
  return result;
};

const integer = (value, name, min, max, fallback) => {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(`${name} must be a whole number from ${min} to ${max}.`);
  return number;
};

const flag = (value) => (value === undefined || value === null ? undefined : value === true || String(value).toLowerCase() === 'true');

const unique = (matches, kind, value) => {
  if (matches.length === 1) return matches[0];
  return fail(matches.length ? `More than one ${kind} matches "${value}". Use its ID.` : `No ${kind} matching "${value}" was found in this server.`);
};

const findMember = async ({ guild }, value) => {
  const id = idFrom(value);
  if (id) return (await guild.members.fetch({ user: id, force: true }).catch(unless(10007, 10013))) ?? fail(`No member with ID ${id} is in this server.`);
  const name = label(value);
  if (!name) fail('A member is required.');
  const names = (member) => [member.user.username, member.user.globalName, member.nickname, member.displayName].filter(Boolean).map((entry) => entry.toLowerCase());
  return unique([...guild.members.cache.values()].filter((member) => names(member).includes(name)), 'member', value);
};

const findRole = ({ guild }, value) => {
  const id = idFrom(value);
  if (id) return guild.roles.cache.get(id) ?? fail(`No role with ID ${id} exists in this server.`);
  const name = label(value);
  if (!name) fail('A role is required.');
  return unique([...guild.roles.cache.values()].filter((role) => role.name?.toLowerCase() === name), 'role', value);
};

const isThread = (channel) => Boolean(channel.isThread?.());

const usable = (channel) => (isThread(channel) ? fail('Threads cannot be used through the chatbot tools.') : channel);

const findChannel = async (context, value, fallback = false) => {
  const { guild, channel: current } = context;
  if ((value === undefined || value === null || value === '') && fallback) return usable(current);
  const id = idFrom(value);
  if (id) {
    const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(unless(10003)));
    if (!channel || channel.guild?.id !== guild.id || !canSee(context, channel)) fail(`No channel with ID ${id} that you can view exists in this server.`);
    return usable(channel);
  }
  const name = label(value);
  if (!name) fail('A channel is required.');
  const matches = [...guild.channels.cache.values()].filter((channel) => !isThread(channel) && channel.name?.toLowerCase() === name && canSee(context, channel));
  return unique(matches, 'channel you can view', value);
};

const top = (member) => member?.roles?.highest?.position ?? 0;
const nameOf = (member) => member.displayName ?? member.user?.globalName ?? member.user?.username ?? member.id;
const isServerOwner = ({ guild }, member) => member.id === guild.ownerId;

const allowed = (member, flagBit, channel) => Boolean(channel ? channel.permissionsFor?.(member)?.has(flagBit) : member?.permissions?.has(flagBit));

const needs = (context, flagBit, permission, channel) => {
  const where = channel ? ` in #${channel.name}` : '';
  if (!allowed(context.actor, flagBit, channel)) fail(`You do not have the ${permission} permission${where}.`);
  if (!allowed(context.me, flagBit, channel)) fail(`Roland does not have the ${permission} permission${where}.`);
};

const canSee = (context, channel) => allowed(context.actor, P.ViewChannel, channel);

const visible = (context, channel) => {
  if (!canSee(context, channel)) fail(`You cannot view #${channel.name}.`);
  return channel;
};

const textChannel = (channel) => (channel.isTextBased?.() ? channel : fail(`#${channel.name} is not a text channel.`));

const level = (context, required, command) => {
  if (permissions.getLevel(context.actor) < required) fail(`Using ${command} through the chatbot requires the same staff level as the /${command} command.`);
};

const assertRole = (context, role) => {
  const { guild, me, actor, access } = context;
  if (role.id === guild.id) fail('The @everyone role cannot be managed this way.');
  if (role.managed) fail(`@${role.name} is managed by an integration and cannot be changed.`);
  if (role.position >= top(me)) fail(`@${role.name} is at or above Roland's highest role, so Discord does not allow Roland to manage it.`);
  if (!isServerOwner(context, actor) && role.position >= top(actor)) fail(`@${role.name} is at or above your highest role.`);
  if (access !== ACCESS.SERVER_OWNER && (STAFF_ROLES.has(role.id) || role.permissions?.has?.(P.Administrator))) {
    fail(`@${role.name} is a protected staff role; only the server owner can manage it through the chatbot.`);
  }
};

const assertMember = (context, target, { self = true } = {}) => {
  const { guild, me, actor } = context;
  if (target.id === guild.ownerId) fail('The server owner cannot be changed by Roland.');
  if (target.id === me.id) fail('Roland cannot do this to itself.');
  if (top(target) >= top(me)) fail(`${nameOf(target)}'s highest role is at or above Roland's highest role, so Discord blocks this.`);
  if (!isServerOwner(context, actor) && (target.id !== actor.id || !self) && top(target) >= top(actor)) fail(`${nameOf(target)}'s highest role is at or above yours.`);
};

const roleList = (guild, member) =>
  [...member.roles.cache.keys()].map((id) => guild.roles.cache.get(id)).filter((role) => role && role.id !== guild.id).map((role) => ({ id: role.id, name: role.name }));

const memberSummary = (guild, member) => ({
  id: member.id,
  username: member.user.username,
  display_name: nameOf(member),
  nickname: member.nickname ?? null,
  roles: roleList(guild, member),
  is_server_owner: member.id === guild.ownerId,
  joined_at: member.joinedTimestamp ? new Date(member.joinedTimestamp).toISOString() : null,
});

const channelSummary = (channel) => ({ id: channel.id, name: channel.name, type: ChannelType[channel.type] ?? channel.type, parent_id: channel.parentId ?? null });

const freshOverwrite = async ({ guild }, channel, targetId) => {
  const fresh = await guild.channels.fetch(channel.id, { force: true }).catch(unless(10003));
  return fresh?.permissionOverwrites?.cache?.get(targetId) ?? null;
};

const refetchMember = (context, id) => context.guild.members.fetch({ user: id, force: true }).catch(unless(10007));

const fetchMessage = async (channel, value) =>
  (await channel.messages.fetch(idFrom(value) ?? fail('A message ID is required.')).catch(unless(10008))) ?? fail('That message does not exist in this channel.');

const moderationTarget = async (context, value) => {
  const member = await findMember(context, value);
  return { user: member.user, member };
};

const userTarget = async (context, value) => {
  const id = idFrom(value) ?? fail('A user ID or mention is required.');
  const user = (await context.guild.client.users.fetch(id).catch(unless(10013))) ?? fail(`No Discord user with ID ${id} exists.`);
  return { user, member: await refetchMember(context, id) };
};

const isBanned = (context, id) =>
  context.guild.bans.fetch({ user: id, force: true }).then(
    () => true,
    (error) => Boolean(unless(10026)(error)),
  );

const field = (description, type = 'string') => ({ type, description });
const MEMBER = field('Member ID, mention or exact name');
const ROLE = field('Role ID, mention or exact name');
const CHANNEL = field('Channel ID, mention or exact name');
const REASON = field('Reason');

const definition = (name, description, properties, required, spec) => ({ name, description, properties, required, mutates: false, ...spec });

const TOOLS = [
  definition('get_server_info', 'Basic information about this server', {}, [], {
    prepare: () => ({}),
    run: ({ guild }) => ({ id: guild.id, name: guild.name, owner_id: guild.ownerId, members: guild.memberCount ?? guild.members.cache.size, channels: guild.channels.cache.size, roles: guild.roles.cache.size }),
  }),
  definition('get_member', 'Information about one member', { member: MEMBER }, ['member'], {
    prepare: async (context, args) => ({ member: await findMember(context, args.member) }),
    run: ({ guild }, { member }) => memberSummary(guild, member),
  }),
  definition('search_members', 'Find members whose name contains a text', { query: field('Text to search') }, ['query'], {
    prepare: (context, args) => ({ query: text(args.query, 'query', 100).toLowerCase() }),
    run: async ({ guild }, { query }) => {
      const found = guild.members.search ? [...(await guild.members.search({ query, limit: 10 })).values()] : [];
      const cached = [...guild.members.cache.values()].filter((member) => [member.user.username, member.user.globalName, member.nickname].some((name) => name?.toLowerCase().includes(query)));
      return [...new Map([...found, ...cached].map((member) => [member.id, member])).values()].slice(0, 10).map((member) => memberSummary(guild, member));
    },
  }),
  definition('get_members', 'List members known to Roland', { limit: field('How many (1-25)', 'integer') }, [], {
    prepare: (context, args) => ({ limit: integer(args.limit, 'limit', 1, 25, 25) }),
    run: ({ guild }, { limit }) => [...guild.members.cache.values()].slice(0, limit).map((member) => memberSummary(guild, member)),
  }),
  definition('get_roles', 'List the roles of this server', {}, [], {
    prepare: () => ({}),
    run: ({ guild }) =>
      [...guild.roles.cache.values()].filter((role) => role.id !== guild.id).sort((a, b) => b.position - a.position).slice(0, 50).map((role) => ({ id: role.id, name: role.name, position: role.position, managed: Boolean(role.managed) })),
  }),
  definition('get_channels', 'List the channels you can see', {}, [], {
    prepare: () => ({}),
    run: (context) => [...context.guild.channels.cache.values()].filter((channel) => !isThread(channel) && canSee(context, channel)).slice(0, 75).map(channelSummary),
  }),
  definition('get_channel_info', 'Details of one channel', { channel: CHANNEL }, ['channel'], {
    prepare: async (context, args) => ({ channel: visible(context, await findChannel(context, args.channel)) }),
    run: (context, { channel }) => ({ ...channelSummary(channel), topic: channel.topic ?? null, nsfw: Boolean(channel.nsfw), slowmode_seconds: channel.rateLimitPerUser ?? 0 }),
  }),
  definition('get_member_roles', 'The roles of one member', { member: MEMBER }, ['member'], {
    prepare: async (context, args) => ({ member: await findMember(context, args.member) }),
    run: ({ guild }, { member }) => roleList(guild, member),
  }),
  definition('get_server_permissions', "Roland's and your server permissions", {}, [], {
    prepare: () => ({}),
    run: ({ me, actor }) => ({ roland: me.permissions?.toArray?.() ?? [], you: actor.permissions?.toArray?.() ?? [] }),
  }),

  definition('send_message', 'Send a message to a channel', { channel: CHANNEL, content: field('Message text') }, ['channel', 'content'], {
    mutates: true,
    prepare: async (context, args) => {
      const channel = textChannel(visible(context, await findChannel(context, args.channel, true)));
      needs(context, P.SendMessages, 'Send Messages', channel);
      return { channel, content: text(args.content, 'content', 2000) };
    },
    run: async (context, { channel, content }) => {
      const sent = await channel.send({ content, allowedMentions: { parse: [] } });
      remember(sent.id);
      return { message_id: sent.id };
    },
    verify: (context, prepared, result) => Boolean(result.message_id),
    describe: ({ channel, content }) => `Send a message in <#${channel.id}>: "${content.slice(0, 200)}"`,
  }),
  definition('edit_message', "Edit one of Roland's messages", { channel: CHANNEL, message_id: field('Message ID'), content: field('New text') }, ['channel', 'message_id', 'content'], {
    mutates: true,
    prepare: async (context, args) => {
      const channel = textChannel(visible(context, await findChannel(context, args.channel, true)));
      needs(context, P.ManageMessages, 'Manage Messages', channel);
      const message = await fetchMessage(channel, args.message_id);
      if (message.author?.id !== context.me.id) fail('Discord only lets a bot edit its own messages.');
      if (context.access !== ACCESS.SERVER_OWNER && !sentByChatbot.has(message.id)) fail('Only messages the chatbot sent with send_message can be edited this way.');
      return { channel, message, content: text(args.content, 'content', 2000) };
    },
    run: async (context, { message, content }) => ({ message_id: (await message.edit({ content, allowedMentions: { parse: [] } })).id ?? message.id }),
    verify: async (context, { channel, message, content }) => (await channel.messages.fetch(message.id).catch(unless(10008)))?.content === content,
    describe: ({ channel, message }) => `Edit message ${message.id} in <#${channel.id}>`,
  }),
  definition('delete_message', 'Delete one message', { channel: CHANNEL, message_id: field('Message ID') }, ['channel', 'message_id'], {
    mutates: true,
    prepare: async (context, args) => {
      const channel = textChannel(visible(context, await findChannel(context, args.channel, true)));
      const message = await fetchMessage(channel, args.message_id);
      if (message.author?.id !== context.actor.id) needs(context, P.ManageMessages, 'Manage Messages', channel);
      if (message.author?.id !== context.me.id && !allowed(context.me, P.ManageMessages, channel)) fail(`Roland does not have the Manage Messages permission in #${channel.name}.`);
      return { channel, message };
    },
    run: async (context, { message }) => {
      await message.delete();
      return { deleted: message.id };
    },
    verify: async (context, { channel, message }) => !(await channel.messages.fetch(message.id).catch(unless(10008))),
    describe: ({ channel, message }) => `Delete message ${message.id} in <#${channel.id}>`,
  }),
  definition('bulk_delete_messages', 'Delete the latest messages of a channel', { channel: CHANNEL, amount: field('How many (1-100)', 'integer') }, ['channel', 'amount'], {
    mutates: true,
    prepare: async (context, args) => {
      const channel = textChannel(visible(context, await findChannel(context, args.channel, true)));
      needs(context, P.ManageMessages, 'Manage Messages', channel);
      return { channel, amount: integer(args.amount, 'amount', 1, 100) };
    },
    run: async (context, { channel, amount }) => {
      const deleted = (await channel.bulkDelete(amount, true)).size;
      return { requested: amount, deleted, note: deleted < amount ? 'Messages older than 14 days cannot be bulk deleted.' : undefined };
    },
    describe: ({ channel, amount }) => `Delete the latest ${amount} messages in <#${channel.id}>`,
  }),

  definition('set_nickname', "Change a member's nickname", { member: MEMBER, nickname: field('New nickname') }, ['member', 'nickname'], {
    mutates: true,
    prepare: async (context, args) => {
      needs(context, P.ManageNicknames, 'Manage Nicknames');
      const member = await findMember(context, args.member);
      assertMember(context, member);
      return { member, nickname: text(args.nickname, 'nickname', 32) };
    },
    run: async (context, { member, nickname }) => {
      await member.setNickname(nickname, 'Requested through the Roland chatbot');
      return { nickname };
    },
    verify: async (context, { member, nickname }) => (await refetchMember(context, member.id))?.nickname === nickname,
    describe: ({ member, nickname }) => `Set the nickname of <@${member.id}> to "${nickname}"`,
  }),
  definition('reset_nickname', "Remove a member's nickname", { member: MEMBER }, ['member'], {
    mutates: true,
    prepare: async (context, args) => {
      needs(context, P.ManageNicknames, 'Manage Nicknames');
      const member = await findMember(context, args.member);
      assertMember(context, member);
      return { member };
    },
    run: async (context, { member }) => {
      await member.setNickname(null, 'Requested through the Roland chatbot');
      return { nickname: null };
    },
    verify: async (context, { member }) => !(await refetchMember(context, member.id))?.nickname,
    describe: ({ member }) => `Reset the nickname of <@${member.id}>`,
  }),
  definition('add_role', 'Give a role to a member', { member: MEMBER, role: ROLE }, ['member', 'role'], {
    mutates: true,
    prepare: async (context, args) => {
      needs(context, P.ManageRoles, 'Manage Roles');
      const role = findRole(context, args.role);
      assertRole(context, role);
      const member = await findMember(context, args.member);
      if (!isServerOwner(context, context.actor) && member.id !== context.actor.id && top(member) >= top(context.actor)) fail(`${nameOf(member)}'s highest role is at or above yours.`);
      if (member.roles.cache.has(role.id)) fail(`<@${member.id}> already has @${role.name}.`);
      return { member, role };
    },
    run: async (context, { member, role }) => {
      await member.roles.add(role.id, 'Requested through the Roland chatbot');
      return { added: role.name };
    },
    verify: async (context, { member, role }) => Boolean((await refetchMember(context, member.id))?.roles.cache.has(role.id)),
    describe: ({ member, role }) => `Add <@&${role.id}> to <@${member.id}>`,
  }),
  definition('remove_role', 'Remove a role from a member', { member: MEMBER, role: ROLE }, ['member', 'role'], {
    mutates: true,
    prepare: async (context, args) => {
      needs(context, P.ManageRoles, 'Manage Roles');
      const role = findRole(context, args.role);
      assertRole(context, role);
      const member = await findMember(context, args.member);
      if (!isServerOwner(context, context.actor) && member.id !== context.actor.id && top(member) >= top(context.actor)) fail(`${nameOf(member)}'s highest role is at or above yours.`);
      if (!member.roles.cache.has(role.id)) fail(`<@${member.id}> does not have @${role.name}.`);
      return { member, role };
    },
    run: async (context, { member, role }) => {
      await member.roles.remove(role.id, 'Requested through the Roland chatbot');
      return { removed: role.name };
    },
    verify: async (context, { member, role }) => (await refetchMember(context, member.id))?.roles.cache.has(role.id) === false,
    describe: ({ member, role }) => `Remove <@&${role.id}> from <@${member.id}>`,
  }),
  definition(
    'create_role',
    'Create a role without permissions',
    { name: field('Role name'), color: field('Hex color like #ff0000'), hoist: field('Show separately', 'boolean'), mentionable: field('Mentionable', 'boolean') },
    ['name'],
    {
      mutates: true,
      prepare: (context, args) => {
        needs(context, P.ManageRoles, 'Manage Roles');
        const color = text(args.color, 'color', 7, true);
        if (color && !COLOR.test(color)) fail('color must be a hex color like #ff0000.');
        return { name: text(args.name, 'name', 100), color: color && `#${color.replace('#', '')}`, hoist: flag(args.hoist), mentionable: flag(args.mentionable) };
      },
      run: async ({ guild }, { name, color, hoist, mentionable }) => {
        const role = await guild.roles.create({ name, color, hoist, mentionable, permissions: [], reason: 'Requested through the Roland chatbot' });
        return { role_id: role.id, name: role.name };
      },
      verify: ({ guild }, prepared, result) => guild.roles.cache.has(result.role_id),
      describe: ({ name }) => `Create the role "${name}"`,
    },
  ),
  definition(
    'edit_role',
    "Change a role's name, color or display",
    { role: ROLE, name: field('New name'), color: field('Hex color'), hoist: field('Show separately', 'boolean'), mentionable: field('Mentionable', 'boolean') },
    ['role'],
    {
      mutates: true,
      prepare: (context, args) => {
        needs(context, P.ManageRoles, 'Manage Roles');
        const role = findRole(context, args.role);
        assertRole(context, role);
        const color = text(args.color, 'color', 7, true);
        if (color && !COLOR.test(color)) fail('color must be a hex color like #ff0000.');
        const changes = Object.fromEntries(
          Object.entries({ name: text(args.name, 'name', 100, true), color: color && `#${color.replace('#', '')}`, hoist: flag(args.hoist), mentionable: flag(args.mentionable) }).filter(([, value]) => value !== undefined),
        );
        if (!Object.keys(changes).length) fail('Nothing to change was given.');
        return { role, changes };
      },
      run: async (context, { role, changes }) => {
        await role.edit({ ...changes, reason: 'Requested through the Roland chatbot' });
        return { role_id: role.id, changed: Object.keys(changes) };
      },
      verify: ({ guild }, { role, changes }) => !changes.name || guild.roles.cache.get(role.id)?.name === changes.name,
      describe: ({ role, changes }) => `Edit <@&${role.id}> (${Object.keys(changes).join(', ')})`,
    },
  ),
  definition('delete_role', 'Delete a role', { role: ROLE }, ['role'], {
    mutates: true,
    prepare: (context, args) => {
      needs(context, P.ManageRoles, 'Manage Roles');
      const role = findRole(context, args.role);
      assertRole(context, role);
      return { role };
    },
    run: async (context, { role }) => {
      await role.delete('Requested through the Roland chatbot');
      return { deleted: role.name };
    },
    verify: ({ guild }, { role }) => !guild.roles.cache.has(role.id),
    describe: ({ role }) => `Delete the role @${role.name} (${role.id})`,
  }),

  definition(
    'create_channel',
    'Create a channel',
    { name: field('Channel name'), type: field('text, voice or category'), parent: field('Category ID or name'), topic: field('Topic') },
    ['name'],
    {
      mutates: true,
      prepare: async (context, args) => {
        needs(context, P.ManageChannels, 'Manage Channels');
        const type = CHANNEL_TYPES[String(args.type ?? 'text').toLowerCase()] ?? fail('type must be text, voice or category.');
        const parent = args.parent ? await findChannel(context, args.parent) : null;
        if (parent && parent.type !== ChannelType.GuildCategory) fail(`#${parent.name} is not a category.`);
        if (parent) needs(context, P.ManageChannels, 'Manage Channels', parent);
        return { name: text(args.name, 'name', 100), type, parent, topic: text(args.topic, 'topic', 1024, true) };
      },
      run: async ({ guild }, { name, type, parent, topic }) => {
        const channel = await guild.channels.create({ name, type, parent: parent?.id, topic, reason: 'Requested through the Roland chatbot' });
        return { channel_id: channel.id, name: channel.name };
      },
      verify: ({ guild }, prepared, result) => guild.channels.cache.has(result.channel_id),
      describe: ({ name, type }) => `Create the ${ChannelType[type]} channel "${name}"`,
    },
  ),
  definition('edit_channel', "Change a channel's name, topic or NSFW flag", { channel: CHANNEL, name: field('New name'), topic: field('New topic'), nsfw: field('NSFW', 'boolean') }, ['channel'], {
    mutates: true,
    prepare: async (context, args) => {
      const channel = visible(context, await findChannel(context, args.channel, true));
      needs(context, P.ManageChannels, 'Manage Channels', channel);
      const changes = Object.fromEntries(
        Object.entries({ name: text(args.name, 'name', 100, true), topic: text(args.topic, 'topic', 1024, true), nsfw: flag(args.nsfw) }).filter(([, value]) => value !== undefined),
      );
      if (!Object.keys(changes).length) fail('Nothing to change was given.');
      return { channel, changes };
    },
    run: async (context, { channel, changes }) => {
      await channel.edit({ ...changes, reason: 'Requested through the Roland chatbot' });
      return { channel_id: channel.id, changed: Object.keys(changes) };
    },
    verify: ({ guild }, { channel, changes }) => !changes.name || guild.channels.cache.get(channel.id)?.name === changes.name,
    describe: ({ channel, changes }) => `Edit <#${channel.id}> (${Object.keys(changes).join(', ')})`,
  }),
  definition('delete_channel', 'Delete a channel', { channel: CHANNEL }, ['channel'], {
    mutates: true,
    prepare: async (context, args) => {
      const channel = visible(context, await findChannel(context, args.channel));
      if (channel.id === context.channel.id) fail('Roland will not delete the channel of this chatbot session.');
      if (context.access !== ACCESS.SERVER_OWNER && channel.id === guildSettings.get(context.guild.id)?.log_channel_id) fail('Only the server owner can delete the log channel through the chatbot.');
      needs(context, P.ManageChannels, 'Manage Channels', channel);
      return { channel };
    },
    run: async (context, { channel }) => {
      await channel.delete('Requested through the Roland chatbot');
      return { deleted: channel.name };
    },
    verify: async ({ guild }, { channel }) => !guild.channels.cache.has(channel.id),
    describe: ({ channel }) => `Delete the channel #${channel.name} (${channel.id})`,
  }),
  definition(
    'set_channel_permissions',
    'Allow or deny channel permissions for a role or member',
    {
      channel: CHANNEL,
      target: field('Role or member ID, mention or name; "everyone" for @everyone'),
      allow: { type: 'array', items: { type: 'string', enum: SAFE_OVERWRITES }, description: 'Permissions to allow' },
      deny: { type: 'array', items: { type: 'string', enum: SAFE_OVERWRITES }, description: 'Permissions to deny' },
    },
    ['channel', 'target'],
    {
      mutates: true,
      prepare: async (context, args) => {
        const channel = visible(context, await findChannel(context, args.channel, true));
        needs(context, P.ManageRoles, 'Manage Permissions', channel);
        const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(String);
        const allow = list(args.allow);
        const deny = list(args.deny);
        const unsafe = [...allow, ...deny].filter((name) => !SAFE_OVERWRITES.includes(name));
        if (unsafe.length) fail(`These permissions cannot be changed through the chatbot: ${unsafe.join(', ')}.`);
        if (!allow.length && !deny.length) fail('No permission to allow or deny was given.');
        if (allow.some((name) => deny.includes(name))) fail('A permission cannot be allowed and denied at once.');
        const owner = isServerOwner(context, context.actor);
        const missing = [...allow, ...deny].filter((name) => !allowed(context.me, P[name], channel) || (!owner && !allowed(context.actor, P[name], channel)));
        if (missing.length) fail(`${owner ? 'Roland needs' : 'You and Roland both need'} these permissions in #${channel.name} to change them: ${missing.join(', ')}.`);
        let target;
        if (label(args.target) === 'everyone') target = { id: context.guild.id, name: '@everyone', role: true };
        else {
          const roleId = idFrom(args.target);
          const roles = roleId ? [context.guild.roles.cache.get(roleId)].filter(Boolean) : [...context.guild.roles.cache.values()].filter((entry) => entry.name?.toLowerCase() === label(args.target));
          if (roles.length > 1) fail(`More than one role matches "${args.target}". Use its ID.`);
          const [role] = roles;
          if (role) {
            if (role.id !== context.guild.id && !owner) {
              if (role.position >= top(context.actor)) fail(`@${role.name} is at or above your highest role.`);
              if (STAFF_ROLES.has(role.id) || role.permissions?.has?.(P.Administrator)) fail(`@${role.name} is a protected staff role; only the server owner can change its permissions through the chatbot.`);
            }
            target = { id: role.id, name: role.id === context.guild.id ? '@everyone' : `<@&${role.id}>`, role: true };
          } else {
            const member = await findMember(context, args.target);
            if (!owner && member.id !== context.actor.id && (member.id === context.guild.ownerId || top(member) >= top(context.actor))) fail(`${nameOf(member)}'s highest role is at or above yours.`);
            target = { id: member.id, name: `<@${member.id}>`, role: false };
          }
        }
        return { channel, target, allow, deny };
      },
      run: async (context, { channel, target, allow, deny }) => {
        const changes = Object.fromEntries([...allow.map((name) => [name, true]), ...deny.map((name) => [name, false])]);
        await channel.permissionOverwrites.edit(target.id, changes, { reason: 'Requested through the Roland chatbot' });
        return { channel_id: channel.id, target: target.name, allowed: allow, denied: deny };
      },
      verify: async (context, { channel, target, allow, deny }) => {
        const overwrite = await freshOverwrite(context, channel, target.id);
        return Boolean(overwrite) && allow.every((name) => overwrite.allow.has(P[name])) && deny.every((name) => overwrite.deny.has(P[name]));
      },
      describe: ({ channel, target, allow, deny }) =>
        `Change permissions of ${target.name} in <#${channel.id}>${allow.length ? ` — allow ${allow.join(', ')}` : ''}${deny.length ? ` — deny ${deny.join(', ')}` : ''}`,
    },
  ),
  ...[
    ['lock_channel', 'Stop @everyone from sending messages in a channel', false, 'Lock'],
    ['unlock_channel', 'Let @everyone send messages in a channel again', null, 'Unlock'],
  ].map(([name, description, value, verb]) =>
    definition(name, description, { channel: CHANNEL }, ['channel'], {
      mutates: true,
      prepare: async (context, args) => {
        const channel = textChannel(visible(context, await findChannel(context, args.channel, true)));
        needs(context, P.ManageChannels, 'Manage Channels', channel);
        needs(context, P.ManageRoles, 'Manage Permissions', channel);
        needs(context, P.SendMessages, 'Send Messages', channel);
        return { channel };
      },
      run: async ({ guild }, { channel }) => {
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: value }, { reason: 'Requested through the Roland chatbot' });
        return { channel_id: channel.id, locked: value === false };
      },
      verify: async (context, { channel }) => {
        const denied = Boolean((await freshOverwrite(context, channel, context.guild.id))?.deny?.has(P.SendMessages));
        return value === false ? denied : !denied;
      },
      describe: ({ channel }) => `${verb} <#${channel.id}>`,
    }),
  ),
  definition('set_slowmode', 'Set the slowmode of a channel', { channel: CHANNEL, seconds: field('Seconds between messages (0-21600)', 'integer') }, ['channel', 'seconds'], {
    mutates: true,
    prepare: async (context, args) => {
      const channel = textChannel(visible(context, await findChannel(context, args.channel, true)));
      needs(context, P.ManageChannels, 'Manage Channels', channel);
      return { channel, seconds: integer(args.seconds, 'seconds', 0, 21600) };
    },
    run: async (context, { channel, seconds }) => {
      await channel.setRateLimitPerUser(seconds, 'Requested through the Roland chatbot');
      return { channel_id: channel.id, seconds };
    },
    verify: ({ guild }, { channel, seconds }) => (guild.channels.cache.get(channel.id) ?? channel).rateLimitPerUser === seconds,
    describe: ({ channel, seconds }) => `Set the slowmode of <#${channel.id}> to ${seconds}s`,
  }),

  definition('warn_member', 'Warn a member (creates a moderation case)', { member: MEMBER, reason: REASON }, ['member', 'reason'], {
    mutates: true,
    prepare: async (context, args) => {
      level(context, permissions.Level.MODERATOR, 'warn');
      const target = await moderationTarget(context, args.member);
      permissions.assertCanModerate(context.actor, target);
      return { target, reason: text(args.reason, 'reason', 500) };
    },
    run: async (context, { target, reason }) => ({ case_number: (await moderation.warn({ guild: context.guild, moderator: context.actor, target, reason, channelId: context.channel.id })).record.case_number }),
    describe: ({ target, reason }) => `Warn <@${target.user.id}> — ${reason}`,
  }),
  ...['mute_member', 'timeout_member'].map((name) =>
    definition(name, 'Time out a member (creates a moderation case)', { member: MEMBER, duration: field('Duration like 10m, 2h or 1d (max 28d)'), reason: REASON }, ['member', 'duration', 'reason'], {
      mutates: true,
      prepare: async (context, args) => {
        level(context, permissions.Level.MODERATOR, 'mute');
        if (!allowed(context.me, P.ModerateMembers)) fail('Roland does not have the Timeout Members permission.');
        const target = await moderationTarget(context, args.member);
        permissions.assertCanModerate(context.actor, target);
        assertMember(context, target.member, { self: false });
        if (target.member.isCommunicationDisabled?.()) fail(`<@${target.user.id}> is already timed out.`);
        return { target, duration: text(args.duration, 'duration', 20), reason: text(args.reason, 'reason', 500) };
      },
      run: async (context, { target, duration, reason }) => ({
        case_number: (await moderation.mute({ guild: context.guild, moderator: context.actor, target, duration, reason, channelId: context.channel.id })).record.case_number,
      }),
      recheck: true,
      verify: async (context, { target }) => Boolean((await refetchMember(context, target.user.id))?.isCommunicationDisabled?.()),
      describe: ({ target, duration, reason }) => `Time out <@${target.user.id}> for ${duration} — ${reason}`,
    }),
  ),
  definition('kick_member', 'Kick a member (server owner only)', { member: MEMBER, reason: REASON }, ['member', 'reason'], {
    mutates: true,
    prepare: async (context, args) => {
      level(context, permissions.Level.SENIOR_MODERATOR, 'kick');
      if (!allowed(context.me, P.KickMembers)) fail('Roland does not have the Kick Members permission.');
      const target = await moderationTarget(context, args.member);
      permissions.assertCanModerate(context.actor, target);
      assertMember(context, target.member, { self: false });
      return { target, reason: text(args.reason, 'reason', 500) };
    },
    run: async (context, { target, reason }) => ({ case_number: (await moderation.kick({ guild: context.guild, moderator: context.actor, target, reason, channelId: context.channel.id })).record.case_number }),
    recheck: true,
    verify: async (context, { target }) => !(await refetchMember(context, target.user.id)),
    describe: ({ target, reason }) => `Kick <@${target.user.id}> — ${reason}`,
  }),
  definition('ban_member', 'Ban a user (server owner only)', { user: field('User ID or mention'), duration: field('Duration like 7d, or forever'), reason: REASON }, ['user', 'reason'], {
    mutates: true,
    prepare: async (context, args) => {
      level(context, permissions.Level.SENIOR_MODERATOR, 'ban');
      if (!allowed(context.me, P.BanMembers)) fail('Roland does not have the Ban Members permission.');
      const target = await userTarget(context, args.user);
      permissions.assertCanModerate(context.actor, target);
      if (target.member) assertMember(context, target.member, { self: false });
      if (await isBanned(context, target.user.id)) fail(`<@${target.user.id}> is already banned.`);
      return { target, duration: text(args.duration, 'duration', 20, true) ?? 'forever', reason: text(args.reason, 'reason', 500) };
    },
    run: async (context, { target, duration, reason }) => ({
      case_number: (await moderation.ban({ guild: context.guild, moderator: context.actor, target, duration, reason, channelId: context.channel.id })).record.case_number,
    }),
    recheck: true,
    verify: (context, { target }) => isBanned(context, target.user.id),
    describe: ({ target, duration, reason }) => `Ban <@${target.user.id}> (${duration}) — ${reason}`,
  }),
  definition('unban_member', 'Unban a user (server owner only)', { user: field('User ID or mention'), reason: REASON }, ['user', 'reason'], {
    mutates: true,
    prepare: async (context, args) => {
      level(context, permissions.Level.SENIOR_MODERATOR, 'unban');
      if (!allowed(context.me, P.BanMembers)) fail('Roland does not have the Ban Members permission.');
      const target = await userTarget(context, args.user);
      if (!(await isBanned(context, target.user.id))) fail(`<@${target.user.id}> is not banned.`);
      return { target, reason: text(args.reason, 'reason', 500) };
    },
    run: async (context, { target, reason }) => ({ case_number: (await moderation.unban({ guild: context.guild, moderator: context.actor, target, reason, channelId: context.channel.id })).case_number }),
    recheck: true,
    verify: async (context, { target }) => !(await isBanned(context, target.user.id)),
    describe: ({ target, reason }) => `Unban <@${target.user.id}> — ${reason}`,
  }),
  definition('clear_messages', 'Delete recent messages, optionally only from one member (creates a case when targeted)', { channel: CHANNEL, amount: field('How many (1-100)', 'integer'), member: MEMBER }, ['amount'], {
    mutates: true,
    uncertain: true,
    prepare: async (context, args) => {
      level(context, permissions.Level.MODERATOR, 'clear');
      const channel = textChannel(visible(context, await findChannel(context, args.channel, true)));
      needs(context, P.ManageMessages, 'Manage Messages', channel);
      const target = args.member ? await moderationTarget(context, args.member) : null;
      if (target) permissions.assertCanModerate(context.actor, target);
      return { channel, amount: integer(args.amount, 'amount', 1, 100), target };
    },
    run: async (context, { channel, amount, target }) => {
      const record = await moderation.clear({ guild: context.guild, moderator: context.actor, channel, amount, target });
      return { deleted: record.metadata?.deleted ?? 0, case_number: record.case_number ?? null };
    },
    describe: ({ channel, amount, target }) => `Clear ${amount} messages in <#${channel.id}>${target ? ` from <@${target.user.id}>` : ''}`,
  }),
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

const get = (name) => byName.get(name) ?? null;

const definitionsFor = (access) =>
  TOOLS.filter((tool) => canExecuteChatbotAction(access, tool.name)).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: { type: 'object', properties: tool.properties, required: tool.required } },
  }));

const prepare = async (context, name, args) => {
  const tool = get(name) ?? fail(`There is no tool called ${name}.`);
  if (!canExecuteChatbotAction(context.access, name)) fail(`Only the server owner can use ${name} through the chatbot.`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail(`The arguments for ${name} are invalid.`);
  return { tool, prepared: await tool.prepare(context, args) };
};

const appliedDespite = async (context, tool, prepared) => {
  if (!tool.recheck) return false;
  try {
    return Boolean(await tool.verify(context, prepared));
  } catch (error) {
    console.error(`Chatbot could not check ${tool.name} after it failed: ${error.message}`);
    return false;
  }
};

const execute = async (context, tool, prepared) => {
  let result;
  try {
    result = await tool.run(context, prepared);
  } catch (error) {
    if (error instanceof UserError || error instanceof ToolError) throw error;
    if (tool.uncertain) throw new ToolError(`It stopped with an error and part of it may already be done: ${describeError(error)}`, 'unknown', error);
    if (!isDiscordError(error) && (await appliedDespite(context, tool, prepared))) throw new ToolError(`Discord applied it, but a later step failed: ${describeError(error)}`, 'partial', error);
    throw error;
  }
  if (!tool.verify) return result;
  let confirmed;
  try {
    confirmed = await tool.verify(context, prepared, result);
  } catch (error) {
    throw new ToolError(`${tool.name} ran, but Roland could not check the result: ${describeError(error)}`, 'unknown', error);
  }
  if (!confirmed) throw new ToolError(`Discord did not confirm the change after ${tool.name}, so it may not have been applied.`, 'unknown');
  return result;
};

module.exports = { ToolError, TOOLS, SAFE_OVERWRITES, get, definitionsFor, prepare, execute, describeError, isExpected };
