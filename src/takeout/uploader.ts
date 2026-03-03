import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import type { CloudProvider } from '../providers/types.js';
import type { ManifestEntry } from './manifest.js';

export type UploadStateItem = {
  status: 'uploaded' | 'skipped' | 'failed';
  attempts: number;
  updatedAt: string;
  error?: string;
};

export type UploadState = {
  version: 1;
  updatedAt: string;
  items: Record<string, UploadStateItem>;
};

export type UploadSummary = {
  total: number;
  processed: number;
  uploaded: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  stoppedEarly: boolean;
  failureLimitReached: boolean;
};

export type UploadProgressPhase = 'running' | 'completed';

export type UploadProgressItemStatus =
  | 'starting'
  | 'uploading'
  | 'uploaded'
  | 'skipped'
  | 'retrying'
  | 'failed';

export type UploadProgressSnapshot = {
  phase: UploadProgressPhase;
  dryRun: boolean;
  totalItems: number;
  processedItems: number;
  uploadedItems: number;
  skippedItems: number;
  failedItems: number;
  inFlightItems: number;
  totalBytes: number;
  transferredBytes: number;
  timestamp: string;
  lastItem?: {
    key: string;
    sourcePath: string;
    sizeBytes: number;
    uploadedBytes?: number;
    attempt: number;
    status: UploadProgressItemStatus;
    speedBytesPerSec?: number;
    etaSeconds?: number;
    delayMs?: number;
    error?: string;
  };
};

export type UploadOptions = {
  provider: CloudProvider;
  entries: ManifestEntry[];
  statePath: string;
  uploadConcurrency?: number;
  retryCount?: number;
  baseDelayMs?: number;
  dryRun?: boolean;
  maxFailures?: number;
  persistEvery?: number;
  flushIntervalMs?: number;
  includeFilter?: string;
  excludeFilter?: string;
  sleep?: (ms: number) => Promise<void>;
  progressIntervalMs?: number;
  onProgress?: (snapshot: UploadProgressSnapshot) => void;
};

const DEFAULT_RETRY_COUNT = 5;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_UPLOAD_CONCURRENCY = 1;
const DEFAULT_PERSIST_EVERY = 25;
const DEFAULT_FLUSH_INTERVAL_MS = 3000;
const DEFAULT_PROGRESS_INTERVAL_MS = 2000;
const LARGE_FILE_READ_CHUNK_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.dng': 'image/x-adobe-dng',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.3gp': 'video/3gpp',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.gz': 'application/gzip',
};

export async function uploadManifest(options: UploadOptions): Promise<UploadSummary> {
  const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const dryRun = options.dryRun ?? false;
  const uploadConcurrency = Math.max(1, Math.floor(options.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY));
  const persistEvery = Math.max(1, Math.floor(options.persistEvery ?? DEFAULT_PERSIST_EVERY));
  const flushIntervalMs = Math.max(250, Math.floor(options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS));
  const progressIntervalMs = Math.max(
    250,
    Math.floor(options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS),
  );

  const state = await loadUploadState(options.statePath);
  const entries = applyFilters(options.entries, options.includeFilter, options.excludeFilter);
  let preloadedExistingKeys = new Set<string>();
  try {
    preloadedExistingKeys = await preloadDestinationIndex(options.provider, entries);
  } catch (err) {
    console.debug('[uploader] Failed to preload destination index, continuing without preload', err);
    preloadedExistingKeys = new Set<string>();
  }
  const confirmedExistingKeys = new Set<string>(preloadedExistingKeys);
  const existenceCache = new Map<string, boolean>();
  const checkpointManager = new StateCheckpointManager(
    options.statePath,
    state,
    persistEvery,
    flushIntervalMs,
  );

  const summary: UploadSummary = {
    total: entries.length,
    processed: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    dryRun,
    stoppedEarly: false,
    failureLimitReached: false,
  };

  const totalBytes = entries.reduce((sum, entry) => sum + Math.max(0, entry.size ?? 0), 0);
  const inFlightBytes = new Map<string, number>();
  let committedTransferredBytes = 0;
  let lastSnapshotAt = 0;

  const emitSnapshot = (
    phase: UploadProgressPhase,
    force: boolean,
    lastItem?: UploadProgressSnapshot['lastItem'],
  ): void => {
    if (!options.onProgress) {
      return;
    }

    const now = Date.now();
    if (!force && phase === 'running' && now - lastSnapshotAt < progressIntervalMs) {
      return;
    }
    lastSnapshotAt = now;

    const inFlightTransferredBytes = [...inFlightBytes.values()]
      .reduce((sum, value) => sum + value, 0);

    options.onProgress({
      phase,
      dryRun,
      totalItems: summary.total,
      processedItems: summary.processed,
      uploadedItems: summary.uploaded,
      skippedItems: summary.skipped,
      failedItems: summary.failed,
      inFlightItems: inFlightBytes.size,
      totalBytes,
      transferredBytes: committedTransferredBytes + inFlightTransferredBytes,
      timestamp: new Date(now).toISOString(),
      lastItem,
    });
  };

  const progressTimer = setInterval(() => {
    emitSnapshot('running', false);
  }, progressIntervalMs);

  // Safe: nextIndex++ and summary mutations are synchronous between awaits
  // in single-threaded Node.js — no two workers touch them in the same microtick.
  let nextIndex = 0;
  let stopScheduling = false;

  const processEntry = async (entry: ManifestEntry): Promise<void> => {
    const existingState = state.items[entry.destinationKey];
    if (existingState?.status === 'uploaded' || existingState?.status === 'skipped') {
      summary.skipped += 1;
      summary.processed += 1;
      emitSnapshot('running', true, {
        key: entry.destinationKey,
        sourcePath: entry.sourcePath,
        sizeBytes: entry.size,
        attempt: existingState.attempts,
        status: 'skipped',
      });
      return;
    }

    let destinationExists = false;
    try {
      destinationExists = await objectExistsCached(
        options.provider,
        entry.destinationKey,
        confirmedExistingKeys,
        existenceCache,
      );
    } catch (err) {
      console.debug('[uploader] Failed object existence check, treating as missing', err);
      destinationExists = false;
    }

    if (destinationExists) {
      state.items[entry.destinationKey] = {
        status: 'skipped',
        attempts: existingState?.attempts ?? 0,
        updatedAt: new Date().toISOString(),
      };
      checkpointManager.markDirty();
      summary.skipped += 1;
      summary.processed += 1;
      emitSnapshot('running', true, {
        key: entry.destinationKey,
        sourcePath: entry.sourcePath,
        sizeBytes: entry.size,
        attempt: existingState?.attempts ?? 0,
        status: 'skipped',
      });
      return;
    }

    if (dryRun) {
      summary.uploaded += 1;
      summary.processed += 1;
      emitSnapshot('running', true, {
        key: entry.destinationKey,
        sourcePath: entry.sourcePath,
        sizeBytes: entry.size,
        attempt: 1,
        status: 'uploaded',
      });
      return;
    }

    // Fast-fail if source file doesn't exist on disk (e.g. stale __dup manifest entries).
    // Uses sync check to avoid yielding the event loop (which would disrupt checkpoint timing).
    if (!existsSync(entry.sourcePath)) {
      const msg = `ENOENT: source file missing: ${entry.sourcePath}`;
      state.items[entry.destinationKey] = {
        status: 'failed',
        attempts: 0,
        updatedAt: new Date().toISOString(),
        error: msg,
      };
      checkpointManager.markDirty();
      summary.failed += 1;
      summary.processed += 1;
      emitSnapshot('running', true, {
        key: entry.destinationKey,
        sourcePath: entry.sourcePath,
        sizeBytes: entry.size,
        attempt: 0,
        status: 'failed',
        error: msg,
      });
      return;
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
      try {
        const startMs = Date.now();
        inFlightBytes.set(entry.destinationKey, 0);
        emitSnapshot('running', true, {
          key: entry.destinationKey,
          sourcePath: entry.sourcePath,
          sizeBytes: entry.size,
          attempt,
          status: 'starting',
        });

        const stream = createReadStream(entry.sourcePath, {
          highWaterMark: LARGE_FILE_READ_CHUNK_BYTES,
        });
        const trackedStream = createProgressTrackedStream(
          stream,
          {
            intervalMs: progressIntervalMs,
            sizeBytes: entry.size,
            onProgress(stats) {
              inFlightBytes.set(entry.destinationKey, stats.uploadedBytes);
              emitSnapshot('running', false, {
                key: entry.destinationKey,
                sourcePath: entry.sourcePath,
                sizeBytes: entry.size,
                uploadedBytes: stats.uploadedBytes,
                attempt,
                status: 'uploading',
                speedBytesPerSec: stats.speedBytesPerSec,
                etaSeconds: stats.etaSeconds,
              });
            },
          },
        );

        await options.provider.upload(
          entry.destinationKey,
          trackedStream,
          contentTypeForPath(entry.sourcePath),
        );

        const uploadedBytes = inFlightBytes.get(entry.destinationKey) ?? entry.size;
        inFlightBytes.delete(entry.destinationKey);
        committedTransferredBytes += uploadedBytes;
        const elapsedMs = Math.max(1, Date.now() - startMs);
        const speedBytesPerSec = Math.floor((uploadedBytes / elapsedMs) * 1000);
        const remainingBytes = Math.max(0, totalBytes - committedTransferredBytes);
        const etaSeconds = speedBytesPerSec > 0
          ? Math.floor(remainingBytes / speedBytesPerSec)
          : undefined;

        confirmedExistingKeys.add(entry.destinationKey);
        existenceCache.set(entry.destinationKey, true);
        state.items[entry.destinationKey] = {
          status: 'uploaded',
          attempts: attempt,
          updatedAt: new Date().toISOString(),
        };
        checkpointManager.markDirty();
        summary.uploaded += 1;
        summary.processed += 1;
        emitSnapshot('running', true, {
          key: entry.destinationKey,
          sourcePath: entry.sourcePath,
          sizeBytes: entry.size,
          uploadedBytes,
          attempt,
          status: 'uploaded',
          speedBytesPerSec,
          etaSeconds,
        });
        return;
      } catch (error) {
        lastError = error;

        inFlightBytes.delete(entry.destinationKey);

        // Don't retry filesystem errors like ENOENT — the file doesn't exist
        // on disk and retrying will never help (e.g. stale __dup manifest entries).
        if (!isNonRetryableError(error) && attempt <= retryCount) {
          const delay = computeBackoffDelay(baseDelayMs, attempt);
          emitSnapshot('running', true, {
            key: entry.destinationKey,
            sourcePath: entry.sourcePath,
            sizeBytes: entry.size,
            attempt,
            status: 'retrying',
            delayMs: delay,
            error: toErrorMessage(error),
          });
          await sleep(delay);
          continue;
        }

        state.items[entry.destinationKey] = {
          status: 'failed',
          attempts: attempt,
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        checkpointManager.markDirty();
        summary.failed += 1;
        summary.processed += 1;
        emitSnapshot('running', true, {
          key: entry.destinationKey,
          sourcePath: entry.sourcePath,
          sizeBytes: entry.size,
          attempt,
          status: 'failed',
          error: toErrorMessage(error),
        });
      }
    }

    if (options.maxFailures !== undefined && summary.failed >= options.maxFailures) {
      summary.stoppedEarly = true;
      summary.failureLimitReached = true;
      stopScheduling = true;
    }

    if (!lastError) {
      return;
    }
  };

  const workerCount = Math.min(uploadConcurrency, Math.max(entries.length, 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (!stopScheduling) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= entries.length) {
        return;
      }

      await processEntry(entries[index]);

      if (options.maxFailures !== undefined && summary.failed >= options.maxFailures) {
        summary.stoppedEarly = true;
        summary.failureLimitReached = true;
        stopScheduling = true;
      }
    }
  });

  emitSnapshot('running', true);

  try {
    await Promise.all(workers);
  } finally {
    clearInterval(progressTimer);
    await checkpointManager.stopAndFlush();
  }

  emitSnapshot('completed', true);

  return summary;
}

export async function loadUploadState(statePath: string): Promise<UploadState> {
  try {
    const raw = (await fs.readFile(statePath, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as UploadState;
    if (parsed.version !== 1 || typeof parsed.items !== 'object' || !parsed.items) {
      return createEmptyState();
    }

    return parsed;
  } catch (err) {
    console.debug('[uploader] Failed to load upload state, using empty state', err);
    return createEmptyState();
  }
}

export async function persistUploadState(
  statePath: string,
  state: UploadState,
): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const dir = path.dirname(statePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmpPath, statePath);
}

function createEmptyState(): UploadState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    items: {},
  };
}

async function objectExists(provider: CloudProvider, key: string): Promise<boolean> {
  const items = await provider.list({ prefix: key, maxResults: 20 });
  return items.some((item) => item.key === key);
}

export async function objectExistsCached(
  provider: CloudProvider,
  key: string,
  confirmedExistingKeys: Set<string>,
  existenceCache: Map<string, boolean>,
): Promise<boolean> {
  if (confirmedExistingKeys.has(key)) {
    return true;
  }

  const cached = existenceCache.get(key);
  if (typeof cached === 'boolean') {
    return cached;
  }

  const exists = await objectExists(provider, key);
  existenceCache.set(key, exists);
  if (exists) {
    confirmedExistingKeys.add(key);
  }
  return exists;
}

const PRELOAD_CONCURRENCY = 4;

export async function preloadDestinationIndex(
  provider: CloudProvider,
  entries: Array<{ destinationKey: string }>,
): Promise<Set<string>> {
  const prefixes = collectDatePrefixes(entries);
  const keys = new Set<string>();

  // Fetch prefix listings in parallel, bounded to PRELOAD_CONCURRENCY
  let prefixIndex = 0;
  const workers = Array.from({ length: Math.min(PRELOAD_CONCURRENCY, prefixes.length || 1) }, async () => {
    while (true) {
      const i = prefixIndex;
      prefixIndex += 1;
      if (i >= prefixes.length) return;

      const listed = await provider.list({ prefix: prefixes[i] });
      for (const item of listed) {
        keys.add(item.key);
      }
    }
  });
  await Promise.all(workers);

  return keys;
}

export function collectDatePrefixes(entries: Array<{ destinationKey: string }>): string[] {
  const prefixes = new Set<string>();

  for (const entry of entries) {
    const match = /^((?:transfers\/)?\d{4}\/\d{2}\/\d{2})\//.exec(entry.destinationKey);
    if (match?.[1]) {
      prefixes.add(`${match[1]}/`);
    }
  }

  return [...prefixes].sort((a, b) => a.localeCompare(b));
}

class StateCheckpointManager {
  private dirty = false;
  private dirtyUpdates = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private flushError: unknown;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly statePath: string,
    private readonly state: UploadState,
    private readonly persistEvery: number,
    flushIntervalMs: number,
  ) {
    this.timer = setInterval(() => {
      this.enqueueFlush();
    }, flushIntervalMs);
  }

  markDirty(): void {
    this.dirty = true;
    this.dirtyUpdates += 1;

    if (this.dirtyUpdates >= this.persistEvery) {
      this.enqueueFlush();
    }
  }

  async stopAndFlush(): Promise<void> {
    clearInterval(this.timer);
    this.enqueueFlush();
    await this.writeChain;

    if (this.flushError) {
      throw this.flushError;
    }
  }

  private enqueueFlush(): void {
    this.dirtyUpdates = 0;
    this.writeChain = this.writeChain.then(async () => {
      if (!this.dirty) {
        return;
      }

      await persistUploadState(this.statePath, this.state);
      this.dirty = false;
    }).catch((error) => {
      this.flushError = error;
    });
  }
}

function computeBackoffDelay(baseDelayMs: number, attempt: number): number {
  const jitter = Math.floor(Math.random() * 100);
  return baseDelayMs * 2 ** (attempt - 1) + jitter;
}

function contentTypeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Errors that should NOT be retried because the file genuinely doesn't exist
 * on disk (e.g. stale manifest entries for __dup files that were never created).
 */
function isNonRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: string }).code;
    return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';
  }
  return false;
}

function createProgressTrackedStream(
  source: Readable,
  options: {
    intervalMs: number;
    sizeBytes: number;
    onProgress: (stats: {
      uploadedBytes: number;
      speedBytesPerSec: number;
      etaSeconds: number | undefined;
    }) => void;
  },
): Readable {
  const startedAt = Date.now();
  let uploadedBytes = 0;
  let lastEmittedAt = 0;

  const emitProgress = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastEmittedAt < options.intervalMs) {
      return;
    }

    lastEmittedAt = now;
    const elapsedMs = Math.max(1, now - startedAt);
    const speedBytesPerSec = Math.floor((uploadedBytes / elapsedMs) * 1000);
    const remainingBytes = Math.max(0, options.sizeBytes - uploadedBytes);
    const etaSeconds = speedBytesPerSec > 0
      ? Math.floor(remainingBytes / speedBytesPerSec)
      : undefined;

    options.onProgress({
      uploadedBytes,
      speedBytesPerSec,
      etaSeconds,
    });
  };

  const tracker = new Transform({
    transform(chunk, _encoding, callback) {
      uploadedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      emitProgress(false);
      callback(null, chunk);
    },
    flush(callback) {
      emitProgress(true);
      callback();
    },
  });

  source.on('error', (error) => tracker.destroy(error));
  source.pipe(tracker);
  return tracker;
}

function applyFilters(
  entries: ManifestEntry[],
  includeFilter?: string,
  excludeFilter?: string,
): ManifestEntry[] {
  return entries.filter((entry) => {
    const key = entry.destinationKey;

    if (includeFilter && !key.includes(includeFilter)) {
      return false;
    }

    if (excludeFilter && key.includes(excludeFilter)) {
      return false;
    }

    return true;
  });
}
