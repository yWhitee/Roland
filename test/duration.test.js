const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, assertTimeout, formatDuration } = require('../src/utils/duration');
const { UserError } = require('../src/utils/errors');

const FROM = Date.UTC(2026, 0, 31, 12, 0, 0);
const iso = (input, from = FROM) => new Date(parseDuration(input, from).expiresAt).toISOString();

test('unidades fixas: 30s, 30m, 30h, 30d, 30w', () => {
  const cases = { '30s': 30_000, '30m': 1_800_000, '30h': 108_000_000, '30d': 2_592_000_000, '30w': 18_144_000_000 };
  for (const [input, ms] of Object.entries(cases)) {
    const result = parseDuration(input, FROM);
    assert.equal(result.forever, false);
    assert.equal(result.ms, ms, input);
    assert.equal(result.expiresAt, FROM + ms, input);
    assert.equal(result.input, input);
  }
});

test('m é minuto e mm é mês', () => {
  assert.equal(parseDuration('1m', FROM).ms, 60_000);
  assert.equal(iso('1mm'), '2026-02-28T12:00:00.000Z');
  assert.equal(parseDuration('30m', FROM).ms, 30 * 60_000);
  assert.equal(iso('30mm'), '2028-07-31T12:00:00.000Z');
  assert.equal(formatDuration('30m'), '30 minutos');
  assert.equal(formatDuration('30mm'), '30 meses');
});

test('meses e anos usam o calendário', () => {
  assert.equal(iso('1mm', Date.UTC(2028, 0, 31)), '2028-02-29T00:00:00.000Z');
  assert.equal(iso('1mm', Date.UTC(2026, 2, 15)), '2026-04-15T00:00:00.000Z');
  assert.equal(iso('30y'), '2056-01-31T12:00:00.000Z');
  assert.equal(iso('1y', Date.UTC(2028, 1, 29)), '2029-02-28T00:00:00.000Z');
});

test('forever não possui término', () => {
  assert.deepEqual(parseDuration('forever', FROM), { input: 'forever', forever: true, expiresAt: null, ms: null });
  assert.equal(formatDuration('forever'), 'Permanente');
});

test('rejeita durações inválidas', () => {
  for (const input of ['', '30', 'd', '0d', '-5d', '1.5h', '30x', '30 d', '30mmm', 'forevers', '99999999999999999999y']) {
    assert.throws(() => parseDuration(input, FROM), UserError, input);
  }
});

test('limite do Discord para mute (28 dias)', () => {
  assert.doesNotThrow(() => assertTimeout(parseDuration('28d', FROM)));
  assert.doesNotThrow(() => assertTimeout(parseDuration('4w', FROM)));
  assert.doesNotThrow(() => assertTimeout(parseDuration('30s', FROM)));
  assert.throws(() => assertTimeout(parseDuration('29d', FROM)), UserError);
  assert.throws(() => assertTimeout(parseDuration('1mm', Date.UTC(2026, 2, 1))), UserError);
  assert.throws(() => assertTimeout(parseDuration('1y', FROM)), UserError);
  assert.throws(() => assertTimeout(parseDuration('forever', FROM)), UserError);
});

test('formatação no singular e plural', () => {
  assert.equal(formatDuration('1s'), '1 segundo');
  assert.equal(formatDuration('1mm'), '1 mês');
  assert.equal(formatDuration('2y'), '2 anos');
  assert.equal(formatDuration('1w'), '1 semana');
});
