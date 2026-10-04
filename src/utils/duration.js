const { UserError } = require('./errors');

const UNITS = {
  s: { ms: 1_000, names: ['second', 'seconds'] },
  m: { ms: 60_000, names: ['minute', 'minutes'] },
  h: { ms: 3_600_000, names: ['hour', 'hours'] },
  d: { ms: 86_400_000, names: ['day', 'days'] },
  w: { ms: 604_800_000, names: ['week', 'weeks'] },
  mm: { months: 1, names: ['month', 'months'] },
  y: { months: 12, names: ['year', 'years'] },
};

const PATTERN = /^(\d+)(mm|[smhdwy])$/;
const MAX_DATE = 8_640_000_000_000_000;
const MAX_TIMEOUT = 28 * UNITS.d.ms;

// Months and years follow the UTC calendar: the day of month is kept and clamped to the last day of the target month (Jan 31 + 1mm = Feb 28 or 29).
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
  if (!match) throw new UserError('Invalid duration. Use a whole number followed by s, m, h, d, w, mm or y (e.g. 30m, 7d, 1mm), or forever.');

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new UserError('The duration must be a positive whole number.');

  const unit = UNITS[match[2]];
  const expiresAt = unit.months ? addMonths(from, amount * unit.months) : from + amount * unit.ms;
  if (!(expiresAt <= MAX_DATE)) throw new UserError('The duration is too long.');

  return { input: `${amount}${match[2]}`, forever: false, expiresAt, ms: expiresAt - from };
};

const assertTimeout = (duration) => {
  if (duration.forever) throw new UserError('A mute cannot be permanent. Discord limits timeouts to 28 days.');
  if (duration.ms > MAX_TIMEOUT) throw new UserError('The duration exceeds the Discord timeout limit of 28 days.');
};

const formatDuration = (input) => {
  if (input === 'forever') return 'Permanent';
  const match = input?.match(PATTERN);
  if (!match) return input;
  const amount = Number(match[1]);
  return `${amount} ${UNITS[match[2]].names[amount === 1 ? 0 : 1]}`;
};

module.exports = { parseDuration, assertTimeout, formatDuration, MAX_TIMEOUT };
