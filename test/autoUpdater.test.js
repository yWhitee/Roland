const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdater, UPDATER_CHANGED_EXIT_CODE } = require('../scripts/auto-updater');

const BRANCH = 'claude/updater-test';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const write = (dir, files) => {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    if (content === null) {
      fs.rmSync(target);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
};

const repositories = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roland-updater-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const deploy = path.join(root, 'deploy');

  git(root, 'init', '--quiet', '--bare', origin);
  fs.mkdirSync(seed);
  git(seed, 'init', '--quiet');
  git(seed, 'checkout', '--quiet', '-b', BRANCH);
  write(seed, {
    'package.json': '{ "name": "roland" }\n',
    'package-lock.json': '{ "lockfileVersion": 3 }\n',
    'src/commands/ping.js': 'ping v1\n',
    'src/deploy-commands.js': 'deploy v1\n',
    'scripts/auto-updater.js': 'updater v1\n',
    'README.md': 'v1\n',
  });
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '--quiet', 'origin', BRANCH);
  git(root, 'clone', '--quiet', '--branch', BRANCH, origin, deploy);

  const push = (files, message = 'update') => {
    write(seed, files);
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', message);
    git(seed, 'push', '--quiet', 'origin', BRANCH);
    return git(seed, 'rev-parse', 'HEAD');
  };

  return { root, origin, seed, deploy, push, head: () => git(deploy, 'rev-parse', 'HEAD') };
};

const fakeBots = () => {
  const bots = [];
  return {
    bots,
    alive: () => bots.filter((bot) => bot.alive),
    spawnBot: () => {
      const bot = Object.assign(new EventEmitter(), { pid: 1000 + bots.length, alive: true, signals: [] });
      bot.kill = (signal) => {
        bot.signals.push(signal);
        if (!bot.alive) return;
        bot.alive = false;
        setImmediate(() => bot.emit('exit', null, signal));
      };
      bot.crash = (code = 1) => {
        bot.alive = false;
        bot.emit('exit', code, null);
      };
      bots.push(bot);
      return bot;
    },
  };
};

const setup = (options = {}) => {
  const repos = repositories();
  const fake = fakeBots();
  const logs = [];
  const commands = [];
  const exits = [];
  const updater = createUpdater({
    repoDir: repos.deploy,
    interval: 60_000,
    restartDelays: [20],
    stopTimeout: 1000,
    log: (line) => logs.push(line),
    run: async (command, args) => commands.push([command, ...args].join(' ')),
    spawnBot: fake.spawnBot,
    exit: (code) => exits.push(code),
    ...options,
  });
  return { ...repos, ...fake, logs, commands, exits, updater };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('starts Roland once and reports when the branch is up to date', async () => {
  const { updater, bots, alive, logs, head, origin } = setup();
  await updater.init();
  assert.equal(updater.state.branch, BRANCH, 'the current branch is monitored');
  assert.equal(bots.length, 1);
  updater.startBot();
  assert.equal(bots.length, 1, 'never two Roland processes');

  assert.equal(await updater.check(), 'up-to-date');
  assert.match(logs.at(-1), new RegExp(`Checked origin/${BRANCH}: up to date at ${head().slice(0, 7)}`));
  assert.equal(alive().length, 1);
  assert.ok(fs.existsSync(origin));
});

test('fast-forwards a new commit and restarts Roland', async () => {
  const { updater, bots, alive, commands, logs, push, head } = setup();
  await updater.init();
  const before = head();
  const target = push({ 'README.md': 'v2\n' });

  assert.equal(await updater.check(), 'updated');
  assert.equal(head(), target);
  assert.deepEqual(bots[0].signals, ['SIGTERM'], 'Roland is stopped gracefully');
  assert.equal(bots.length, 2);
  assert.equal(alive().length, 1, 'exactly one Roland process after the update');
  assert.deepEqual(commands, [], 'no npm commands for unrelated changes');
  assert.ok(logs.some((line) => line.includes(`Updated ${before.slice(0, 7)} -> ${target.slice(0, 7)}`)));
  assert.equal(await updater.check(), 'up-to-date');
});

test('runs npm ci when dependencies change, or npm install without a lockfile', async () => {
  const { updater, commands, push } = setup();
  await updater.init();

  push({ 'package.json': '{ "name": "roland", "version": "2" }\n' });
  await updater.check();
  assert.deepEqual(commands, ['npm ci --no-audit --no-fund']);

  push({ 'package-lock.json': null, 'package.json': '{ "name": "roland", "version": "3" }\n' });
  await updater.check();
  assert.deepEqual(commands, ['npm ci --no-audit --no-fund', 'npm install --no-audit --no-fund']);
});

test('a slash command change restarts Roland so it registers the new definitions', async () => {
  const { updater, bots, alive, commands, push } = setup();
  await updater.init();
  push({ 'src/commands/ping.js': 'ping v2\n', 'src/deploy-commands.js': 'deploy v2\n' });

  assert.equal(await updater.check(), 'updated');
  assert.deepEqual(bots[0].signals, ['SIGTERM']);
  assert.equal(bots.length, 2);
  assert.equal(alive().length, 1);
  assert.deepEqual(commands, [], 'no npm run deploy: Roland registers its commands when it starts');
});

test('never overwrites local changes to tracked files', async () => {
  const { updater, bots, alive, deploy, push, head } = setup();
  await updater.init();
  const before = head();
  write(deploy, { 'README.md': 'edited on the server\n' });
  push({ 'README.md': 'v2\n' });

  assert.equal(await updater.check(), 'dirty');
  assert.equal(head(), before);
  assert.equal(fs.readFileSync(path.join(deploy, 'README.md'), 'utf8'), 'edited on the server\n');
  assert.equal(bots.length, 1, 'Roland keeps running');
  assert.equal(alive().length, 1);
});

test('does not touch local commits when the branch is ahead or has diverged', async () => {
  const { updater, deploy, push, head } = setup();
  await updater.init();
  write(deploy, { 'LOCAL.md': 'local\n' });
  git(deploy, 'add', '.');
  git(deploy, 'commit', '--quiet', '-m', 'local commit');
  const local = head();

  assert.equal(await updater.check(), 'ahead');
  push({ 'README.md': 'v2\n' });
  assert.equal(await updater.check(), 'diverged');
  assert.equal(head(), local, 'the local commit is kept');
});

test('aborts safely when git refuses the fast-forward', async () => {
  const { updater, bots, alive, deploy, push, head } = setup();
  await updater.init();
  const before = head();
  write(deploy, { 'NEW.md': 'untracked file on the server\n' });
  push({ 'NEW.md': 'from the repository\n' });

  assert.equal(await updater.check(), 'update-failed');
  assert.equal(head(), before);
  assert.equal(fs.readFileSync(path.join(deploy, 'NEW.md'), 'utf8'), 'untracked file on the server\n');
  assert.equal(bots.length, 2, 'Roland is started again on the current version');
  assert.equal(alive().length, 1);
});

test('restarts Roland after a crash without starting duplicates', async () => {
  const { updater, bots, alive, logs } = setup();
  await updater.init();

  bots[0].crash(1);
  assert.match(logs.at(-1), /Roland exited unexpectedly \(code 1\)\. Restarting/);
  updater.startBot();
  await wait(50);
  assert.equal(alive().length, 1);
  assert.equal(bots.length, 2, 'only one replacement process');

  bots[1].crash(1);
  await wait(50);
  assert.equal(bots.length, 3);
  assert.equal(alive().length, 1);
});

test('shutdown stops Roland and nothing restarts it', async () => {
  const { updater, bots, alive, push } = setup();
  await updater.init();
  push({ 'README.md': 'v2\n' });

  await updater.shutdown('SIGTERM');
  assert.deepEqual(bots[0].signals, ['SIGTERM']);
  await wait(50);
  assert.equal(alive().length, 0);
  assert.equal(bots.length, 1);
  assert.equal(await updater.check(), 'busy', 'no more updates after shutdown');
  updater.startBot();
  assert.equal(bots.length, 1);
});

test('a Roland process that ignores SIGTERM is killed after the timeout', async () => {
  const { updater, logs } = setup({
    stopTimeout: 300,
    spawnBot: () => spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }),
  });
  await updater.init();
  const child = updater.state.bot;
  await wait(200);
  await updater.shutdown('SIGTERM');
  assert.equal(child.exitCode !== null || child.signalCode !== null, true, 'the process is gone');
  if (process.platform !== 'win32') assert.ok(logs.some((line) => line.includes('sending SIGKILL')));
});

test('exits for a service restart when the updater itself changes, after installing dependencies', async () => {
  const { updater, bots, alive, commands, exits, push } = setup();
  await updater.init();
  push({ 'scripts/auto-updater.js': 'updater v2\n', 'package.json': '{ "name": "roland", "version": "2" }\n' });

  assert.equal(await updater.check(), 'updated');
  assert.deepEqual(commands, ['npm ci --no-audit --no-fund']);
  assert.deepEqual(exits, [UPDATER_CHANGED_EXIT_CODE]);
  assert.equal(bots.length, 1);
  assert.equal(alive().length, 0, 'the new updater starts Roland');
});

test('refuses a detached HEAD and survives fetch failures', async () => {
  const detached = setup();
  git(detached.deploy, 'checkout', '--quiet', '--detach');
  await assert.rejects(detached.updater.init(), /not on a branch/);
  assert.equal(detached.bots.length, 0);

  const offline = setup();
  await offline.updater.init();
  git(offline.deploy, 'remote', 'set-url', 'origin', path.join(offline.root, 'missing.git'));
  assert.equal(await offline.updater.check(), 'fetch-failed');
  assert.match(offline.logs.at(-1), /Fetch failed/);
  assert.equal(offline.alive().length, 1, 'Roland keeps running');
});

test('package.json keeps the start and dev scripts', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(scripts.start, 'node src/index.js');
  assert.equal(scripts.dev, 'node scripts/auto-updater.js');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'auto-updater.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', '.gitkeep')));
});
