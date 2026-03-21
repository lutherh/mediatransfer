import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const frontendDir = path.join(rootDir, 'frontend');

const setupOnly = process.argv.includes('--setup-only');

const DOCKER_READY_TIMEOUT_MS = 120_000;
const DOCKER_POLL_INTERVAL_MS = 3_000;

const BACKEND_PORT = 3000;
const FRONTEND_PORT = 5173;
const BACKEND_HEALTH_URL = `http://localhost:${BACKEND_PORT}/health`;
const FRONTEND_HEALTH_URL = `http://localhost:${FRONTEND_PORT}/`;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_REQUEST_TIMEOUT_MS = 4_000;
const STARTUP_GRACE_MS = 60_000;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS_PER_WINDOW = 8;

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, cwd);

    child.on('error', (error) => reject(error));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed: ${command} ${args.join(' ')} (exit ${code ?? 'unknown'})`));
    });
  });
}

function startLongRunning(command, args, cwd) {
  return spawnProcess(command, args, cwd);
}

function quoteCmdArg(value) {
  if (!/[\s"^&|<>]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function spawnProcess(command, args, cwd) {
  if (isWindows && command.toLowerCase().endsWith('.cmd')) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const commandLine = [command, ...args].map(quoteCmdArg).join(' ');
    return spawn(comspec, ['/d', '/s', '/c', commandLine], {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
  }

  return spawn(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });
}

function ensureEncryptionSecret(envPath) {
  const placeholderValues = new Set(['change-me-to-a-random-secret', 'change-me', '']);
  const raw = readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  let updated = false;
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*ENCRYPTION_SECRET\s*=\s*(.*)\s*$/);
    if (!match) {
      return line;
    }

    const originalValue = (match[1] ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (!placeholderValues.has(originalValue.toLowerCase())) {
      return line;
    }

    const generated = randomBytes(24).toString('hex');
    updated = true;
    return `ENCRYPTION_SECRET=${generated}`;
  });

  if (updated) {
    writeFileSync(envPath, nextLines.join('\n'), 'utf8');
    console.log('Generated a secure ENCRYPTION_SECRET in .env for local development.');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function checkUrlHealthy(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function pruneRestartHistory(history) {
  const cutoff = Date.now() - RESTART_WINDOW_MS;
  while (history.length > 0 && history[0] < cutoff) {
    history.shift();
  }
}

function recordRestart(state) {
  state.restartHistory.push(Date.now());
  pruneRestartHistory(state.restartHistory);
}

function canRestart(state) {
  pruneRestartHistory(state.restartHistory);
  return state.restartHistory.length < MAX_RESTARTS_PER_WINDOW;
}

function freePort(port) {
  try {
    if (isWindows) {
      // netstat output: "  TCP  127.0.0.1:3000  0.0.0.0:0  LISTENING  12345"
      const out = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`, {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const pids = new Set();
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const pid = Number(parts[parts.length - 1]);
          // Never kill our own process or PID 0/4 (system)
          if (pid > 4 && pid !== process.pid) pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', timeout: 5_000 });
          console.log(`Killed stale process ${pid} on port ${port}`);
        } catch { /* already gone */ }
      }
    } else {
      // Unix: use lsof
      const out = execSync(`lsof -ti :${port}`, {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      for (const pidStr of out.trim().split('\n')) {
        const pid = Number(pidStr);
        if (pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, 'SIGKILL');
            console.log(`Killed stale process ${pid} on port ${port}`);
          } catch { /* already gone */ }
        }
      }
    }
  } catch {
    // No process on that port — nothing to do
  }
}

function freeAllPorts() {
  console.log('Freeing ports...');
  freePort(BACKEND_PORT);
  freePort(FRONTEND_PORT);
}

function isDockerRunning() {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function launchDockerDesktop() {
  if (isWindows) {
    // Try common install locations
    const paths = [
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Docker', 'Docker Desktop.exe'),
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        spawn(p, [], { detached: true, stdio: 'ignore' }).unref();
        return true;
      }
    }
    // Fallback: try via start command (works if Docker Desktop is on PATH or in Start Menu)
    spawn('cmd', ['/c', 'start', '', 'Docker Desktop'], { detached: true, stdio: 'ignore', shell: true }).unref();
    return true;
  }

  // macOS
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  // Linux — systemd
  try {
    execSync('systemctl start docker', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureDockerRunning() {
  if (isDockerRunning()) {
    console.log('Docker daemon is running.');
    return;
  }

  console.log('Docker daemon is not running. Launching Docker Desktop...');
  const launched = launchDockerDesktop();
  if (!launched) {
    console.error('Could not find Docker Desktop. Please start it manually and re-run this script.');
    process.exit(1);
  }

  const deadline = Date.now() + DOCKER_READY_TIMEOUT_MS;
  process.stdout.write('Waiting for Docker to be ready');
  while (Date.now() < deadline) {
    await sleep(DOCKER_POLL_INTERVAL_MS);
    process.stdout.write('.');
    if (isDockerRunning()) {
      console.log(' ready!');
      return;
    }
  }

  console.error(`\nDocker did not become ready within ${DOCKER_READY_TIMEOUT_MS / 1000}s. Please start it manually.`);
  process.exit(1);
}

async function ensureDependencies() {
  if (!existsSync(path.join(rootDir, 'node_modules'))) {
    console.log('Installing backend dependencies...');
    await runCommand(npmCmd, ['ci'], rootDir);
  }

  // Always run npm install for frontend to catch any missing packages
  console.log('Installing frontend dependencies...');
  await runCommand(npmCmd, ['install'], frontendDir);
}

async function runSetup() {
  const envPath = path.join(rootDir, '.env');
  if (!existsSync(envPath)) {
    console.error('Missing .env file. Create it from .env.example and set credentials before starting.');
    process.exit(1);
  }

  ensureEncryptionSecret(envPath);

  await ensureDependencies();
  await ensureDockerRunning();

  // Stop any existing containers (e.g. stale 'app' service) that may conflict
  console.log('Cleaning up existing containers...');
  await runCommand('docker', ['compose', 'down'], rootDir);

  console.log('Starting local services (Postgres, Redis)...');
  await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis'], rootDir);

  console.log('Generating Prisma client...');
  await runCommand(npmCmd, ['run', 'prisma:generate'], rootDir);
}

async function ensureLocalServicesRunning() {
  await ensureDockerRunning();
  console.log('Ensuring Postgres/Redis are running...');
  await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis'], rootDir);
}

async function stopChildProcess(state, force = false) {
  const child = state.child;
  if (!child) return;

  state.child = undefined;

  if (child.exitCode !== null) {
    return;
  }

  const signal = force ? 'SIGKILL' : 'SIGINT';
  child.kill(signal);

  try {
    await withTimeout(
      new Promise((resolve) => {
        child.once('exit', () => resolve());
      }),
      10_000,
      `${state.name} shutdown`,
    );
  } catch {
    if (!force && child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
}

function startService(state) {
  if (state.child && state.child.exitCode === null) {
    return;
  }

  console.log(`Starting ${state.name}...`);

  // Free the port before starting to ensure no stale process blocks us
  if (state.name === 'Backend') freePort(BACKEND_PORT);
  if (state.name === 'Frontend') freePort(FRONTEND_PORT);

  state.startedAt = Date.now();
  state.consecutiveFailures = 0;
  state.ready = false;

  const child = startLongRunning(npmCmd, ['run', 'dev'], state.cwd);
  state.child = child;

  child.on('exit', () => {
    if (state.shuttingDown) {
      return;
    }
    void recoverService(state, `${state.name} exited unexpectedly`);
  });

  child.on('error', () => {
    if (state.shuttingDown) {
      return;
    }
    void recoverService(state, `${state.name} encountered process error`);
  });
}

async function recoverService(state, reason) {
  if (state.shuttingDown || state.recovering) {
    return;
  }

  if (!canRestart(state)) {
    console.error(
      `${state.name} exceeded restart budget (${MAX_RESTARTS_PER_WINDOW} in ${Math.round(RESTART_WINDOW_MS / 60000)}m). Stopping runner.`,
    );
    await shutdownAll(state.manager, 'restart-budget-exceeded');
    return;
  }

  state.recovering = true;
  recordRestart(state);

  try {
    console.warn(`${state.name} recovery triggered: ${reason}`);
    await ensureLocalServicesRunning();
    await stopChildProcess(state);
    await sleep(800);
    startService(state);
  } catch (error) {
    console.error(`Failed recovering ${state.name}:`, error instanceof Error ? error.message : String(error));
  } finally {
    state.recovering = false;
  }
}

async function shutdownAll(manager, signal) {
  if (manager.shuttingDown) return;
  manager.shuttingDown = true;
  manager.backend.shuttingDown = true;
  manager.frontend.shuttingDown = true;

  if (manager.monitorTimer) {
    clearInterval(manager.monitorTimer);
    manager.monitorTimer = undefined;
  }

  console.log(`\nReceived ${signal}. Stopping backend and frontend...`);
  await Promise.all([
    stopChildProcess(manager.backend),
    stopChildProcess(manager.frontend),
  ]);

  process.exit(0);
}

async function monitorHealth(manager) {
  if (manager.shuttingDown || manager.monitorInFlight) {
    return;
  }

  manager.monitorInFlight = true;

  try {
    const backendHealthy = await checkUrlHealthy(BACKEND_HEALTH_URL);
    await processServiceHealth(manager.backend, backendHealthy);

    const frontendHealthy = await checkUrlHealthy(FRONTEND_HEALTH_URL);
    await processServiceHealth(manager.frontend, frontendHealthy);
  } finally {
    manager.monitorInFlight = false;
  }
}

async function processServiceHealth(state, healthy) {
  if (state.shuttingDown) {
    return;
  }

  if (healthy) {
    state.ready = true;
    state.consecutiveFailures = 0;
    return;
  }

  state.consecutiveFailures += 1;
  const elapsed = Date.now() - state.startedAt;
  const shouldRecover =
    state.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD &&
    (state.ready || elapsed > STARTUP_GRACE_MS);

  if (shouldRecover) {
    await recoverService(state, `${state.consecutiveFailures} consecutive failed health checks`);
  }
}

async function main() {
  try {
    await runSetup();

    if (setupOnly) {
      console.log('Setup complete. Run "npm run app:dev" to launch backend + frontend.');
      return;
    }

    freeAllPorts();

    console.log('Starting backend and frontend with watchdog...');

    const manager = {
      shuttingDown: false,
      monitorInFlight: false,
      monitorTimer: undefined,
      backend: {
        name: 'Backend',
        cwd: rootDir,
        child: undefined,
        ready: false,
        startedAt: 0,
        consecutiveFailures: 0,
        restartHistory: [],
        recovering: false,
        shuttingDown: false,
        manager: undefined,
      },
      frontend: {
        name: 'Frontend',
        cwd: frontendDir,
        child: undefined,
        ready: false,
        startedAt: 0,
        consecutiveFailures: 0,
        restartHistory: [],
        recovering: false,
        shuttingDown: false,
        manager: undefined,
      },
    };

    manager.backend.manager = manager;
    manager.frontend.manager = manager;

    startService(manager.backend);
    startService(manager.frontend);

    manager.monitorTimer = setInterval(() => {
      void monitorHealth(manager);
    }, HEALTH_CHECK_INTERVAL_MS);

    setTimeout(() => {
      void monitorHealth(manager);
    }, 4000);

    process.on('SIGINT', () => {
      void shutdownAll(manager, 'SIGINT');
    });
    process.on('SIGTERM', () => {
      void shutdownAll(manager, 'SIGTERM');
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();