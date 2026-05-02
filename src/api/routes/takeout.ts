import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../../config/env.js';
import type { UploadSkipReason, UploadState, UploadStateItem } from '../../takeout/uploader.js';
import { loadUploadState } from '../../takeout/uploader.js';
import { OVERRIDABLE_PATHS, type OverridablePathName } from '../../takeout/config.js';
import {
  loadPipelineState,
  savePipelineState,
  markStepStarted,
  markStepFinished,
  buildPipelineSummary,
  type PipelineState,
} from '../../takeout/pipeline-state.js';
import {
  loadArchiveState,
  createEmptyArchiveState,
  persistArchiveState,
  reconcileStaleArchives,
  reconcileArchiveEntries,
  reconcileManifest,
  type ArchiveStateItem,
} from '../../takeout/incremental.js';
import { readRunLock, type RunLockInfo } from '../../takeout/run-lock.js';
import { isPauseRequested, requestPause, clearPauseFlag } from '../../takeout/pause-flag.js';
import { analyseArchiveSequences, normaliseArchiveName } from '../../takeout/sequence-analysis.js';
import { apiError } from '../errors.js';
import { createJob, updateJob } from '../../db/jobs.js';
import { getLogger } from '../../utils/logger.js';

const log = getLogger().child({ module: 'takeout-routes' });

type TakeoutAction =
  | 'scan'
  | 'upload'
  | 'verify'
  | 'resume'
  | 'repair-dates'
  | 'repair-dates-s3'
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

type UploadProgressInfo = {
  speed?: string;
  eta?: string;
  inFlight?: number;
  bytesTransferred?: string;
  bytesTotal?: string;
  bytePercent?: number;
  currentArchive?: string;
  currentArchiveIndex?: number;
  totalArchives?: number;
};

type ActionStatus = {
  running: boolean;
  paused?: boolean;
  action?: TakeoutAction;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  success?: boolean;
  output: string[];
  scanProgress?: ScanProgress;
  uploadProgress?: UploadProgressInfo;
  lastOutputAt?: string;
  /** When auto-upload has scheduled a next action, indicates what it is. */
  autoUploadPending?: 'scan' | 'upload' | null;
};

type ActionCommand = {
  command: string;
  args: string[];
  display: string;
};

type ArchiveHistoryEntry = {
  archiveName: string;
  status: 'pending' | 'extracting' | 'uploading' | 'completed' | 'failed';
  archiveSizeBytes?: number;
  mediaBytes?: number;
  entryCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  handledPercent: number;
  isFullyUploaded: boolean;
  notUploadedReasons?: Array<{
    code: UploadSkipReason | 'upload_failed' | 'upload_failed_transient' | 'upload_failed_permanent';
    label: string;
    count: number;
  }>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

const MAX_OUTPUT_LINES = 300;
const ACTION_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours — scan of many large archives can take >30 min

// --- Transfer job tracking ---
// When an upload or resume action runs, we create a TransferJob so
// the /transfers page can display progress alongside other transfers.
const UPLOAD_PROGRESS_RE = /items\s+\d+\/\d+\s+\((\d+)%\)/;
const PROGRESS_UPDATE_INTERVAL_MS = 5_000; // throttle DB writes
let currentTransferJobId: string | null = null;
let lastProgressUpdateMs = 0;
const ALLOWED_ACTIONS: TakeoutAction[] = [
  'scan',
  'upload',
  'verify',
  'resume',
  'repair-dates',
  'repair-dates-s3',
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
let currentRunToken: string | null = null;
let currentTimeout: NodeJS.Timeout | null = null;
let pauseRequested = false;
let lastOutputAt: string | undefined;

/**
 * User-overridden paths (set via PUT /takeout/paths/:name).
 * Keys are OverridablePathName values (e.g. 'inputDir', 'workDir').
 * When set, these are used instead of env defaults for status
 * and passed as CLI flags to spawned action scripts.
 * Persisted to disk so they survive server restarts.
 */
const customPaths = new Map<string, string>();
const CUSTOM_PATHS_FILE = 'custom-paths.json';
let autoUploadEnabled = false;
const AUTO_UPLOAD_FILE = 'auto-upload.json';

// Delay before auto-upload triggers the next action (gives the frontend time to
// see the completed state before the next action kicks off).
const AUTO_UPLOAD_DELAY_MS = 5_000;
// How often to poll the input directory for new archives when auto-upload is
// enabled and the system is idle (no action running, nothing queued).
const AUTO_UPLOAD_POLL_INTERVAL_MS = 30_000;

// Shell metacharacters that could enable command injection when paths flow
// into spawn() with shell:true (used on Windows for `npm run` to resolve npm.cmd).
// Reject at input time so persisted / later-loaded overrides stay safe.
// eslint-disable-next-line no-control-regex
const SHELL_METACHAR_RE = /[`$&|;<>"'*?\r\n\t\u0000-\u001f]/;

/** Validate a user-supplied filesystem path is safe to pass to a child process.
 *  Returns `null` if safe, or an error message if the path contains unsafe chars. */
export function validateCustomPath(value: string): string | null {
  if (SHELL_METACHAR_RE.test(value)) {
    return 'Path contains unsafe characters (shell metacharacters are not allowed)';
  }
  return null;
}

// Track pending auto-upload timeouts so we can cancel them and prevent stacking.
let autoUploadTimeout: NodeJS.Timeout | null = null;
let autoUploadPollInterval: NodeJS.Timeout | null = null;
// Tracks whether auto-upload has queued a next action (so the UI can show it).
let autoUploadPending: 'scan' | 'upload' | null = null;

function customPathsFilePath(env: Env): string {
  // Store next to TRANSFER_STATE_PATH (a fixed location independent of workDir)
  return path.join(path.dirname(path.resolve(env.TRANSFER_STATE_PATH)), CUSTOM_PATHS_FILE);
}

async function loadCustomPaths(env: Env): Promise<void> {
  customPaths.clear();
  try {
    const raw = await fs.readFile(customPathsFilePath(env), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > 0) {
        // Skip any persisted path with unsafe characters — defense-in-depth
        // in case the file was hand-edited or pre-dated input validation.
        if (validateCustomPath(value) !== null) {
          log.warn(
            { key },
            '[takeout] Skipping persisted custom path — contains unsafe characters',
          );
          continue;
        }
        customPaths.set(key, value);
      }
    }
  } catch {
    // File missing or malformed — start with empty overrides
  }
}

async function persistCustomPaths(env: Env): Promise<void> {
  const obj = Object.fromEntries(customPaths);
  const filePath = customPathsFilePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function autoUploadFilePath(env: Env): string {
  return path.join(path.dirname(path.resolve(env.TRANSFER_STATE_PATH)), AUTO_UPLOAD_FILE);
}

async function loadAutoUpload(env: Env): Promise<void> {
  try {
    const raw = await fs.readFile(autoUploadFilePath(env), 'utf8');
    const parsed = JSON.parse(raw) as { enabled?: boolean };
    autoUploadEnabled = parsed.enabled === true;
  } catch {
    // File missing or malformed — default off
    autoUploadEnabled = false;
  }
}

async function persistAutoUpload(env: Env): Promise<void> {
  const filePath = autoUploadFilePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ enabled: autoUploadEnabled }, null, 2), 'utf8');
}
// Cache for manifest destination keys (invalidated when manifest file changes)
const manifestKeysCache = new Map<string, {
  mtimeMs: number;
  size: number;
  keys: Set<string>;
}>();

let pipelineState: PipelineState | null = null;
let resolvedWorkDir: string | null = null;
let resolvedEnv: Env | null = null;

/** Load pipeline state from disk (lazy, once per process). */
async function ensurePipelineState(workDir: string): Promise<PipelineState> {
  if (pipelineState && resolvedWorkDir === workDir) return pipelineState;
  pipelineState = await loadPipelineState(workDir);
  resolvedWorkDir = workDir;

  // Recover from a crash: if last action was in-progress, mark it as failed
  if (pipelineState.lastAction && !pipelineState.lastAction.finishedAt) {
    markStepFinished(
      pipelineState,
      pipelineState.lastAction.action,
      false,
      new Date().toISOString(),
      -1,
      ['Process was interrupted (server restart detected)'],
    );
    await savePipelineState(workDir, pipelineState);
  }

  return pipelineState;
}

/** Persist pipeline state to disk (fire-and-forget, never throws). */
function persistPipelineState(): void {
  if (!pipelineState || !resolvedWorkDir) return;
  savePipelineState(resolvedWorkDir, pipelineState).catch((err) => {
    log.debug({ err }, '[takeout] Failed to persist pipeline state');
  });
}

export async function registerTakeoutRoutes(app: FastifyInstance, env: Env): Promise<void> {
  // ── Load persisted settings from previous session ──────────────────────
  await loadCustomPaths(env);
  await loadAutoUpload(env);
  resolvedEnv = env;

  // If auto-upload was enabled in a previous session, start the poll so
  // archives dropped while the server was down are picked up automatically.
  if (autoUploadEnabled) {
    ensureAutoUploadPoll();
    // Delayed initial check — give routes time to finish registering
    scheduleAutoUploadAction('scan', env);
  }

  // Clear all timers on close so the process can exit cleanly (important in
  // tests where app.close() must allow the worker to terminate immediately).
  app.addHook('onClose', (_instance, done) => {
    clearAutoUploadTimeout();
    stopAutoUploadPoll();
    if (currentTimeout) {
      clearTimeout(currentTimeout);
      currentTimeout = null;
    }
    // Unref the underlying HTTP server so it doesn't keep the event loop alive
    // after all tests complete. Safe in production too (close() is only called
    // during shutdown, at which point we want the process to be able to exit).
    app.server.unref();
    done();
  });

  // ── Override any configurable path ──────────────────────────────────────

  app.put('/takeout/paths/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const def = OVERRIDABLE_PATHS[name as OverridablePathName];
    if (!def) {
      return reply.code(400).send(apiError('INVALID_INPUT', `Unknown path name: ${name}`));
    }
    const body = req.body as { value?: string } | null;
    const value = body?.value?.trim();
    if (!value || value.length === 0) {
      return reply.code(400).send(apiError('INVALID_INPUT', 'value is required'));
    }
    const pathError = validateCustomPath(value);
    if (pathError) {
      return reply.code(400).send(apiError('INVALID_INPUT', pathError));
    }
    const resolved = path.resolve(value);
    customPaths.set(name, resolved);
    try {
      await persistCustomPaths(env);
    } catch (err) {
      customPaths.delete(name);
      return reply.code(500).send(apiError('INTERNAL_ERROR', 'Failed to persist custom path override'));
    }
    return { name, value: resolved };
  });

  app.delete('/takeout/paths/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const def = OVERRIDABLE_PATHS[name as OverridablePathName];
    if (!def) {
      return reply.code(400).send(apiError('INVALID_INPUT', `Unknown path name: ${name}`));
    }
    customPaths.delete(name);
    try {
      await persistCustomPaths(env);
    } catch {
      return reply.code(500).send(apiError('INTERNAL_ERROR', 'Failed to persist custom path override reset'));
    }
    const envValue = env[def.envKey];
    return { name, value: envValue ? path.resolve(envValue) : undefined, reset: true };
  });

  // ── Reset upload state ────────────────────────────────────────────────
  app.post('/takeout/reset-upload-state', {
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (_req, reply) => {
    if (RUN_STATUS.running) {
      return reply.code(409).send(
        apiError('ACTION_ALREADY_RUNNING', 'Cannot reset upload state while an action is running'),
      );
    }
    const workDir = customPaths.get('workDir') ?? path.resolve(env.TAKEOUT_WORK_DIR);
    const externalRun = await detectExternalRun(workDir);
    if (externalRun) {
      return reply.code(409).send(
        apiError(
          'EXTERNAL_JOB_RUNNING',
          `An external takeout run is in progress (pid=${externalRun.pid}, since ${externalRun.startedAt}). Stop it before resetting upload state.`,
        ),
      );
    }

    const statePath = path.resolve(env.TRANSFER_STATE_PATH);
    const archiveStatePath = path.join(workDir, 'archive-state.json');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    try {
      // Back up current state files before resetting
      try {
        await fs.copyFile(statePath, `${statePath}.pre-reset-${timestamp}.bak`);
      } catch { /* file may not exist yet */ }
      try {
        await fs.copyFile(archiveStatePath, `${archiveStatePath}.pre-reset-${timestamp}.bak`);
      } catch { /* file may not exist yet */ }

      // Write clean upload state
      const cleanState: UploadState = {
        version: 1,
        updatedAt: new Date().toISOString(),
        items: {},
      };
      await fs.writeFile(statePath, JSON.stringify(cleanState, null, 2), 'utf8');

      // Write clean archive state
      const cleanArchiveState = createEmptyArchiveState();
      await persistArchiveState(archiveStatePath, cleanArchiveState);

      return {
        message: 'Upload state reset successfully',
        backedUp: { statePath: `${statePath}.pre-reset-${timestamp}.bak`, archiveStatePath: `${archiveStatePath}.pre-reset-${timestamp}.bak` },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.code(500).send(apiError('INTERNAL_ERROR', `Failed to reset upload state: ${msg}`));
    }
  });

  // Legacy convenience aliases (thin wrappers around the generic endpoints)
  app.put('/takeout/input-dir', async (req, reply) => {
    const body = req.body as { inputDir?: string } | null;
    const dir = body?.inputDir?.trim();
    if (!dir || dir.length === 0) {
      return reply.code(400).send(apiError('INVALID_INPUT', 'inputDir is required'));
    }
    const pathError = validateCustomPath(dir);
    if (pathError) {
      return reply.code(400).send(apiError('INVALID_INPUT', pathError));
    }
    customPaths.set('inputDir', path.resolve(dir));
    try {
      await persistCustomPaths(env);
    } catch {
      customPaths.delete('inputDir');
      return reply.code(500).send(apiError('INTERNAL_ERROR', 'Failed to persist input directory override'));
    }
    return { inputDir: customPaths.get('inputDir') };
  });

  app.delete('/takeout/input-dir', async (_req, reply) => {
    customPaths.delete('inputDir');
    try {
      await persistCustomPaths(env);
    } catch {
      return reply.code(500).send(apiError('INTERNAL_ERROR', 'Failed to persist input directory override reset'));
    }
    return { inputDir: path.resolve(env.TAKEOUT_INPUT_DIR), reset: true };
  });

  app.put('/takeout/work-dir', async (req, reply) => {
    const body = req.body as { workDir?: string } | null;
    const dir = body?.workDir?.trim();
    if (!dir || dir.length === 0) {
      return reply.code(400).send(apiError('INVALID_INPUT', 'workDir is required'));
    }
    const pathError = validateCustomPath(dir);
    if (pathError) {
      return reply.code(400).send(apiError('INVALID_INPUT', pathError));
    }
    customPaths.set('workDir', path.resolve(dir));
    try {
      await persistCustomPaths(env);
    } catch {
      customPaths.delete('workDir');
      return reply.code(500).send(apiError('INTERNAL_ERROR', 'Failed to persist work directory override'));
    }
    return { workDir: customPaths.get('workDir') };
  });

  app.delete('/takeout/work-dir', async (_req, reply) => {
    customPaths.delete('workDir');
    try {
      await persistCustomPaths(env);
    } catch {
      return reply.code(500).send(apiError('INTERNAL_ERROR', 'Failed to persist work directory override reset'));
    }
    return { workDir: path.resolve(env.TAKEOUT_WORK_DIR), reset: true };
  });

  app.get('/takeout/status', async () => {
    const inputDir = customPaths.get('inputDir') ?? path.resolve(env.TAKEOUT_INPUT_DIR);
    const workDir = customPaths.get('workDir') ?? path.resolve(env.TAKEOUT_WORK_DIR);
    const archiveDir = customPaths.get('archiveDir') ?? (env.TAKEOUT_ARCHIVE_DIR ? path.resolve(env.TAKEOUT_ARCHIVE_DIR) : undefined);
    const defaultWorkDir = path.resolve(env.TAKEOUT_WORK_DIR);
    const statePath = path.resolve(env.TRANSFER_STATE_PATH);
    const manifestPath = path.join(workDir, 'manifest.jsonl');

    // Detect a foreign takeout writer (CLI overnight job, or another API
    // instance) so the frontend can disable mutation buttons. The lock is
    // held only while a writer is actively touching state files; absence
    // means it's safe to spawn a new action.
    const externalRun = await detectExternalRun(workDir);
    // When an external run is in flight, also surface whether a graceful
    // pause has already been requested so the UI can switch the button to
    // "Pause requested…" instead of letting the user click it again.
    const externalRunWithPauseState = externalRun
      ? { ...externalRun, pausePending: await isPauseRequested(workDir) }
      : null;

    const [state, manifestKeys, pipeline, initialArchiveState] = await Promise.all([
      loadUploadState(statePath),
      readManifestKeys(manifestPath),
      ensurePipelineState(workDir),
      loadMergedArchiveState(workDir, defaultWorkDir),
    ]);
    let mergedArchiveState = initialArchiveState;

    // Count only state entries that correspond to current manifest keys.
    // This avoids inflated counts from orphaned keys left over by previous runs.
    const manifestItems: Record<string, UploadStateItem> = {};
    for (const key of manifestKeys) {
      const item = state.items[key];
      if (item) manifestItems[key] = item;
    }

    const summary = summarizeState(manifestItems);
    let total = manifestKeys.size;
    const processed = summary.uploaded + summary.skipped + summary.failed;
    let pending = Math.max(total - processed, 0);
    const progress = total > 0 ? Math.min(processed / total, 1) : 0;

    // Count archive files waiting in the input directory (needed for reconciliation guard)
    let archivesInInput = 0;
    try {
      const inputEntries = await fs.readdir(inputDir, { withFileTypes: true });
      archivesInInput = inputEntries.filter(
        (e) => e.isFile() && /\.(zip|tar|tgz|tar\.gz)$/i.test(e.name),
      ).length;
    } catch (err) {
      app.log.debug({ err, inputDir }, 'Unable to list takeout input directory');
    }

    // Detect stale manifest: all archives completed/failed (none pending/extracting/uploading),
    // no archive files left in input, but manifest still has entries with no upload state record.
    // These are orphaned entries from the scan phase whose destinationKeys differ from what the
    // upload actually produced.  Only auto-reconcile when there are no more archives to process.
    const hasActiveArchives = Object.values(mergedArchiveState).some(
      (a) => a.status === 'pending' || a.status === 'extracting' || a.status === 'uploading',
    );
    const hasCompletedArchives = Object.values(mergedArchiveState).some(
      (a) => a.status === 'completed',
    );
    if (pending > 0 && archivesInInput === 0 && !hasActiveArchives && hasCompletedArchives && !RUN_STATUS.running) {
      try {
        const reconciled = await reconcileManifest(manifestPath, statePath);
        if (reconciled.removed > 0) {
          app.log.info(
            { removed: reconciled.removed, kept: reconciled.kept },
            'Auto-reconciled stale manifest entries',
          );
          // Invalidate the manifest cache so the next read picks up the cleaned file
          manifestKeysCache.delete(manifestPath);
          // Recompute counts after reconciliation
          total = reconciled.kept;
          pending = Math.max(total - processed, 0);
        }
      } catch (err) {
        app.log.warn({ err }, 'Failed to auto-reconcile stale manifest entries');
      }
    }

    // Auto-reconcile stale pending/extracting archives when all uploads are done
    const isComplete = total > 0 && pending === 0 && summary.failed === 0;
    const hasStaleArchives = Object.values(mergedArchiveState).some(
      (a) => a.status === 'pending' || a.status === 'extracting' || a.status === 'uploading',
    );
    if (isComplete && hasStaleArchives) {
      const displayReconciled = reconcileArchiveEntriesForDisplay(mergedArchiveState);
      if (displayReconciled.reconciled > 0) {
        mergedArchiveState = displayReconciled.archives;
      }

      const archiveStatePath = path.join(workDir, 'archive-state.json');
      try {
        await reconcileStaleArchives(archiveStatePath);
      } catch (err) {
        app.log.warn({ err, archiveStatePath }, 'Failed to persist reconciled archive state; serving in-memory status');
      }
    }

    const archiveHistory = await buildArchiveHistory(mergedArchiveState, inputDir);

    return {
      paths: {
        inputDir,
        workDir,
        archiveDir,
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
      isComplete,
      archivesInInput,
      archiveHistory,
      pipeline: buildPipelineSummary(pipeline),
      autoUpload: autoUploadEnabled,
      externalRun: externalRunWithPauseState,
    };
  });

  app.get('/takeout/action-status', async () => {
    return snapshotStatus();
  });

  // ── Archive sequence gap analysis ───────────────────────────────────────

  app.get('/takeout/sequence-analysis', async () => {
    const inputDir = customPaths.get('inputDir') ?? path.resolve(env.TAKEOUT_INPUT_DIR);
    const workDir = customPaths.get('workDir') ?? path.resolve(env.TAKEOUT_WORK_DIR);
    const defaultWorkDir = path.resolve(env.TAKEOUT_WORK_DIR);

    // Collect archive names from archive-state (completed/verified), input dir, and uploaded-archives
    const archiveState = await loadMergedArchiveState(workDir, defaultWorkDir);
    const stateNames = Object.keys(archiveState);

    // Also scan uploaded-archives dir for moved archives
    const uploadedArchiveDir = path.join(inputDir, 'uploaded-archives');
    let uploadedArchiveNames: string[] = [];
    try {
      const entries = await fs.readdir(uploadedArchiveDir, { withFileTypes: true });
      uploadedArchiveNames = entries
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {
      // Directory may not exist
    }

    // Also scan input dir for pending archives
    let inputArchiveNames: string[] = [];
    try {
      const entries = await fs.readdir(inputDir, { withFileTypes: true });
      inputArchiveNames = entries
        .filter((e) => e.isFile() && /\.(zip|tar|tgz|tar\.gz)$/i.test(e.name))
        .map((e) => e.name);
    } catch {
      // Directory may not exist
    }

    // Deduplicate all names
    const allNames = [...new Set([...stateNames, ...uploadedArchiveNames, ...inputArchiveNames])];

    const analysis = analyseArchiveSequences(allNames);

    // Build per-archive detail from archive-state
    const archiveDetails: Record<string, {
      status: string;
      entryCount?: number;
      uploadedCount?: number;
      skippedCount?: number;
      failedCount?: number;
      archiveSizeBytes?: number;
      mediaBytes?: number;
      completedAt?: string;
      error?: string;
    }> = {};
    for (const [name, item] of Object.entries(archiveState)) {
      const detail = {
        status: item.status,
        entryCount: item.entryCount,
        uploadedCount: item.uploadedCount,
        skippedCount: item.skippedCount,
        failedCount: item.failedCount,
        archiveSizeBytes: item.archiveSizeBytes,
        mediaBytes: item.mediaBytes,
        completedAt: item.completedAt,
        error: item.error,
      };
      archiveDetails[name] = detail;
      // Also index by normalised name so lookups work for " (1)" duplicates
      const normalised = normaliseArchiveName(name);
      if (normalised !== name && !archiveDetails[normalised]) {
        archiveDetails[normalised] = detail;
      }
    }

    // Compute group-level aggregates
    const groupStats = analysis.groups.map((g) => {
      let totalSizeBytes = 0;
      let totalMediaBytes = 0;
      let totalEntries = 0;
      let totalUploaded = 0;
      let totalSkipped = 0;
      let totalFailed = 0;
      const errors: string[] = [];

      for (let seq = 1; seq <= g.maxSeen; seq++) {
        const archiveName = `${g.prefix}-${g.exportNumber}-${String(seq).padStart(3, '0')}${g.extension}`;
        const detail = archiveDetails[archiveName];
        if (detail) {
          totalSizeBytes += detail.archiveSizeBytes ?? 0;
          totalMediaBytes += detail.mediaBytes ?? 0;
          totalEntries += detail.entryCount ?? 0;
          totalUploaded += detail.uploadedCount ?? 0;
          totalSkipped += detail.skippedCount ?? 0;
          totalFailed += detail.failedCount ?? 0;
          if (detail.error) errors.push(`Part ${seq}: ${detail.error}`);
        }
      }

      return {
        ...g,
        totalSizeBytes,
        totalMediaBytes,
        totalEntries,
        totalUploaded,
        totalSkipped,
        totalFailed,
        errors,
      };
    });

    return {
      ...analysis,
      groups: groupStats,
      archiveDetails,
    };
  });

  // ── Auto-upload toggle ──────────────────────────────────────────────────

  app.get('/takeout/auto-upload', async () => {
    return { enabled: autoUploadEnabled };
  });

  app.put('/takeout/auto-upload', async (req, reply) => {
    const body = req.body as { enabled?: boolean } | null;
    const shouldEnable = body?.enabled === true;
    if (shouldEnable) {
      const workDir = customPaths.get('workDir') ?? path.resolve(env.TAKEOUT_WORK_DIR);
      const externalRun = await detectExternalRun(workDir);
      if (externalRun) {
        return reply.code(409).send(
          apiError(
            'EXTERNAL_JOB_RUNNING',
            `An external takeout run is in progress (pid=${externalRun.pid}, since ${externalRun.startedAt}). Wait for it to finish before enabling auto-upload.`,
          ),
        );
      }
    }
    autoUploadEnabled = shouldEnable;
    try {
      await persistAutoUpload(env);
    } catch {
      autoUploadEnabled = false;
      return reply.code(500).send({
        ...apiError('INTERNAL_ERROR', 'Failed to persist auto-upload setting'),
        enabled: false,
      });
    }

    if (autoUploadEnabled) {
      // Start the recurring poll and do an immediate check
      ensureAutoUploadPoll();
      if (!RUN_STATUS.running) {
        scheduleAutoUploadAction('scan', env);
      }
    } else {
      // Disabled — cancel any pending auto-action and stop polling
      clearAutoUploadTimeout();
      stopAutoUploadPoll();
    }

    return { enabled: autoUploadEnabled };
  });

  app.post('/takeout/actions/:action', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const action = (req.params as { action?: string }).action;

    // Special case: pause the currently running action
    if (action === 'pause') {
      // Case 1: in-process action — use the existing fast path (kill the
      // child, set pauseRequested so the action loop persists state and
      // marks the run as paused for the UI).
      if (RUN_STATUS.running && currentProcess) {
        pauseRequested = true;
        currentProcess.kill();
        return reply.code(202).send({
          message: 'Pausing current action',
          status: snapshotStatus(),
        });
      }

      // Case 2: external CLI run holds the lock. We cannot signal it
      // directly across process trees, so we set a flag the CLI polls at
      // each archive boundary. The CLI then exits cleanly with state in
      // a fully-resumable shape.
      const workDir = customPaths.get('workDir') ?? path.resolve(env.TAKEOUT_WORK_DIR);
      const externalRun = await detectExternalRun(workDir);
      if (externalRun) {
        try {
          await requestPause(workDir, 'pause requested via API');
        } catch (err) {
          log.warn({ err, workDir }, 'Failed to write takeout pause flag');
          return reply.code(500).send(
            apiError('PAUSE_WRITE_FAILED', 'Failed to write pause flag for external run'),
          );
        }
        return reply.code(202).send({
          message:
            'Graceful pause requested — the external run will stop after the current archive',
          external: true,
          pid: externalRun.pid,
        });
      }

      return reply.code(409).send(
        apiError('NO_ACTION_RUNNING', 'No action is currently running to pause'),
      );
    }

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

    const workDir = customPaths.get('workDir') ?? path.resolve(env.TAKEOUT_WORK_DIR);
    const externalRun = await detectExternalRun(workDir);
    if (externalRun) {
      return reply.code(409).send(
        apiError(
          'EXTERNAL_JOB_RUNNING',
          `An external takeout run is in progress (pid=${externalRun.pid}, since ${externalRun.startedAt}). Wait for it to finish or stop it first.`,
        ),
      );
    }

    // Guard: prevent upload/resume when there are no archives to process.
    // Without archives the script exits instantly (0 pending), which looks
    // like an infinite start-then-idle loop to the user.
    if (action === 'upload' || action === 'resume') {
      const inputDir = customPaths.get('inputDir') ?? path.resolve(env.TAKEOUT_INPUT_DIR);
      const archiveCount = await countArchivesInInput(inputDir);
      if (archiveCount === 0) {
        return reply.code(409).send(
          apiError(
            'NO_ARCHIVES',
            'No archive files found in the input directory. Move .tgz/.zip archives into the input folder and re-scan before uploading.',
          ),
        );
      }
      // Clear any stale graceful-pause flag from a previous run so the new
      // upload doesn't immediately exit at the first archive boundary.
      await clearPauseFlag(workDir).catch((err: unknown) => {
        log.warn({ err, workDir }, 'Failed to clear stale takeout pause flag before run');
      });
    }

    runAction(action);

    return reply.code(202).send({
      message: `Started ${action}`,
      status: snapshotStatus(),
    });
  });
}

async function loadMergedArchiveState(
  activeWorkDir: string,
  defaultWorkDir: string,
): Promise<Record<string, ArchiveStateItem>> {
  const activePath = path.join(activeWorkDir, 'archive-state.json');

  if (activeWorkDir === defaultWorkDir) {
    const state = await loadArchiveState(activePath);
    return state.archives;
  }

  const fallbackPath = path.join(defaultWorkDir, 'archive-state.json');
  const [active, fallback] = await Promise.all([
    loadArchiveState(activePath),
    loadArchiveState(fallbackPath),
  ]);

  // Keep all history entries; active dir wins on exact key collisions.
  return {
    ...fallback.archives,
    ...active.archives,
  };
}

function reconcileArchiveEntriesForDisplay(
  archives: Record<string, ArchiveStateItem>,
): { archives: Record<string, ArchiveStateItem>; reconciled: number } {
  // Delegate to the shared reconciliation logic so display matches persistence
  return reconcileArchiveEntries(archives);
}

/**
 * Detect whether a foreign takeout writer holds the run lock. Returns
 * `null` when the lock is absent OR is held by a child process this API
 * spawned (the latter is reflected via `RUN_STATUS.running`, no need to
 * surface it as "external"). Returns the lock info otherwise so the
 * frontend can disable mutation buttons.
 */
async function detectExternalRun(workDir: string): Promise<RunLockInfo | null> {
  let lock: RunLockInfo | null;
  try {
    lock = await readRunLock(workDir);
  } catch (err) {
    log.warn({ err }, 'Unable to verify takeout run lock; treating lock state as external');
    return {
      pid: -1,
      startedAt: new Date().toISOString(),
      source: 'cli',
      command: 'Unable to verify takeout run lock; mutations are disabled until the lock can be read.',
    };
  }
  if (!lock) return null;
  // The API itself is never the lock holder — only its spawned child can be.
  if (lock.pid === process.pid) return null;
  // Token survives npm/tsx child-process layering, unlike PIDs.
  if (RUN_STATUS.running && currentRunToken && lock.runToken === currentRunToken) return null;
  // Treat a lock held by our currently-tracked child as in-flight, not foreign.
  if (currentProcess?.pid && lock.pid === currentProcess.pid) return null;
  return lock;
}

function runAction(action: TakeoutAction): void {
  const projectRoot = path.resolve(process.cwd());
  const commands = resolveActionCommands(action);

  const startedAt = new Date().toISOString();
  currentRunToken = crypto.randomUUID();
  RUN_STATUS.running = true;
  RUN_STATUS.action = action;
  RUN_STATUS.startedAt = startedAt;
  RUN_STATUS.finishedAt = undefined;
  RUN_STATUS.exitCode = undefined;
  RUN_STATUS.success = undefined;
  RUN_STATUS.paused = undefined;
  RUN_STATUS.output = [];

  // Update pipeline state
  if (pipelineState) {
    markStepStarted(pipelineState, action, startedAt);
    persistPipelineState();
  }

  // Create a TransferJob record so uploads appear on the /transfers page.
  if (action === 'upload' || action === 'resume') {
    createTransferJobForUpload();
  }

  const runCommand = (index: number): void => {
    const current = commands[index];
    const child = spawn(current.command, current.args, {
      cwd: projectRoot,
      env: { ...process.env, TAKEOUT_RUN_TOKEN: currentRunToken ?? '' },
      shell: os.platform() === 'win32',
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
      const timedOutAt = new Date().toISOString();
      RUN_STATUS.running = false;
      RUN_STATUS.finishedAt = timedOutAt;
      RUN_STATUS.exitCode = -1;
      RUN_STATUS.success = false;
      currentProcess = null;
      currentRunToken = null;
      currentTimeout = null;
      finalizeTransferJob(false, 'Upload timed out');
      if (pipelineState) {
        markStepFinished(pipelineState, action, false, timedOutAt, -1, RUN_STATUS.output.slice(-50));
        persistPipelineState();
      }
    }, ACTION_TIMEOUT_MS);
    // Don't prevent the process from exiting if the timer is the only active handle.
    currentTimeout.unref();

    child.stdout.on('data', (chunk) => {
      appendOutput(String(chunk));
    });

    child.stderr.on('data', (chunk) => {
      appendOutput(String(chunk));
    });

    child.on('error', (error) => {
      appendOutput(`Process error: ${error.message}`);
      const errorAt = new Date().toISOString();
      RUN_STATUS.running = false;
      RUN_STATUS.finishedAt = errorAt;
      RUN_STATUS.exitCode = -1;
      RUN_STATUS.success = false;
      currentProcess = null;
      currentRunToken = null;
      if (currentTimeout) {
        clearTimeout(currentTimeout);
        currentTimeout = null;
      }
      finalizeTransferJob(false, error.message);
      if (pipelineState) {
        markStepFinished(pipelineState, action, false, errorAt, -1, RUN_STATUS.output.slice(-50));
        persistPipelineState();
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

      // Handle pause: the process was killed intentionally by the user
      if (pauseRequested) {
        pauseRequested = false;
        const pausedAt = new Date().toISOString();
        RUN_STATUS.running = false;
        RUN_STATUS.finishedAt = pausedAt;
        RUN_STATUS.exitCode = exitCode;
        RUN_STATUS.success = undefined;
        RUN_STATUS.paused = true;
        currentRunToken = null;
        appendOutput('⏸️ Upload paused. Resume anytime to continue where you left off.');
        finalizeTransferJob(false, 'Paused by user');
        return;
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
        finalizeTransferJob(true);
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
      currentRunToken = null;
      RUN_STATUS.success = success;
      if (!success) {
        finalizeTransferJob(false, `Process exited with code ${exitCode}`);
      }
      if (pipelineState) {
        markStepFinished(pipelineState, action, success, RUN_STATUS.finishedAt!, exitCode, RUN_STATUS.output.slice(-50));
        persistPipelineState();
      }
      if (action === 'start-services' && !success) {
        appendStartServicesFailureHints();
      }
      appendOutput(`Action finished with code ${exitCode}`);

      // Auto-upload: chain next action when enabled
      if (success && autoUploadEnabled && resolvedEnv) {
        if (action === 'scan') {
          // Scan finished → start upload if there are pending files
          scheduleAutoUploadAction('upload', resolvedEnv);
        } else if (action === 'cleanup-move' || action === 'cleanup-delete') {
          // Cleanup finished → check for new archives
          scheduleAutoUploadAction('scan', resolvedEnv);
        }
      }
      // When auto-upload is on and we just finished any action, ensure the
      // recurring poll is alive so we keep watching for new archives.
      if (autoUploadEnabled) {
        ensureAutoUploadPoll();
      }
    });
  };

  runCommand(0);
}

/**
 * Schedule the next auto-upload action after a short delay.
 * Cancels any previously pending auto-upload timeout to prevent stacking.
 */
function scheduleAutoUploadAction(nextAction: 'scan' | 'upload', env: Env): void {
  clearAutoUploadTimeout();
  autoUploadPending = nextAction;

  if (nextAction === 'upload') {
    appendOutput('🔄 Auto-upload: starting upload shortly...');
  } else {
    appendOutput('🔄 Auto-upload: checking for new archives shortly...');
  }

  autoUploadTimeout = setTimeout(async () => {
    autoUploadTimeout = null;
    autoUploadPending = null;

    if (!autoUploadEnabled || RUN_STATUS.running) return;

    const workDir = customPaths.get('workDir') ?? path.resolve(env.TAKEOUT_WORK_DIR);
    const externalRun = await detectExternalRun(workDir);
    if (externalRun) {
      appendOutput(`🔄 Auto-upload: external run detected (pid=${externalRun.pid}) — skipping this poll.`);
      return;
    }

    if (nextAction === 'upload') {
      // Verify there's actually something to upload before firing
      const manifestPath = path.join(workDir, 'manifest.jsonl');
      const keys = await readManifestKeys(manifestPath);
      if (keys.size === 0) {
        appendOutput('🔄 Auto-upload: scan produced no files to upload — skipping.');
        return;
      }
      // Re-check after async gap — poll callback may have started an action
      if (RUN_STATUS.running) return;
      appendOutput(`🔄 Auto-upload: ${keys.size} manifest entries found — starting upload...`);
      runAction('upload');
    } else {
      // Check input directory for archives that haven't been completed yet
      const inputDir = customPaths.get('inputDir') ?? path.resolve(env.TAKEOUT_INPUT_DIR);
      const count = await countPendingArchivesInInput(inputDir, workDir);
      if (count > 0) {
        // Re-check after async gap — poll callback may have started an action
        if (RUN_STATUS.running) return;
        appendOutput(`🔄 Auto-upload: ${count} pending archive(s) found — starting scan...`);
        runAction('scan');
      } else {
        appendOutput('🔄 Auto-upload: all archives already completed. Polling will continue...');
      }
    }
  }, AUTO_UPLOAD_DELAY_MS);
  // Don't prevent the process from exiting if the timer is the only active handle.
  autoUploadTimeout.unref();
}

/** Cancel a pending auto-upload timeout. */
function clearAutoUploadTimeout(): void {
  if (autoUploadTimeout) {
    clearTimeout(autoUploadTimeout);
    autoUploadTimeout = null;
  }
  autoUploadPending = null;
}

/**
 * Ensure a recurring poll is running that watches the input directory for new
 * archives when auto-upload is enabled and the system is idle.
 * This closes the gap where the one-shot check finds nothing and stops.
 */
function ensureAutoUploadPoll(): void {
  // Already running
  if (autoUploadPollInterval) return;
  if (!autoUploadEnabled || !resolvedEnv) return;

  const env = resolvedEnv;
  autoUploadPollInterval = setInterval(async () => {
    // Stop polling if auto-upload was disabled
    if (!autoUploadEnabled) {
      stopAutoUploadPoll();
      return;
    }
    // Don't interfere if an action is already running or queued
    if (RUN_STATUS.running || autoUploadTimeout) return;

    const inputDir = customPaths.get('inputDir') ?? path.resolve(env.TAKEOUT_INPUT_DIR);
    const workDir = customPaths.get('workDir') ?? path.resolve(env.TAKEOUT_WORK_DIR);
    const externalRun = await detectExternalRun(workDir);
    if (externalRun) {
      appendOutput(`🔄 Auto-upload poll: external run detected (pid=${externalRun.pid}) — skipping this poll.`);
      return;
    }
    const count = await countPendingArchivesInInput(inputDir, workDir);
    if (count > 0) {
      // Re-check after async gap — timeout callback may have started an action
      if (RUN_STATUS.running) return;
      appendOutput(`🔄 Auto-upload poll: ${count} pending archive(s) detected — starting scan...`);
      runAction('scan');
    }
  }, AUTO_UPLOAD_POLL_INTERVAL_MS);
  // Don't prevent the process from exiting if the interval is the only active handle.
  autoUploadPollInterval.unref();
}

/** Stop the recurring auto-upload poll. */
function stopAutoUploadPoll(): void {
  if (autoUploadPollInterval) {
    clearInterval(autoUploadPollInterval);
    autoUploadPollInterval = null;
  }
}

/** Count archive files in a directory (returns 0 if dir doesn't exist). */
async function countArchivesInInput(inputDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(inputDir, { withFileTypes: true });
    return entries.filter(
      (e) => e.isFile() && /\.(zip|tar|tgz|tar\.gz)$/i.test(e.name),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Count archives in the input directory that are NOT yet completed.
 * Used by auto-upload to avoid re-triggering scans for already-finished archives.
 */
async function countPendingArchivesInInput(inputDir: string, workDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(inputDir, { withFileTypes: true });
    const archiveNames = entries
      .filter((e) => e.isFile() && /\.(zip|tar|tgz|tar\.gz)$/i.test(e.name))
      .map((e) => e.name);
    if (archiveNames.length === 0) return 0;

    const archiveStatePath = path.join(workDir, 'archive-state.json');
    const archiveState = await loadArchiveState(archiveStatePath);
    return archiveNames.filter(
      (name) => archiveState.archives[name]?.status !== 'completed',
    ).length;
  } catch {
    return 0;
  }
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
    'repair-dates': 'takeout:repair-dates -- --apply',
    'repair-dates-s3': (() => {
      const workDir = customPaths.get('workDir') ?? (resolvedEnv ? path.resolve(resolvedEnv.TAKEOUT_WORK_DIR) : 'data/takeout/work');
      const metadataDir = path.join(workDir, 'metadata');
      return `takeout:repair-dates-s3 -- --apply --video --metadata-dir ${metadataDir}`;
    })(),
    'cleanup-move': 'takeout:cleanup -- --apply --move-archives --include-unscanned',
    'cleanup-delete': 'takeout:cleanup -- --apply --delete-archives --include-unscanned',
    'cleanup-force-move': 'takeout:cleanup -- --apply --move-archives --force --include-unscanned',
    'cleanup-force-delete': 'takeout:cleanup -- --apply --delete-archives --force --include-unscanned',
  };

  let scriptArgs = scriptByAction[action].split(' ');

  // Append custom directory overrides when the user chose them.
  const extraArgs: string[] = [];
  for (const [name, def] of Object.entries(OVERRIDABLE_PATHS)) {
    const value = customPaths.get(name);
    if (value) extraArgs.push(def.cliFlag, value);
  }
  // Auto-enable --move-archives for upload/resume when an archive dir is configured
  if ((action === 'upload' || action === 'resume') && customPaths.has('archiveDir')) {
    extraArgs.push('--move-archives');
  }
  if (extraArgs.length > 0) {
    scriptArgs = [...scriptArgs, '--', ...extraArgs];
  }

  return [{
    command: 'npm',
    args: ['run', ...scriptArgs],
    display: `npm run ${scriptArgs.join(' ')}`,
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

// ---------------------------------------------------------------------------
// Transfer-job helpers – fire-and-forget DB writes wrapped in try/catch so
// a missing PostgreSQL never breaks the takeout flow.
// ---------------------------------------------------------------------------

/** Create a TransferJob record so the /transfers page can show the upload. */
function createTransferJobForUpload(): void {
  createJob({
    sourceProvider: 'Google Takeout',
    destProvider: 'Scaleway S3',
  })
    .then((job) => {
      currentTransferJobId = job.id;
      lastProgressUpdateMs = 0;
      return updateJob(job.id, { status: 'IN_PROGRESS' as const, startedAt: new Date() });
    })
    .catch((err) => {
      log.warn({ err }, '[takeout] Could not create transfer job (DB may be unavailable)');
    });
}

/** Throttled: update the transfer-job progress from upload output lines. */
function maybeUpdateTransferProgress(lines: string[]): void {
  if (!currentTransferJobId) return;

  const now = Date.now();
  if (now - lastProgressUpdateMs < PROGRESS_UPDATE_INTERVAL_MS) return;

  // Scan the batch for the latest progress percentage
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(UPLOAD_PROGRESS_RE);
    if (match) {
      const percent = parseInt(match[1], 10);
      lastProgressUpdateMs = now;
      updateJob(currentTransferJobId, { progress: percent / 100 }).catch((err) => {
        log.debug({ err }, '[takeout] Failed to update transfer-job progress');
      });
      return;
    }
  }
}

/** Mark the current transfer job as COMPLETED or FAILED. */
function finalizeTransferJob(success: boolean, errorMessage?: string): void {
  if (!currentTransferJobId) return;

  const jobId = currentTransferJobId;
  currentTransferJobId = null;

  updateJob(jobId, {
    status: (success ? 'COMPLETED' : 'FAILED') as 'COMPLETED' | 'FAILED',
    progress: success ? 1 : undefined,
    errorMessage: success ? null : (errorMessage ?? 'Unknown error'),
    completedAt: new Date(),
  }).catch((err) => {
    log.warn({ err }, '[takeout] Failed to finalize transfer job');
  });
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
  lastOutputAt = new Date().toISOString();
  if (RUN_STATUS.output.length > MAX_OUTPUT_LINES) {
    RUN_STATUS.output = RUN_STATUS.output.slice(RUN_STATUS.output.length - MAX_OUTPUT_LINES);
  }

  // Throttled progress update for the transfer job
  maybeUpdateTransferProgress(lines);
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
        log.debug({ err }, '[takeout] Ignored malformed scan progress line');
        // malformed line, skip
      }
    }
  }
  return undefined;
}

function parseUploadProgress(): UploadProgressInfo | undefined {
  const output = RUN_STATUS.output;
  const result: Partial<UploadProgressInfo> = {};

  for (let i = output.length - 1; i >= 0; i--) {
    const line = output[i];

    if (!result.speed && line.includes('items') && line.includes('speed')) {
      const speedMatch = line.match(/speed\s+(.+?)\/s/);
      const etaMatch = line.match(/ETA\s+(.+?)\s*\|/);
      const inFlightMatch = line.match(/in-flight\s+(\d+)/);
      const bytesMatch = line.match(/bytes\s+(.+?)\s*\/\s*(.+?)\s*\((\d+)%\)/);

      if (speedMatch) result.speed = speedMatch[1].trim();
      if (etaMatch) result.eta = etaMatch[1].trim();
      if (inFlightMatch) result.inFlight = parseInt(inFlightMatch[1], 10);
      if (bytesMatch) {
        result.bytesTransferred = bytesMatch[1].trim();
        result.bytesTotal = bytesMatch[2].trim();
        result.bytePercent = parseInt(bytesMatch[3], 10);
      }
    }

    if (!result.currentArchive && line.includes('Processing archive:')) {
      const archiveMatch = line.match(/\[(\d+)\/(\d+)\]\s*Processing archive:\s*(.+)/);
      if (archiveMatch) {
        result.currentArchiveIndex = parseInt(archiveMatch[1], 10);
        result.totalArchives = parseInt(archiveMatch[2], 10);
        result.currentArchive = archiveMatch[3].trim();
      }
    }

    if (result.speed && result.currentArchive) break;
  }

  if (!result.speed && !result.currentArchive) return undefined;
  return result as UploadProgressInfo;
}

function snapshotStatus(): ActionStatus {
  const scanProgress = (RUN_STATUS.running && RUN_STATUS.action === 'scan')
    ? parseScanProgress()
    : undefined;

  const isUploadLike = RUN_STATUS.action === 'upload' || RUN_STATUS.action === 'resume';
  const uploadProgress = (RUN_STATUS.running && isUploadLike)
    ? parseUploadProgress()
    : undefined;

  return {
    running: RUN_STATUS.running,
    paused: RUN_STATUS.paused,
    action: RUN_STATUS.action,
    startedAt: RUN_STATUS.startedAt,
    finishedAt: RUN_STATUS.finishedAt,
    exitCode: RUN_STATUS.exitCode,
    success: RUN_STATUS.success,
    output: [...RUN_STATUS.output],
    scanProgress,
    uploadProgress,
    lastOutputAt: lastOutputAt,
    autoUploadPending: autoUploadPending,
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
        log.debug({ err }, '[takeout] Ignored malformed manifest line');
      }
    }

    manifestKeysCache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, keys });
    return keys;
  } catch {
    // Manifest doesn't exist yet — return whatever is in cache, or empty.
    // This is expected before the first scan and is silently tolerated.
    const cached = manifestKeysCache.get(manifestPath);
    return cached?.keys ?? new Set();
  }
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

async function buildArchiveHistory(
  archives: Record<string, ArchiveStateItem>,
  inputDir: string,
): Promise<ArchiveHistoryEntry[]> {
  const entries = await Promise.all(
    Object.entries(archives).map(async ([archiveName, item]) => {
      const archiveSizeBytes = item.archiveSizeBytes ?? await resolveArchiveSizeBytes(archiveName, inputDir);
      const processedCount = item.uploadedCount + item.skippedCount + item.failedCount;
      const hasItemAccounting = item.entryCount > 0 || processedCount > 0;
      const handledPercent = item.entryCount > 0
        ? Math.min(100, Math.round((processedCount / item.entryCount) * 10000) / 100)
        : hasItemAccounting && item.status === 'completed'
          ? 100
          : 0;
      const isFullyUploaded = item.status === 'completed'
        && item.failedCount === 0
        && hasItemAccounting
        && handledPercent >= 100;

      return {
        archiveName,
        status: item.status,
        archiveSizeBytes,
        mediaBytes: item.mediaBytes,
        entryCount: item.entryCount,
        uploadedCount: item.uploadedCount,
        skippedCount: item.skippedCount,
        failedCount: item.failedCount,
        handledPercent,
        isFullyUploaded,
        notUploadedReasons: buildNotUploadedReasons(item),
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        error: item.error,
      } satisfies ArchiveHistoryEntry;
    }),
  );

  entries.sort((left, right) => {
    const leftDate = left.completedAt ?? left.startedAt ?? '';
    const rightDate = right.completedAt ?? right.startedAt ?? '';
    if (leftDate !== rightDate) {
      return rightDate.localeCompare(leftDate);
    }
    return left.archiveName.localeCompare(right.archiveName);
  });

  return entries;
}

function buildNotUploadedReasons(item: ArchiveStateItem): ArchiveHistoryEntry['notUploadedReasons'] {
  const reasons: NonNullable<ArchiveHistoryEntry['notUploadedReasons']> = [];

  const skipReasonCounts = item.skipReasons ?? {};
  const reasonDefinitions: Array<{ code: UploadSkipReason; label: string }> = [
    { code: 'already_exists_in_destination', label: 'Already exists in S3' },
    { code: 'already_uploaded_in_state', label: 'Already uploaded in previous run' },
    { code: 'already_skipped_in_state', label: 'Already skipped in previous run' },
  ];

  for (const reason of reasonDefinitions) {
    const count = skipReasonCounts[reason.code] ?? 0;
    if (count > 0) {
      reasons.push({
        code: reason.code,
        label: reason.label,
        count,
      });
    }
  }

  if (item.failedCount > 0) {
    const hasTransient = typeof item.transientFailedCount === 'number';
    const hasPermanent = typeof item.permanentFailedCount === 'number';
    if (hasTransient || hasPermanent) {
      if ((item.transientFailedCount ?? 0) > 0) {
        reasons.push({
          code: 'upload_failed_transient',
          label: 'Upload failed (will retry next pass)',
          count: item.transientFailedCount as number,
        });
      }
      if ((item.permanentFailedCount ?? 0) > 0) {
        reasons.push({
          code: 'upload_failed_permanent',
          label: 'Upload failed (needs re-run)',
          count: item.permanentFailedCount as number,
        });
      }
    } else {
      reasons.push({
        code: 'upload_failed',
        label: 'Upload failed',
        count: item.failedCount,
      });
    }
  }

  return reasons.length > 0 ? reasons : undefined;
}

async function resolveArchiveSizeBytes(
  archiveName: string,
  inputDir: string,
): Promise<number | undefined> {
  const candidatePaths = [
    path.join(inputDir, archiveName),
    path.join(inputDir, 'uploaded-archives', archiveName),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      const stats = await fs.stat(candidatePath);
      if (stats.isFile()) {
        return stats.size;
      }
    } catch {
      // Ignore missing paths and try next location.
    }
  }

  return undefined;
}
