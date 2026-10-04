const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEPENDENCY_FILES = ['package.json', 'package-lock.json'];
const REGISTRATION_FILES = ['src/commandRegistration.js', 'src/deploy-commands.js'];
const SELF = 'scripts/auto-updater.js';
const UPDATER_CHANGED_EXIT_CODE = 75;
const RESTART_DELAYS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const STABLE_AFTER = 60_000;
const STOP_TIMEOUT = 15_000;

const PAYLOAD_SCRIPT = [
  "const path = require('node:path');",
  "const load = require('./src/loader');",
  "const { split } = require('./src/commandRegistration');",
  "process.stdout.write(JSON.stringify(split(load(path.join(process.cwd(), 'src', 'commands')))));",
].join('\n');

const exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${file} ${args.join(' ')} failed: ${(stderr || error.message).trim()}`;
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });

const defaultLog = (message) => console.log(`[auto-updater] ${new Date().toISOString()} ${message}`);

const createUpdater = ({
  repoDir = ROOT,
  remote = 'origin',
  branch = null,
  interval = 60_000,
  restartDelays = RESTART_DELAYS,
  stopTimeout = STOP_TIMEOUT,
  log = defaultLog,
  git = (args) => exec('git', args, { cwd: repoDir }),
  run = (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: repoDir, stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))));
    }),
  commandPayload = () => exec(process.execPath, ['-e', PAYLOAD_SCRIPT], { cwd: repoDir }),
  spawnBot = () => spawn(process.execPath, [path.join(repoDir, 'src', 'index.js')], { cwd: repoDir, stdio: 'inherit' }),
  exit = (code) => process.exit(code),
} = {}) => {
  const state = { branch, bot: null, payload: null, crashes: 0, current: null, stopping: false, shuttingDown: false, timer: null, restartTimer: null };
  const short = (sha) => sha.slice(0, 7);
  const trackingRef = () => `refs/remotes/${remote}/${state.branch}`;

  const readPayload = () =>
    commandPayload().catch((error) => {
      log(`Could not read the slash command definitions: ${error.message}`);
      return null;
    });

  const startBot = () => {
    if (state.bot || state.shuttingDown) return state.bot;
    const bot = spawnBot();
    const startedAt = Date.now();
    state.bot = bot;
    log(`Started Roland (pid ${bot.pid ?? 'unknown'}).`);

    bot.on('exit', (code, signal) => {
      if (state.bot === bot) state.bot = null;
      if (state.stopping || state.shuttingDown) return;

      if (Date.now() - startedAt >= STABLE_AFTER) state.crashes = 0;
      const delay = restartDelays[Math.min(state.crashes, restartDelays.length - 1)];
      state.crashes++;
      log(`Roland exited unexpectedly (${signal ?? `code ${code}`}). Restarting in ${delay / 1000}s.`);
      state.restartTimer = setTimeout(() => {
        state.restartTimer = null;
        if (!state.current) startBot();
      }, delay);
    });
    return bot;
  };

  const stopBot = async () => {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
    const bot = state.bot;
    if (!bot) return;

    state.stopping = true;
    log(`Stopping Roland (pid ${bot.pid ?? 'unknown'}).`);
    await new Promise((resolve) => {
      const killer = setTimeout(() => {
        log(`Roland did not stop within ${stopTimeout / 1000}s; sending SIGKILL.`);
        bot.kill('SIGKILL');
      }, stopTimeout);
      bot.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      bot.kill('SIGTERM');
    });
    state.bot = null;
    state.stopping = false;
  };

  const init = async () => {
    await git(['rev-parse', '--is-inside-work-tree']);
    if (!state.branch) {
      state.branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => {
        throw new Error('The repository is not on a branch (detached HEAD). Check out the branch to monitor first.');
      });
    }
    log(`Monitoring ${remote}/${state.branch} every ${interval / 1000}s in ${repoDir}.`);
    state.payload = await readPayload();
    startBot();
  };

  const update = async (local, target, changed) => {
    await stopBot();
    try {
      await git(['merge', '--ff-only', trackingRef()]);
    } catch (error) {
      log(`Update aborted, the working tree was left unchanged: ${error.message}`);
      startBot();
      return 'update-failed';
    }
    log(`Updated ${short(local)} -> ${short(target)} (${changed.length} file(s) changed).`);

    if (changed.some((file) => DEPENDENCY_FILES.includes(file))) {
      const install = fs.existsSync(path.join(repoDir, 'package-lock.json')) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
      log(`Dependencies changed. Running npm ${install[0]}.`);
      await run('npm', install).catch((error) => log(`npm ${install[0]} failed: ${error.message}`));
    }

    const payload = await readPayload();
    const payloadChanged = payload !== null && payload !== state.payload;
    if (payloadChanged || changed.some((file) => REGISTRATION_FILES.includes(file))) {
      log('Slash command definitions changed. Running npm run deploy.');
      await run('npm', ['run', 'deploy'])
        .then(() => {
          state.payload = payload;
        })
        .catch((error) => log(`npm run deploy failed: ${error.message}`));
    } else if (payload !== null) {
      state.payload = payload;
    }

    if (changed.includes(SELF)) {
      log('The updater itself changed. Exiting so the service manager restarts it with the new version.');
      state.shuttingDown = true;
      clearTimeout(state.timer);
      exit(UPDATER_CHANGED_EXIT_CODE);
      return 'updated';
    }

    startBot();
    return 'updated';
  };

  const runCheck = async () => {
    try {
      try {
        await git(['fetch', '--quiet', remote, `+refs/heads/${state.branch}:${trackingRef()}`]);
      } catch (error) {
        log(`Fetch failed: ${error.message}`);
        return 'fetch-failed';
      }

      const local = await git(['rev-parse', 'HEAD']);
      const target = await git(['rev-parse', trackingRef()]);
      if (local === target) {
        log(`Checked ${remote}/${state.branch}: up to date at ${short(local)}.`);
        return 'up-to-date';
      }

      const isAncestor = (ancestor, descendant) => git(['merge-base', '--is-ancestor', ancestor, descendant]).then(() => true, () => false);
      if (await isAncestor(target, local)) {
        log(`Checked ${remote}/${state.branch}: local branch is ahead (${short(local)}); nothing to update.`);
        return 'ahead';
      }
      if (!(await isAncestor(local, target))) {
        log(`Checked ${remote}/${state.branch}: local ${short(local)} and remote ${short(target)} have diverged. Not updating; resolve it manually.`);
        return 'diverged';
      }

      const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
      if (dirty) {
        log(`New commit ${short(target)} found, but tracked files have local changes. Not updating:\n${dirty}`);
        return 'dirty';
      }

      const changed = (await git(['diff', '--name-only', local, target])).split('\n').filter(Boolean);
      log(`New commit found on ${remote}/${state.branch}: ${short(local)} -> ${short(target)}.`);
      return await update(local, target, changed);
    } catch (error) {
      log(`Update check failed: ${error.message}`);
      return 'error';
    }
  };

  const check = async () => {
    if (state.current || state.shuttingDown) return 'busy';
    state.current = runCheck();
    try {
      return await state.current;
    } finally {
      state.current = null;
    }
  };

  const schedule = () => {
    if (state.shuttingDown) return;
    state.timer = setTimeout(async () => {
      await check();
      schedule();
    }, interval);
  };

  const start = async () => {
    await init();
    schedule();
  };

  const shutdown = async (signal = 'shutdown') => {
    if (state.shuttingDown) return;
    log(`Received ${signal}. Stopping Roland and the updater.`);
    state.shuttingDown = true;
    clearTimeout(state.timer);
    await state.current;
    await stopBot();
  };

  return { state, init, check, start, startBot, stopBot, shutdown };
};

if (require.main === module) {
  const seconds = Number(process.env.UPDATER_INTERVAL_SECONDS);
  const updater = createUpdater({
    remote: process.env.UPDATER_REMOTE || 'origin',
    branch: process.env.UPDATER_BRANCH || null,
    interval: Number.isFinite(seconds) && seconds >= 10 ? seconds * 1000 : 60_000,
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => updater.shutdown(signal).finally(() => process.exit(0)));
  }

  updater.start().catch((error) => {
    defaultLog(`Failed to start: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { createUpdater, DEPENDENCY_FILES, REGISTRATION_FILES, UPDATER_CHANGED_EXIT_CODE };
