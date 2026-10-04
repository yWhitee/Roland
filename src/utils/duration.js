const { UserError } = require('./errors');

const UNITS = {
  s: { ms: 1_000, names: ['segundo', 'segundos'] },
  m: { ms: 60_000, names: ['minuto', 'minutos'] },
  h: { ms: 3_600_000, names: ['hora', 'horas'] },
  d: { ms: 86_400_000, names: ['dia', 'dias'] },
  w: { ms: 604_800_000, names: ['semana', 'semanas'] },
  mm: { months: 1, names: ['mês', 'meses'] },
  y: { months: 12, names: ['ano', 'anos'] },
};

const PATTERN = /^(\d+)(mm|[smhdwy])$/;
const MAX_DATE = 8_640_000_000_000_000;
const MAX_TIMEOUT = 28 * UNITS.d.ms;

// Meses e anos seguem o calendário em UTC: mantém o dia e limita ao último dia do mês de destino (31/01 + 1mm = 28/02 ou 29/02).
const addMonths = (from, months) => {
  const date = new Date(from);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
};

const parseDuration = (input, from = Date.now()) => {
  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'forever') return { input: 'forever', forever: true, expiresAt: null, ms: null };

  const match = value.match(PATTERN);
  if (!match) throw new UserError('Duração inválida. Use um número inteiro seguido de s, m, h, d, w, mm ou y (ex: 30m, 7d, 1mm) ou forever.');

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new UserError('A duração deve ser um número inteiro positivo.');

  const unit = UNITS[match[2]];
  const expiresAt = unit.months ? addMonths(from, amount * unit.months) : from + amount * unit.ms;
  if (!(expiresAt <= MAX_DATE)) throw new UserError('Duração longa demais.');

  return { input: `${amount}${match[2]}`, forever: false, expiresAt, ms: expiresAt - from };
};

const assertTimeout = (duration) => {
  if (duration.forever) throw new UserError('O mute não pode ser permanente. O limite do Discord é de 28 dias.');
  if (duration.ms > MAX_TIMEOUT) throw new UserError('A duração excede o limite do Discord de 28 dias para mute.');
};

const formatDuration = (input) => {
  if (input === 'forever') return 'Permanente';
  const match = input?.match(PATTERN);
  if (!match) return input;
  const amount = Number(match[1]);
  return `${amount} ${UNITS[match[2]].names[amount === 1 ? 0 : 1]}`;
};

module.exports = { parseDuration, assertTimeout, formatDuration, MAX_TIMEOUT };
