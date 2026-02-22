import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
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
};

const DEFAULT_RETRY_COUNT = 5;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_UPLOAD_CONCURRENCY = 1;
const DEFAULT_PERSIST_EVERY = 25;
const DEFAULT_FLUSH_INTERVAL_MS = 3000;

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
};

export async function uploadManifest(options: UploadOptions): Promise<UploadSummary> {
  const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const dryRun = options.dryRun ?? false;
  const uploadConcurrency = Math.max(1, Math.floor(options.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY));
  const persistEvery = Math.max(1, Math.floor(options.persistEvery ?? DEFAULT_PERSIST_EVERY));
  const flushIntervalMs = Math.max(250, Math.floor(options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS));

  const state = await loadUploadState(options.statePath);
  const entries = applyFilters(options.entries, options.includeFilter, options.excludeFilter);
  const preloadedExistingKeys = await preloadDestinationIndex(options.provider, entries);
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

  // Safe: nextIndex++ and summary mutations are synchronous between awaits
  // in single-threaded Node.js — no two workers touch them in the same microtick.
  let nextIndex = 0;
  let stopScheduling = false;

  const processEntry = async (entry: ManifestEntry): Promise<void> => {
    const existingState = state.items[entry.destinationKey];
    if (existingState?.status === 'uploaded' || existingState?.status === 'skipped') {
      summary.skipped += 1;
      summary.processed += 1;
      return;
    }

    const destinationExists = await objectExistsCached(
      options.provider,
      entry.destinationKey,
      confirmedExistingKeys,
      existenceCache,
    );

    if (destinationExists) {
      state.items[entry.destinationKey] = {
        status: 'skipped',
        attempts: existingState?.attempts ?? 0,
        updatedAt: new Date().toISOString(),
      };
      checkpointManager.markDirty();
      summary.skipped += 1;
      summary.processed += 1;
      return;
    }

    if (dryRun) {
      summary.uploaded += 1;
      summary.processed += 1;
      return;
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
      try {
        const stream = createReadStream(entry.sourcePath);
        await options.provider.upload(
          entry.destinationKey,
          stream,
          contentTypeForPath(entry.sourcePath),
        );

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
        return;
      } catch (error) {
        lastError = error;

        if (attempt <= retryCount) {
          const delay = computeBackoffDelay(baseDelayMs, attempt);
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

  try {
    await Promise.all(workers);
  } finally {
    await checkpointManager.stopAndFlush();
  }

  return summary;
}

export async function loadUploadState(statePath: string): Promise<UploadState> {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as UploadState;
    if (parsed.version !== 1 || typeof parsed.items !== 'object' || !parsed.items) {
      return createEmptyState();
    }

    return parsed;
  } catch {
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
    const match = /^(\d{4}\/\d{2}\/\d{2})\//.exec(entry.destinationKey);
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
