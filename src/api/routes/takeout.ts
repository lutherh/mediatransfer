import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';

type UploadStateItem = {
  status: 'uploaded' | 'skipped' | 'failed';
  attempts: number;
  updatedAt: string;
  error?: string;
};

type UploadState = {
  version: 1;
  updatedAt: string;
  items: Record<string, UploadStateItem>;
};

type TakeoutAction = 'scan' | 'upload' | 'verify' | 'resume' | 'start-services';

type ActionStatus = {
  running: boolean;
  action?: TakeoutAction;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  success?: boolean;
  output: string[];
};

const MAX_OUTPUT_LINES = 300;
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;
const RUN_STATUS: ActionStatus = {
  running: false,
  output: [],
};

let currentProcess: ChildProcess | null = null;
let currentTimeout: NodeJS.Timeout | null = null;

export async function registerTakeoutRoutes(app: FastifyInstance): Promise<void> {
  app.get('/takeout/status', async () => {
    const workDir = path.resolve(process.env.TAKEOUT_WORK_DIR ?? './data/takeout/work');
    const statePath = path.resolve(process.env.TRANSFER_STATE_PATH ?? './data/takeout/state.json');
    const manifestPath = path.join(workDir, 'manifest.jsonl');

    const [manifestCount, state] = await Promise.all([
      readManifestCount(manifestPath),
      readUploadState(statePath),
    ]);

    const summary = summarizeState(state.items);
    const total = manifestCount;
    const processed = summary.uploaded + summary.skipped + summary.failed;
    const pending = Math.max(total - processed, 0);
    const progress = total > 0 ? Math.min(processed / total, 1) : 0;

    return {
      paths: {
        manifestPath,
        statePath,
      },
      counts: {
        total,
        processed,
        pending,
        uploaded: summary.uploaded,
        skipped: summary.skipped,
        failed: summary.failed,
      },
      progress,
      stateUpdatedAt: state.updatedAt,
      recentFailures: summary.recentFailures,
      isComplete: total > 0 && pending === 0 && summary.failed === 0,
    };
  });

  app.get('/takeout/action-status', async () => {
    return snapshotStatus();
  });

  app.post('/takeout/actions/:action', async (req, reply) => {
    const action = (req.params as { action?: string }).action;
    if (!isAction(action)) {
      return reply.code(400).send({
        error: `Unknown action: ${String(action)}`,
        allowedActions: ['scan', 'upload', 'verify', 'resume', 'start-services'],
      });
    }

    if (RUN_STATUS.running) {
      return reply.code(409).send({
        error: 'Another takeout action is already running',
        status: snapshotStatus(),
      });
    }

    runAction(action);

    return reply.code(202).send({
      message: `Started ${action}`,
      status: snapshotStatus(),
    });
  });
}

function runAction(action: TakeoutAction): void {
  const projectRoot = path.resolve(process.cwd());
  const command = resolveActionCommand(action);

  RUN_STATUS.running = true;
  RUN_STATUS.action = action;
  RUN_STATUS.startedAt = new Date().toISOString();
  RUN_STATUS.finishedAt = undefined;
  RUN_STATUS.exitCode = undefined;
  RUN_STATUS.success = undefined;
  RUN_STATUS.output = [];

  const child = spawn(command, {
    cwd: projectRoot,
    env: process.env,
    shell: true,
  });

  currentProcess = child;
  appendOutput(`$ ${command}`);

  currentTimeout = setTimeout(() => {
    if (!RUN_STATUS.running) {
      return;
    }

    appendOutput(`Action timed out after ${Math.round(ACTION_TIMEOUT_MS / 60000)} minutes.`);
    child.kill();
    RUN_STATUS.running = false;
    RUN_STATUS.finishedAt = new Date().toISOString();
    RUN_STATUS.exitCode = -1;
    RUN_STATUS.success = false;
    currentProcess = null;
    currentTimeout = null;
  }, ACTION_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => {
    appendOutput(String(chunk));
  });

  child.stderr.on('data', (chunk) => {
    appendOutput(String(chunk));
  });

  child.on('error', (error) => {
    appendOutput(`Process error: ${error.message}`);
    RUN_STATUS.running = false;
    RUN_STATUS.finishedAt = new Date().toISOString();
    RUN_STATUS.exitCode = -1;
    RUN_STATUS.success = false;
    currentProcess = null;
    if (currentTimeout) {
      clearTimeout(currentTimeout);
      currentTimeout = null;
    }
  });

  child.on('close', (code) => {
    RUN_STATUS.running = false;
    RUN_STATUS.finishedAt = new Date().toISOString();
    RUN_STATUS.exitCode = typeof code === 'number' ? code : -1;
    RUN_STATUS.success = code === 0;
    if (action === 'start-services' && RUN_STATUS.success === false) {
      appendStartServicesFailureHints();
    }
    appendOutput(`Action finished with code ${RUN_STATUS.exitCode}`);
    currentProcess = null;
    if (currentTimeout) {
      clearTimeout(currentTimeout);
      currentTimeout = null;
    }
  });
}

function resolveActionCommand(action: TakeoutAction): string {
  if (action === 'start-services') {
    return 'docker compose up -d postgres redis || docker-compose up -d postgres redis';
  }

  const scriptByAction: Record<Exclude<TakeoutAction, 'start-services'>, string> = {
    scan: 'takeout:scan',
    upload: 'takeout:upload',
    verify: 'takeout:verify',
    resume: 'takeout:resume',
  };

  return `npm run ${scriptByAction[action]}`;
}

function appendStartServicesFailureHints(): void {
  const fullOutput = RUN_STATUS.output.join('\n').toLowerCase();

  if (fullOutput.includes('docker is not recognized') || fullOutput.includes('docker-compose is not recognized')) {
    appendOutput('Hint: Docker CLI was not found in PATH. Install Docker Desktop and reopen your terminal/editor.');
    return;
  }

  if (fullOutput.includes('cannot connect to the docker daemon') || fullOutput.includes('error during connect')) {
    appendOutput('Hint: Docker daemon is not running. Start Docker Desktop and retry Start Services.');
    return;
  }

  if (fullOutput.includes('address already in use') || fullOutput.includes('port is already allocated')) {
    appendOutput('Hint: A required port is already in use (likely 5432 or 6379). Stop conflicting services and retry.');
    return;
  }

  appendOutput('Hint: Service startup failed. Run "docker compose logs postgres redis" and fix reported issues, then retry.');
}

function appendOutput(chunk: string): void {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return;
  }

  RUN_STATUS.output.push(...lines);
  if (RUN_STATUS.output.length > MAX_OUTPUT_LINES) {
    RUN_STATUS.output = RUN_STATUS.output.slice(RUN_STATUS.output.length - MAX_OUTPUT_LINES);
  }
}

function snapshotStatus(): ActionStatus {
  return {
    running: RUN_STATUS.running,
    action: RUN_STATUS.action,
    startedAt: RUN_STATUS.startedAt,
    finishedAt: RUN_STATUS.finishedAt,
    exitCode: RUN_STATUS.exitCode,
    success: RUN_STATUS.success,
    output: [...RUN_STATUS.output],
  };
}

function isAction(value: string | undefined): value is TakeoutAction {
  return value === 'scan'
    || value === 'upload'
    || value === 'verify'
    || value === 'resume'
    || value === 'start-services';
}

async function readManifestCount(manifestPath: string): Promise<number> {
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

async function readUploadState(statePath: string): Promise<UploadState> {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as UploadState;
    if (!parsed || parsed.version !== 1 || typeof parsed.items !== 'object' || !parsed.items) {
      return createEmptyState();
    }

    return parsed;
  } catch {
    return createEmptyState();
  }
}

function createEmptyState(): UploadState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    items: {},
  };
}

function summarizeState(items: Record<string, UploadStateItem>): {
  uploaded: number;
  skipped: number;
  failed: number;
  recentFailures: Array<{ key: string; error?: string; updatedAt: string; attempts: number }>;
} {
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const recentFailures: Array<{ key: string; error?: string; updatedAt: string; attempts: number }> = [];

  for (const [key, item] of Object.entries(items)) {
    if (item.status === 'uploaded') {
      uploaded += 1;
      continue;
    }

    if (item.status === 'skipped') {
      skipped += 1;
      continue;
    }

    failed += 1;
    recentFailures.push({
      key,
      error: item.error,
      updatedAt: item.updatedAt,
      attempts: item.attempts,
    });
  }

  recentFailures.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    uploaded,
    skipped,
    failed,
    recentFailures: recentFailures.slice(0, 10),
  };
}
