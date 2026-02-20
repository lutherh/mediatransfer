import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { CloudProvider } from '../providers/types.js';
import type { MediaItem, PhotosProvider } from '../providers/photos-types.js';

export type GoogleApiPendingItem = {
  id: string;
  filename: string;
  mimeType: string;
  createdAt: string;
};

export type GoogleApiTransferredItem = {
  status: 'uploaded';
  destinationKey: string;
  size: number;
  updatedAt: string;
};

export type GoogleApiTransferState = {
  version: 1;
  updatedAt: string;
  nextPageToken?: string;
  sourceExhausted: boolean;
  pending: GoogleApiPendingItem[];
  transferred: Record<string, GoogleApiTransferredItem>;
};

export type GoogleApiBatchConfig = {
  statePath: string;
  tempDir: string;
  batchMaxItems?: number;
  batchMaxBytes?: number;
  sourcePageSize?: number;
  maxSourcePagesPerBatch?: number;
  maxBatches?: number;
  dryRun?: boolean;
};

export type GoogleApiBatchResult = {
  batchNumber: number;
  downloadedCount: number;
  uploadedCount: number;
  verifiedCount: number;
  deletedLocalCount: number;
  totalBytes: number;
  completed: boolean;
};

export type GoogleApiRunResult = {
  batches: GoogleApiBatchResult[];
  totalDownloaded: number;
  totalUploaded: number;
  totalVerified: number;
  totalDeletedLocal: number;
  totalBytes: number;
  completed: boolean;
};

const DEFAULT_BATCH_MAX_ITEMS = 100;
const DEFAULT_BATCH_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_SOURCE_PAGE_SIZE = 100;
const DEFAULT_MAX_SOURCE_PAGES_PER_BATCH = 25;

export async function runGoogleApiBatchTransferLoop(
  source: PhotosProvider,
  destination: CloudProvider,
  config: GoogleApiBatchConfig,
): Promise<GoogleApiRunResult> {
  const state = await loadGoogleApiTransferState(config.statePath);
  const batchMaxItems = config.batchMaxItems ?? DEFAULT_BATCH_MAX_ITEMS;
  const batchMaxBytes = config.batchMaxBytes ?? DEFAULT_BATCH_MAX_BYTES;
  const sourcePageSize = config.sourcePageSize ?? DEFAULT_SOURCE_PAGE_SIZE;
  const maxSourcePagesPerBatch =
    config.maxSourcePagesPerBatch ?? DEFAULT_MAX_SOURCE_PAGES_PER_BATCH;
  const dryRun = config.dryRun ?? false;

  const batches: GoogleApiBatchResult[] = [];
  let batchNumber = 0;

  while (true) {
    batchNumber += 1;

    const batch = await runGoogleApiSingleBatch(source, destination, state, {
      statePath: config.statePath,
      tempDir: config.tempDir,
      batchMaxItems,
      batchMaxBytes,
      sourcePageSize,
      maxSourcePagesPerBatch,
      batchNumber,
      dryRun,
    });

    batches.push(batch);

    if (batch.completed) {
      break;
    }

    if (batch.downloadedCount === 0) {
      break;
    }

    if (config.maxBatches !== undefined && batches.length >= config.maxBatches) {
      break;
    }
  }

  const totalDownloaded = batches.reduce((sum, batch) => sum + batch.downloadedCount, 0);
  const totalUploaded = batches.reduce((sum, batch) => sum + batch.uploadedCount, 0);
  const totalVerified = batches.reduce((sum, batch) => sum + batch.verifiedCount, 0);
  const totalDeletedLocal = batches.reduce((sum, batch) => sum + batch.deletedLocalCount, 0);
  const totalBytes = batches.reduce((sum, batch) => sum + batch.totalBytes, 0);
  const completed = batches[batches.length - 1]?.completed ?? false;

  return {
    batches,
    totalDownloaded,
    totalUploaded,
    totalVerified,
    totalDeletedLocal,
    totalBytes,
    completed,
  };
}

type SingleBatchConfig = {
  statePath: string;
  tempDir: string;
  batchMaxItems: number;
  batchMaxBytes: number;
  sourcePageSize: number;
  maxSourcePagesPerBatch: number;
  batchNumber: number;
  dryRun: boolean;
};

async function runGoogleApiSingleBatch(
  source: PhotosProvider,
  destination: CloudProvider,
  state: GoogleApiTransferState,
  config: SingleBatchConfig,
): Promise<GoogleApiBatchResult> {
  await fs.mkdir(config.tempDir, { recursive: true });
  await fillPendingItems(
    source,
    state,
    config.sourcePageSize,
    config.maxSourcePagesPerBatch,
    config.statePath,
  );

  const selected = takePendingForBatch(state, config.batchMaxItems);

  if (selected.length === 0) {
    const completed = state.sourceExhausted && state.pending.length === 0;
    return {
      batchNumber: config.batchNumber,
      downloadedCount: 0,
      uploadedCount: 0,
      verifiedCount: 0,
      deletedLocalCount: 0,
      totalBytes: 0,
      completed,
    };
  }

  let downloadedCount = 0;
  let uploadedCount = 0;
  let verifiedCount = 0;
  let deletedLocalCount = 0;
  let totalBytes = 0;

  for (const item of selected) {
    const localPath = path.join(config.tempDir, buildLocalFileName(item));
    await downloadMediaToLocalFile(source, item.id, localPath);
    const stats = await fs.stat(localPath);
    const itemSize = stats.size;

    if (downloadedCount > 0 && totalBytes + itemSize > config.batchMaxBytes) {
      await fs.rm(localPath, { force: true });
      state.pending.unshift(item);
      await persistGoogleApiTransferState(config.statePath, state);
      break;
    }

    downloadedCount += 1;
    totalBytes += itemSize;

    const destinationKey = buildDestinationKey(item);

    if (!config.dryRun) {
      await destination.upload(destinationKey, createReadStream(localPath), item.mimeType);
      uploadedCount += 1;

      const verified = await verifyUploadedObject(destination, destinationKey, itemSize);
      if (!verified) {
        throw new Error(`Verification failed for ${item.id} (${destinationKey})`);
      }
      verifiedCount += 1;

      await fs.rm(localPath, { force: true });
      deletedLocalCount += 1;
    }

    state.transferred[item.id] = {
      status: 'uploaded',
      destinationKey,
      size: itemSize,
      updatedAt: new Date().toISOString(),
    };
    await persistGoogleApiTransferState(config.statePath, state);
  }

  await fillPendingItems(
    source,
    state,
    config.sourcePageSize,
    config.maxSourcePagesPerBatch,
    config.statePath,
  );
  const completed = state.sourceExhausted && state.pending.length === 0;

  return {
    batchNumber: config.batchNumber,
    downloadedCount,
    uploadedCount,
    verifiedCount,
    deletedLocalCount,
    totalBytes,
    completed,
  };
}

async function fillPendingItems(
  source: PhotosProvider,
  state: GoogleApiTransferState,
  sourcePageSize: number,
  maxPagesToScan: number,
  statePath: string,
): Promise<void> {
  let pagesScanned = 0;

  while (state.pending.length === 0 && !state.sourceExhausted && pagesScanned < maxPagesToScan) {
    const page = await source.listMediaItems({
      maxResults: sourcePageSize,
      pageToken: state.nextPageToken,
    });

    pagesScanned += 1;

    const items = page.items
      .filter((item) => !state.transferred[item.id])
      .map(toPendingItem);

    state.pending.push(...items);
    state.nextPageToken = page.nextPageToken;
    state.sourceExhausted = !page.nextPageToken;
    await persistGoogleApiTransferState(statePath, state);

    if (items.length > 0) {
      return;
    }
  }
}

function takePendingForBatch(state: GoogleApiTransferState, maxItems: number): GoogleApiPendingItem[] {
  const selected: GoogleApiPendingItem[] = [];

  while (selected.length < maxItems && state.pending.length > 0) {
    const next = state.pending.shift();
    if (!next) {
      break;
    }

    if (state.transferred[next.id]) {
      continue;
    }

    selected.push(next);
  }

  return selected;
}

function toPendingItem(item: MediaItem): GoogleApiPendingItem {
  return {
    id: item.id,
    filename: item.filename,
    mimeType: item.mimeType,
    createdAt: item.createdAt.toISOString(),
  };
}

async function downloadMediaToLocalFile(
  source: PhotosProvider,
  mediaItemId: string,
  destinationPath: string,
): Promise<void> {
  const stream = await source.downloadMedia(mediaItemId);
  const writer = createWriteStream(destinationPath);
  await pipeline(stream, writer);
}

async function verifyUploadedObject(
  destination: CloudProvider,
  key: string,
  expectedSize: number,
): Promise<boolean> {
  const listed = await destination.list({ prefix: key, maxResults: 20 });
  const match = listed.find((item) => item.key === key);
  return Boolean(match && match.size === expectedSize);
}

function buildLocalFileName(item: GoogleApiPendingItem): string {
  const safeName = sanitizeFileName(item.filename);
  return `${item.id}-${safeName}`;
}

function buildDestinationKey(item: GoogleApiPendingItem): string {
  const date = new Date(item.createdAt);
  const fallback = new Date();
  const dateValue = Number.isNaN(date.getTime()) ? fallback : date;
  const year = dateValue.getUTCFullYear();
  const month = String(dateValue.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getUTCDate()).padStart(2, '0');
  const safeName = sanitizeFileName(item.filename);
  return `${year}/${month}/${day}/${item.id}-${safeName}`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function createEmptyState(): GoogleApiTransferState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    nextPageToken: undefined,
    sourceExhausted: false,
    pending: [],
    transferred: {},
  };
}

export async function loadGoogleApiTransferState(statePath: string): Promise<GoogleApiTransferState> {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as GoogleApiTransferState;
    if (parsed.version !== 1 || typeof parsed.transferred !== 'object' || !Array.isArray(parsed.pending)) {
      return createEmptyState();
    }

    return parsed;
  } catch {
    return createEmptyState();
  }
}

export async function persistGoogleApiTransferState(
  statePath: string,
  state: GoogleApiTransferState,
): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}