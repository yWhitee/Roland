const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { Automod } = require('../permissions');
const automod = require('../services/automod');
const { byId, choices } = require('../services/automod/functions');
const { successEmbed } = require('../utils/embeds');
const { UserError } = require('../utils/errors');

module.exports = {
  level: Automod.CONFIGURE,
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Enable or disable an AutoMod function')
    .addStringOption((option) => option.setName('function').setDescription('AutoMod Function ID').setRequired(true).addChoices(...choices()))
    .addStringOption((option) =>
      option
        .setName('state')
        .setDescription('Turn the function on or off')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const fn = byId.get(interaction.options.getString('function', true));
    if (!fn) throw new UserError('Unknown AutoMod function. Use /automodlist to see the available Function IDs.');

    const enabled = interaction.options.getString('state', true) === 'on';
    const warning = await automod.setEnabled(interaction.guild, fn.id, enabled, interaction.user.id);
    const lines = [`**${fn.name}** (\`${fn.id}\`) is now **${enabled ? 'ENABLED' : 'DISABLED'}**.`];
    if (warning) lines.push('', `⚠️ ${warning}`);
    await interaction.editReply({ embeds: [successEmbed(lines.join('\n'))] });
  },
};
