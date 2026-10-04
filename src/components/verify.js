const verification = require('../services/verification');
const { UserError } = require('../utils/errors');

module.exports = {
  prefix: 'verify',
  async execute(interaction) {
    const [, action] = interaction.customId.split(':');
    if (action !== 'start') throw new UserError('This button is no longer supported.');
    await verification.start(interaction);
  },
};
