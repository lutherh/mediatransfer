import { existsSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
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

const BACKEND_HEALTH_URL = 'http://localhost:3000/health';
const FRONTEND_HEALTH_URL = 'http://localhost:5173/';
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_REQUEST_TIMEOUT_MS = 4_000;
const STARTUP_GRACE_MS = 60_000;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS_PER_WINDOW = 8;

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: isWindows,
    });

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
  return spawn(command, args, {
    cwd,
    stdio: 'inherit',
    shell: isWindows,
  });
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

  if (!existsSync(path.join(frontendDir, 'node_modules'))) {
    console.log('Installing frontend dependencies...');
    await runCommand(npmCmd, ['ci'], frontendDir);
  }
}

async function runSetup() {
  const envPath = path.join(rootDir, '.env');
  if (!existsSync(envPath)) {
    console.error('Missing .env file. Create it from .env.example and set credentials before starting.');
    process.exit(1);
  }

  await ensureDependencies();
  await ensureDockerRunning();

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