const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder } = require('discord.js');
const embedBuilder = require('../src/services/embedBuilder');
const jsonImport = require('../src/services/embedBuilder/jsonImport');
const sessions = require('../src/services/embedBuilder/sessions');
const levels = require('../src/services/levels/messages');
const tickets = require('../src/services/tickets/messages');
const verification = require('../src/services/verification/messages');
const automod = require('../src/services/automod/messages');
const { ACTIONS, Colors, DEFAULT_EMBED_COLOR, caseEmbed, errorEmbed, recordEmbed, successEmbed } = require('../src/utils/embeds');

const ORANGE = 0xff7b00;
const colorOf = (embed) => (embed instanceof EmbedBuilder ? embed.toJSON() : embed).color;

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

test('the default embed color is #FF7B00 and every other color keeps its value', () => {
  assert.equal(DEFAULT_EMBED_COLOR, ORANGE);
  assert.equal(Colors.info, ORANGE);
  assert.deepEqual({ error: Colors.error, success: Colors.success, warning: Colors.warning }, { error: 0xed4245, success: 0x57f287, warning: 0xfee75c });
  assert.deepEqual(Object.fromEntries(Object.entries(ACTIONS).map(([type, action]) => [type, action.color])), {
    ban: 0xed4245,
    kick: 0xe67e22,
    mute: 0xfee75c,
    warn: 0xf1c40f,
    unban: 0x57f287,
    unmute: 0x57f287,
    clear: 0x5865f2,
  });
  assert.equal(verification.PANEL.color, '#335FFF');
});

test('every embed Roland builds sets a color, so none falls back to Discord without one', () => {
  const missing = [];
  for (const file of sources(path.join(__dirname, '../src'))) {
    const code = fs.readFileSync(file, 'utf8');
    for (const match of code.matchAll(/new EmbedBuilder\(\)(?!\s*\.setColor\()/g)) {
      missing.push(`${path.relative(path.join(__dirname, '..'), file)}:${code.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(
    sources(path.join(__dirname, '../src')).filter((file) => /0x5865f2/i.test(fs.readFileSync(file, 'utf8'))).map((file) => path.basename(file)),
    ['embeds.js'],
    'the old blue only remains as the explicit color of Clear cases',
  );
});

test('embed builder embeds without a chosen color use the default, chosen colors are kept', async () => {
  assert.equal(colorOf(sessions.toEmbed({ ...sessions.emptyState(), title: 'No color' })), ORANGE);
  assert.equal(colorOf(sessions.toEmbed({ ...sessions.emptyState(), title: 'Blue', color: '#5865F2' })), 0x5865f2);
  assert.equal(colorOf(sessions.toEmbed({ ...sessions.emptyState(), title: 'Red', color: 'FF0000' })), 0xff0000);
  assert.equal(colorOf(sessions.toEmbed(jsonImport.parse('{"embed":{"title":"Imported"}}'))), ORANGE);
  assert.equal(colorOf(sessions.toEmbed(jsonImport.paste('{"embed":{"title":"Pasted","color":"#00ff00"}}').state)), 0x00ff00);

  const start = { id: `colors-${Date.now()}`, user: { id: '1' }, reply: async (payload) => (start.panel = payload) };
  await embedBuilder.start(start, { prefix: 'embed' });
  assert.equal(colorOf(start.panel.embeds[0]), ORANGE, 'the empty editor preview');

  const sent = [];
  const channel = { id: 'c', isTextBased: () => true, toString: () => '<#c>', permissionsFor: () => ({ has: () => true }), send: async (payload) => sent.push(payload) };
  const action = (name, extra = {}) => ({
    customId: `embed:${start.id}:${name}`,
    user: { id: '1' },
    values: [],
    fields: { getTextInputValue: (key) => extra.values?.[key] ?? '' },
    update: async () => {},
    ...extra.props,
  });
  await embedBuilder.handle(action('modal:body', { values: { title: 'Announcement' } }));
  await embedBuilder.handle(action('channel', { props: { values: ['c'], member: {}, guild: { channels: { fetch: async () => channel } } } }));
  assert.equal(colorOf(sent[0].embeds[0]), ORANGE, 'a sent embed without a chosen color');
});

test('verification, ticket, moderation and system embeds use the default unless they mean something else', () => {
  const ticket = { id: 1, number: 7, channel_id: '2', creator_id: '3', roblox_username: 'player', reason: 'help', created_at: 1, claimed_by: '4', claimed_at: 2, closed_by: '4', closed_at: 3, deleted_by: '4', deleted_at: 4 };
  const verified = { discord_id: '5', roblox_id: '6', roblox_username: 'player', verified_at: 1 };
  const record = (type) => ({ type, case_number: 1, user_id: '5', moderator_id: '6', created_at: 1, reason: 'r' });

  const defaults = {
    'verification consent': verification.consentMessage(['x']).embeds[0],
    'verification link': verification.linkMessage(['x']).embeds[0],
    'already verified': verification.alreadyVerifiedEmbed(verified),
    'verification info': verification.infoEmbed({ id: '5' }, verified),
    'ticket opened': tickets.infoEmbed(ticket),
    'ticket created log': tickets.logEmbed(ticket, 'created'),
    'level profile': levels.profileEmbed({ id: '5' }, { level: 1, xp: 2 }),
    leaderboard: levels.leaderboardEmbed([]),
    'level set log': levels.levelSetEmbed({ id: '6' }, { id: '5' }, { level: 1, xp: 1 }, { level: 2, xp: 2 }),
    'automod list': automod.listPage(0, new Set(), { users: [], roles: [], channels: [] }).embeds[0],
  };
  for (const [name, embed] of Object.entries(defaults)) assert.equal(colorOf(embed), ORANGE, name);

  const explicit = {
    'verification panel': [verification.panelEmbed(), 0x335fff],
    'verification success': [verification.resultEmbed({ title: 't', lines: ['x'], success: true }), Colors.success],
    'verification failure': [verification.resultEmbed({ title: 't', lines: ['x'], success: false }), Colors.error],
    'ticket claimed log': [tickets.logEmbed(ticket, 'claimed'), Colors.success],
    'ticket closed log': [tickets.logEmbed(ticket, 'closed'), Colors.warning],
    'ticket deleted log': [tickets.logEmbed(ticket, 'deleted'), Colors.error],
    'ban case': [recordEmbed(record('ban'), 'Ban'), 0xed4245],
    'kick case': [caseEmbed(record('kick')), 0xe67e22],
    'clear case': [recordEmbed(record('clear'), 'Clear'), 0x5865f2],
    error: [errorEmbed('x'), 0xed4245],
    success: [successEmbed('x'), 0x57f287],
    'xp boost': [levels.boostNotice({ name: 'g' }), Colors.success],
    'automod error log': [automod.errorLog('t', 'm'), Colors.error],
  };
  for (const [name, [embed, color]] of Object.entries(explicit)) assert.equal(colorOf(embed), color, name);
});
