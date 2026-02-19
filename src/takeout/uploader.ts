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
  retryCount?: number;
  baseDelayMs?: number;
  dryRun?: boolean;
  maxFailures?: number;
  includeFilter?: string;
  excludeFilter?: string;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_RETRY_COUNT = 5;
const DEFAULT_BASE_DELAY_MS = 300;

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

  const state = await loadUploadState(options.statePath);
  const entries = applyFilters(options.entries, options.includeFilter, options.excludeFilter);
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

  for (const entry of entries) {
    const existingState = state.items[entry.destinationKey];
    if (existingState?.status === 'uploaded' || existingState?.status === 'skipped') {
      summary.skipped += 1;
      summary.processed += 1;
      continue;
    }

    const destinationExists = await objectExists(options.provider, entry.destinationKey);
    if (destinationExists) {
      state.items[entry.destinationKey] = {
        status: 'skipped',
        attempts: existingState?.attempts ?? 0,
        updatedAt: new Date().toISOString(),
      };
      summary.skipped += 1;
      summary.processed += 1;
      await persistUploadState(options.statePath, state);
      continue;
    }

    if (dryRun) {
      summary.uploaded += 1;
      summary.processed += 1;
      continue;
    }

    let uploaded = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
      try {
        const stream = createReadStream(entry.sourcePath);
        await options.provider.upload(
          entry.destinationKey,
          stream,
          contentTypeForPath(entry.sourcePath),
        );

        state.items[entry.destinationKey] = {
          status: 'uploaded',
          attempts: attempt,
          updatedAt: new Date().toISOString(),
        };
        summary.uploaded += 1;
        summary.processed += 1;
        uploaded = true;
        await persistUploadState(options.statePath, state);
        break;
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
        summary.failed += 1;
        summary.processed += 1;
        await persistUploadState(options.statePath, state);
      }
    }

    if (options.maxFailures !== undefined && summary.failed >= options.maxFailures) {
      summary.stoppedEarly = true;
      summary.failureLimitReached = true;
      break;
    }

    if (!uploaded && lastError) {
      // continue processing other files; failures are checkpointed
    }
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
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
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
