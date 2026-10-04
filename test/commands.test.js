const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const load = require('../src/loader');

const commands = load(path.join(__dirname, '..', 'src', 'commands'));

test('todos os comandos carregam e geram JSON válido', () => {
  const names = commands.map((command) => command.data.toJSON().name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), ['ban', 'clear', 'embed', 'kick', 'logs', 'modlog', 'mute', 'ping', 'unban', 'unmute', 'warn']);
  for (const command of commands) {
    assert.equal(typeof command.execute, 'function', command.data.name);
    if (command.data.name !== 'ping') assert.ok(command.level > 0, command.data.name);
  }
});

test('/ping continua intacto', () => {
  const ping = commands.find((command) => command.data.name === 'ping');
  assert.deepEqual(JSON.parse(JSON.stringify(ping.data.toJSON())), { options: [], name: 'ping', description: 'Testa a conexão do bot', type: 1 });
});

test('registro dos slash commands como guild commands', async () => {
  const body = commands.map((command) => command.data.toJSON());
  const received = await new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      let data = '';
      request.on('data', (chunk) => (data += chunk));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(data);
        server.close();
        resolve({ method: request.method, url: request.url, body: JSON.parse(data) });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      new REST({ api: `http://127.0.0.1:${server.address().port}` })
        .setToken('teste')
        .put(Routes.applicationGuildCommands('100000000000000001', '100000000000000002'), { body })
        .catch(reject);
    });
  });

  assert.equal(received.method, 'PUT');
  assert.equal(received.url, '/v10/applications/100000000000000001/guilds/100000000000000002/commands');
  assert.equal(received.body.length, 11);
});
