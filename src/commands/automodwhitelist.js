const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const automodWhitelist = require('../database/automodWhitelist');
const { Automod } = require('../permissions');
const { byId, choices } = require('../services/automod/functions');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  level: Automod.CONFIGURE,
  data: new SlashCommandBuilder()
    .setName('automodwhitelist')
    .setDescription('Let a user or role bypass one AutoMod function')
    .addMentionableOption((option) => option.setName('target').setDescription('User or role').setRequired(true))
    .addStringOption((option) => option.setName('function').setDescription('AutoMod Function ID').setRequired(true).addChoices(...choices()))
    .addStringOption((option) =>
      option
        .setName('state')
        .setDescription('Add (on) or remove (off) the bypass. Defaults to on.')
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const fn = byId.get(interaction.options.getString('function', true));
    if (!fn) throw new UserError('Unknown AutoMod function. Use /automodlist to see the available Function IDs.');

    const option = interaction.options.get('target', true);
    const target = option.role ? { targetType: 'role', targetId: option.role.id } : option.user ? { targetType: 'user', targetId: option.user.id } : null;
    if (!target) throw new UserError('Choose a user or a role.');
    const label = target.targetType === 'role' ? `<@&${target.targetId}>` : `<@${target.targetId}>`;
    const entry = { guildId: interaction.guildId, functionId: fn.id, ...target };

    if ((interaction.options.getString('state') ?? 'on') === 'off') {
      if (!automodWhitelist.remove(entry)) throw new UserError(`${label} is not whitelisted for **${fn.name}** (\`${fn.id}\`).`);
      return interaction.editReply({ embeds: [successEmbed(`${label} no longer bypasses **${fn.name}** (\`${fn.id}\`).`)] });
    }

    if (!automodWhitelist.add({ ...entry, createdBy: interaction.user.id })) {
      throw new UserError(`${label} is already whitelisted for **${fn.name}** (\`${fn.id}\`).`);
    }
    return interaction.editReply({ embeds: [successEmbed(`${label} now bypasses **${fn.name}** (\`${fn.id}\`). Other AutoMod functions still apply.`)] });
  },
};
