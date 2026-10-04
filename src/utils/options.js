const user = (required = true) => (option) => option.setName('usuario').setDescription('Menção ou ID do usuário').setRequired(required);

const reason = (option) => option.setName('motivo').setDescription('Motivo da ação').setRequired(true).setMaxLength(500);

const duration = (description) => (option) => option.setName('tempo').setDescription(description).setRequired(true).setMaxLength(20);

module.exports = { user, reason, duration };
