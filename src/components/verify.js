const verification = require('../services/verification');
const { UserError } = require('../utils/errors');

module.exports = {
  prefix: 'verify',
  async execute(interaction) {
    const [, action, mode] = interaction.customId.split(':');
    if (action === 'start') return verification.start(interaction);
    if (action === 'check') return verification.start(interaction, { replace: mode === 'relink', update: true });
    throw new UserError('This button is no longer supported.');
  },
};
