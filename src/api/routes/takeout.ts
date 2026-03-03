import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../../config/env.js';
import type { UploadState, UploadStateItem } from '../../takeout/uploader.js';
import { apiError } from '../errors.js';

type TakeoutAction =
  | 'scan'
  | 'upload'
  | 'verify'
  | 'resume'
  | 'start-services'
  | 'cleanup-move'
  | 'cleanup-delete'
  | 'cleanup-force-move'
  | 'cleanup-force-delete';

type ScanProgress = {
  phase: string;
  current: number;
  total: number;
  percent: number;
  detail?: string;
};

type ActionStatus = {
  running: boolean;
  action?: TakeoutAction;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  success?: boolean;
  output: string[];
  scanProgress?: ScanProgress;
};

type ActionCommand = {
  command: string;
  args: string[];
  display: string;
};

const MAX_OUTPUT_LINES = 300;
const ACTION_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours — scan of many large archives can take >30 min
const MANIFEST_COUNT_TIMEOUT_MS = 5000;
const ALLOWED_ACTIONS: TakeoutAction[] = [
  'scan',
  'upload',
  'verify',
  'resume',
  'start-services',
  'cleanup-move',
  'cleanup-delete',
  'cleanup-force-move',
  'cleanup-force-delete',
];
const RUN_STATUS: ActionStatus = {
  running: false,
  output: [],
};

let currentProcess: ChildProcess | null = null;
let currentTimeout: NodeJS.Timeout | null = null;
const manifestCountCache = new Map<string, {
  mtimeMs: number;
  size: number;
  count: number;
}>();
// Cache for manifest destination keys (invalidated when manifest file changes)
const manifestKeysCache = new Map<string, {
  mtimeMs: number;
  size: number;
  keys: Set<string>;
}>();

export async function registerTakeoutRoutes(app: FastifyInstance, env: Env): Promise<void> {
  app.get('/takeout/status', async () => {
    const inputDir = path.resolve(env.TAKEOUT_INPUT_DIR);
    const workDir = path.resolve(env.TAKEOUT_WORK_DIR);
    const statePath = path.resolve(env.TRANSFER_STATE_PATH);
    const manifestPath = path.join(workDir, 'manifest.jsonl');

    const [state, manifestKeys] = await Promise.all([
      readUploadState(statePath),
      readManifestKeys(manifestPath),
    ]);

    // Count only state entries that correspond to current manifest keys.
    // This avoids inflated counts from orphaned keys left over by previous runs.
    const manifestItems: Record<string, UploadStateItem> = {};
    for (const key of manifestKeys) {
      const item = state.items[key];
      if (item) manifestItems[key] = item;
    }

    const summary = summarizeState(manifestItems);
    const total = manifestKeys.size;
    const processed = summary.uploaded + summary.skipped + summary.failed;
    const pending = Math.max(total - processed, 0);
    const progress = total > 0 ? Math.min(processed / total, 1) : 0;

    // Count archive files waiting in the input directory
    let archivesInInput = 0;
    try {
      const inputEntries = await fs.readdir(inputDir, { withFileTypes: true });
      archivesInInput = inputEntries.filter(
        (e) => e.isFile() && /\.(zip|tar|tgz|tar\.gz)$/i.test(e.name),
      ).length;
    } catch (err) {
      app.log.debug({ err, inputDir }, 'Unable to list takeout input directory');
      // input dir may not exist yet
    }

    return {
      paths: {
        inputDir,
        workDir,
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
      archivesInInput,
    };
  });

  app.get('/takeout/action-status', async () => {
    return snapshotStatus();
  });

  app.post('/takeout/actions/:action', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const action = (req.params as { action?: string }).action;
    if (!isAction(action)) {
      return reply.code(400).send({
        ...apiError('UNKNOWN_ACTION', `Unknown action: ${String(action)}`),
        allowedActions: ALLOWED_ACTIONS,
      });
    }

    if (RUN_STATUS.running) {
      return reply.code(409).send({
        ...apiError('ACTION_ALREADY_RUNNING', 'Another takeout action is already running'),
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
  const commands = resolveActionCommands(action);

  RUN_STATUS.running = true;
  RUN_STATUS.action = action;
  RUN_STATUS.startedAt = new Date().toISOString();
  RUN_STATUS.finishedAt = undefined;
  RUN_STATUS.exitCode = undefined;
  RUN_STATUS.success = undefined;
  RUN_STATUS.output = [];

  const runCommand = (index: number): void => {
    const current = commands[index];
    const child = spawn(current.command, current.args, {
      cwd: projectRoot,
      env: process.env,
    });

    currentProcess = child;
    appendOutput(`$ ${current.display}`);

    if (currentTimeout) {
      clearTimeout(currentTimeout);
    }
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
      const exitCode = typeof code === 'number' ? code : -1;
      const success = exitCode === 0;
      currentProcess = null;
      if (currentTimeout) {
        clearTimeout(currentTimeout);
        currentTimeout = null;
      }

      if (!success && index + 1 < commands.length) {
        appendOutput(`Action attempt failed with code ${exitCode}; trying fallback command.`);
        runCommand(index + 1);
        return;
      }

      RUN_STATUS.finishedAt = new Date().toISOString();
      RUN_STATUS.exitCode = exitCode;

      // After a successful upload or resume, automatically move completed archives
      // out of the input folder so the user doesn't have to do it manually.
      if (success && (action === 'upload' || action === 'resume')) {
        appendOutput(`Action finished with code ${exitCode}`);
        appendOutput('✅ Upload complete — moving completed archives to uploaded-archives/...');
        RUN_STATUS.running = true;
        RUN_STATUS.action = 'cleanup-move';
        RUN_STATUS.startedAt = new Date().toISOString();
        RUN_STATUS.finishedAt = undefined;
        RUN_STATUS.exitCode = undefined;
        RUN_STATUS.success = undefined;
        runAction('cleanup-move');
        return;
      }

      RUN_STATUS.running = false;
      RUN_STATUS.success = success;
      if (action === 'start-services' && !success) {
        appendStartServicesFailureHints();
      }
      appendOutput(`Action finished with code ${exitCode}`);
    });
  };

  runCommand(0);
}

function resolveActionCommands(action: TakeoutAction): ActionCommand[] {
  if (action === 'start-services') {
    return [
      {
        command: 'docker',
        args: ['compose', 'up', '-d', 'postgres', 'redis'],
        display: 'docker compose up -d postgres redis',
      },
      {
        command: 'docker-compose',
        args: ['up', '-d', 'postgres', 'redis'],
        display: 'docker-compose up -d postgres redis',
      },
    ];
  }

  const scriptByAction: Record<Exclude<TakeoutAction, 'start-services'>, string> = {
    scan: 'takeout:scan',
    upload: 'takeout:upload',
    verify: 'takeout:verify',
    resume: 'takeout:resume',
    'cleanup-move': 'takeout:cleanup -- --apply --move-archives --include-unscanned',
    'cleanup-delete': 'takeout:cleanup -- --apply --delete-archives --include-unscanned',
    'cleanup-force-move': 'takeout:cleanup -- --apply --move-archives --force --include-unscanned',
    'cleanup-force-delete': 'takeout:cleanup -- --apply --delete-archives --force --include-unscanned',
  };

  return [{
    command: 'npm',
    args: ['run', ...scriptByAction[action].split(' ')],
    display: `npm run ${scriptByAction[action]}`,
  }];
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

function parseScanProgress(): ScanProgress | undefined {
  // Find the last [SCAN_PROGRESS] line in output
  for (let i = RUN_STATUS.output.length - 1; i >= 0; i--) {
    const line = RUN_STATUS.output[i];
    if (line.startsWith('[SCAN_PROGRESS]')) {
      try {
        const json = line.slice('[SCAN_PROGRESS]'.length);
        const parsed = JSON.parse(json);
        return {
          phase: String(parsed.phase ?? 'unknown'),
          current: Number(parsed.current ?? 0),
          total: Number(parsed.total ?? 0),
          percent: Math.min(100, Math.max(0, Number(parsed.percent ?? 0))),
          detail: parsed.detail ? String(parsed.detail) : undefined,
        };
      } catch (err) {
        console.debug('[takeout] Ignored malformed scan progress line', err);
        // malformed line, skip
      }
    }
  }
  return undefined;
}

function snapshotStatus(): ActionStatus {
  const scanProgress = (RUN_STATUS.running && RUN_STATUS.action === 'scan')
    ? parseScanProgress()
    : undefined;

  return {
    running: RUN_STATUS.running,
    action: RUN_STATUS.action,
    startedAt: RUN_STATUS.startedAt,
    finishedAt: RUN_STATUS.finishedAt,
    exitCode: RUN_STATUS.exitCode,
    success: RUN_STATUS.success,
    output: [...RUN_STATUS.output],
    scanProgress,
  };
}

function isAction(value: string | undefined): value is TakeoutAction {
  if (!value) {
    return false;
  }
  return ALLOWED_ACTIONS.includes(value as TakeoutAction);
}

/**
 * Read all destinationKey values from a manifest.jsonl file.
 * Result is mtime+size cached so repeated polls are O(1) after the first read.
 */
async function readManifestKeys(manifestPath: string): Promise<Set<string>> {
  try {
    const stat = await fs.stat(manifestPath);
    const cached = manifestKeysCache.get(manifestPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.keys;
    }

    const raw = await fs.readFile(manifestPath, 'utf8');
    const keys = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { destinationKey?: string };
        if (typeof entry.destinationKey === 'string') keys.add(entry.destinationKey);
      } catch (err) {
        console.debug('[takeout] Ignored malformed manifest line', err);
      }
    }

    manifestKeysCache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, keys });
    return keys;
  } catch (err) {
    console.debug('[takeout] Manifest not available, using cached keys if present', err);
    // Manifest doesn't exist yet — return whatever is in cache, or empty
    const cached = manifestKeysCache.get(manifestPath);
    return cached?.keys ?? new Set();
  }
}

async function readManifestCount(manifestPath: string, fallbackCount: number): Promise<number> {
  try {
    const stat = await fs.stat(manifestPath);
    const cached = manifestCountCache.get(manifestPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.count;
    }

    const count = await countManifestLinesStream(manifestPath, MANIFEST_COUNT_TIMEOUT_MS);
    manifestCountCache.set(manifestPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      count,
    });
    return count;
  } catch (err) {
    console.debug('[takeout] Falling back to cached manifest count', err);
    const cached = manifestCountCache.get(manifestPath);
    return cached?.count ?? fallbackCount;
  }
}

async function countManifestLinesStream(manifestPath: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(manifestPath, { encoding: 'utf8' });

    let count = 0;
    let remainder = '';
    let settled = false;

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      handler();
    };

    const timeout = setTimeout(() => {
      stream.destroy(new Error('Manifest count timed out'));
    }, timeoutMs);

    stream.on('data', (chunk: string) => {
      const text = remainder + chunk;
      const lines = text.split(/\r?\n/);
      remainder = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim().length > 0) {
          count += 1;
        }
      }
    });

    stream.on('end', () => {
      finish(() => {
        if (remainder.trim().length > 0) {
          count += 1;
        }
        resolve(count);
      });
    });

    stream.on('error', (error) => {
      finish(() => {
        reject(error);
      });
    });
  });
}

async function readUploadState(statePath: string): Promise<UploadState> {
  try {
    const raw = (await fs.readFile(statePath, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as UploadState;
    if (!parsed || parsed.version !== 1 || typeof parsed.items !== 'object' || !parsed.items) {
      return createEmptyState();
    }

    return parsed;
  } catch (err) {
    console.debug('[takeout] Upload state unavailable, returning empty state', err);
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
