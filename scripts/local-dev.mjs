import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const frontendDir = path.join(rootDir, 'frontend');

const setupOnly = process.argv.includes('--setup-only');

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
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
    shell: false,
  });
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

  console.log('Starting local services (Postgres, Redis)...');
  await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis'], rootDir);

  console.log('Generating Prisma client...');
  await runCommand(npmCmd, ['run', 'prisma:generate'], rootDir);
}

async function main() {
  try {
    await runSetup();

    if (setupOnly) {
      console.log('Setup complete. Run "npm run app:dev" to launch backend + frontend.');
      return;
    }

    console.log('Starting backend and frontend...');
    const backend = startLongRunning(npmCmd, ['run', 'dev'], rootDir);
    const frontend = startLongRunning(npmCmd, ['run', 'dev'], frontendDir);

    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;

      console.log(`\nReceived ${signal}. Stopping backend and frontend...`);
      backend.kill('SIGINT');
      frontend.kill('SIGINT');

      setTimeout(() => process.exit(0), 200);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    backend.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`Backend exited with code ${code ?? 'unknown'}.`);
        shutdown('backend-exit');
      }
    });

    frontend.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`Frontend exited with code ${code ?? 'unknown'}.`);
        shutdown('frontend-exit');
      }
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();