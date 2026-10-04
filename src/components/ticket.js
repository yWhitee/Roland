const tickets = require('../services/tickets');
const { UserError } = require('../utils/errors');

const ACTIONS = {
  open: tickets.promptOpen,
  form: tickets.open,
  claim: tickets.claim,
  close: tickets.close,
  delete: tickets.remove,
};

module.exports = {
  prefix: 'ticket',
  async execute(interaction) {
    const [, action, id] = interaction.customId.split(':');
    const handler = ACTIONS[action];
    if (!handler) throw new UserError('This button is no longer supported.');
    await handler(interaction, id);
  },
};
