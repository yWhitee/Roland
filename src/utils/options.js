const user = (required = true) => (option) => option.setName('user').setDescription('User mention or ID').setRequired(required);

const reason = (option) => option.setName('reason').setDescription('Reason for this action').setRequired(true).setMaxLength(500);

const duration = (description) => (option) => option.setName('duration').setDescription(description).setRequired(true).setMaxLength(20);

module.exports = { user, reason, duration };
