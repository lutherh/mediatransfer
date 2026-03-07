import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudProvider } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
import {
  buildManifest,
  deduplicateManifest,
  loadManifestJsonl,
  persistManifestJsonl,
} from './manifest.js';
import {
  containsMediaFiles,
  discoverTakeoutArchives,
  extractArchive,
  findGooglePhotosRoots,
  normalizeTakeoutMediaRoot,
  unpackAndNormalizeTakeout,
  type ArchiveExtractor,
} from './unpack.js';
import {
  collectDatePrefixes,
  loadUploadState,
  objectExistsCached,
  preloadDestinationIndex,
  uploadManifest,
  type UploadProgressSnapshot,
  type UploadSummary,
} from './uploader.js';
import {
  buildReconciliationReport,
  persistReportCsv,
  persistReportJson,
} from './report.js';

export const DEFAULT_MANIFEST_FILE = 'manifest.jsonl';

type ArchiveHistoryItem = {
  status: 'pending' | 'extracting' | 'uploading' | 'completed' | 'failed';
  entryCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  archiveSizeBytes?: number;
  mediaBytes?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

type ArchiveHistoryState = {
  version: 1;
  updatedAt: string;
  archives: Record<string, ArchiveHistoryItem>;
};

function createEmptyArchiveHistoryState(): ArchiveHistoryState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    archives: {},
  };
}

async function loadArchiveHistoryState(statePath: string): Promise<ArchiveHistoryState> {
  try {
    const raw = (await fs.readFile(statePath, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as ArchiveHistoryState;
    if (parsed.version === 1 && typeof parsed.archives === 'object') {
      return parsed;
    }
  } catch {
    // Missing or malformed archive state is treated as empty.
  }
  return createEmptyArchiveHistoryState();
}

async function persistArchiveHistoryState(statePath: string, state: ArchiveHistoryState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, statePath);
}

async function getFileSizeBestEffort(filePath: string): Promise<number | undefined> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

async function assertManifestExists(manifestPath: string): Promise<void> {
  try {
    await fs.access(manifestPath);
  } catch {
    throw new Error(
      `Manifest not found at ${manifestPath}. Run the Scan step first to generate it.`,
    );
  }
}

// ─── Scan checkpoint state ────────────────────────────────────────────────────
// Persisted at work/scan-state.json so a scan can resume after a timeout or
// crash — only archives that have NOT yet been extracted are processed on the
// next run.

type ScanState = {
  version: 1;
  /** Basenames of archives already fully extracted in a previous run. */
  extractedArchives: string[];
  lastUpdatedAt: string;
};

async function loadScanState(statePath: string): Promise<ScanState> {
  try {
    const raw = (await fs.readFile(statePath, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as ScanState;
    if (parsed.version === 1 && Array.isArray(parsed.extractedArchives)) return parsed;
  } catch { /* not found or malformed — start fresh */ }
  return { version: 1, extractedArchives: [], lastUpdatedAt: new Date().toISOString() };
}

async function saveScanState(statePath: string, state: ScanState): Promise<void> {
  state.lastUpdatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, statePath);
}

export type ScanProgressPhase = 'discover' | 'extract' | 'normalize' | 'manifest' | 'done';

export type ScanProgressEvent = {
  phase: ScanProgressPhase;
  current: number;
  total: number;
  detail?: string;
  percent: number;
};

export type ScanProgressCallback = (event: ScanProgressEvent) => void;

export type ScanResult = {
  manifestPath: string;
  mediaRoot: string;
  archives: string[];
  entryCount: number;
};

export type VerifySummary = {
  total: number;
  present: number;
  missing: number;
  missingKeys: string[];
};

export type UploadRunOptions = {
  dryRun?: boolean;
  maxFailures?: number;
  uploadConcurrency?: number;
  includeFilter?: string;
  excludeFilter?: string;
  reportDir?: string;
  progressIntervalMs?: number;
  onUploadProgress?: (snapshot: UploadProgressSnapshot) => void;
};

export type UploadRunResult = {
  summary: UploadSummary;
  reportJsonPath: string;
  reportCsvPath: string;
};

export async function runTakeoutScan(
  config: TakeoutConfig,
  extractor?: ArchiveExtractor,
  onProgress?: ScanProgressCallback,
): Promise<ScanResult> {
  onProgress?.({ phase: 'discover', current: 0, total: 0, percent: 0, detail: 'Discovering archives...' });

  const allArchives = await discoverTakeoutArchives(config.inputDir);
  const manifestPath = path.join(config.workDir, DEFAULT_MANIFEST_FILE);
  const scanStatePath = path.join(config.workDir, 'scan-state.json');
  const archiveStatePath = path.join(config.workDir, 'archive-state.json');
  const normalizedDir  = path.join(config.workDir, 'normalized');
  const archiveState = await loadArchiveHistoryState(archiveStatePath);

  // ── No archive files at all: fall back to direct-media / descriptive error ─
  if (allArchives.length === 0) {
    const { archives, mediaRoot } = await unpackAndNormalizeTakeout(
      config.inputDir, config.workDir, extractor,
    );
    onProgress?.({ phase: 'manifest', current: 0, total: 0, percent: 72, detail: 'Building manifest...' });
    const rawEntries = await buildManifest(mediaRoot, (processed, total) => {
      const pct = 72 + Math.round((processed / Math.max(total, 1)) * 20);
      onProgress?.({ phase: 'manifest', current: processed, total, percent: pct, detail: `${processed}/${total} files` });
    });
    onProgress?.({ phase: 'manifest', current: 0, total: 0, percent: 93, detail: 'Deduplicating manifest...' });
    const dedup = await deduplicateManifest(rawEntries, (hashed, total) => {
      const pct = 93 + Math.round((hashed / Math.max(total, 1)) * 5);
      onProgress?.({ phase: 'manifest', current: hashed, total, percent: pct, detail: `Dedup: hashing ${hashed}/${total}` });
    });
    if (dedup.removedCount > 0) {
      console.log(`[runner] Manifest dedup: removed ${dedup.removedCount} duplicate entries (${(dedup.removedBytes / 1e9).toFixed(2)} GB)`);
    }
    const entries = dedup.entries;
    await persistManifestJsonl(entries, manifestPath);
    onProgress?.({ phase: 'done', current: 1, total: 1, percent: 100, detail: 'Scan complete' });
    return { manifestPath, mediaRoot, archives, entryCount: entries.length };
  }

  // ── Load checkpoint: which archives were already extracted in a prior run ──
  const scanState = await loadScanState(scanStatePath);
  const alreadyExtracted = new Set(scanState.extractedArchives);
  const toExtract = allArchives.filter((a) => !alreadyExtracted.has(path.basename(a)));

  onProgress?.({
    phase: 'discover',
    current: allArchives.length - toExtract.length,
    total: allArchives.length,
    percent: 2,
    detail: toExtract.length === 0
      ? 'All archives already extracted — rebuilding manifest...'
      : `${allArchives.length - toExtract.length} already extracted, ${toExtract.length} remaining`,
  });

  // NOTE: We intentionally do NOT short-circuit when toExtract is empty.
  // The scan-state file checkpoints extraction progress for crash-recovery.
  // If all archives are marked as extracted, a prior run may have been
  // interrupted after extraction but *before* normalize → manifest → clear.
  // Always fall through so the full pipeline completes and the state is cleared.

  // ── Phase 1: Extract new archives one at a time (checkpointed) ────────────
  const effectiveExtractor = extractor ?? extractArchive;
  const totalArchives  = allArchives.length;
  const alreadyDone    = totalArchives - toExtract.length;

  for (let i = 0; i < toExtract.length; i++) {
    const archivePath = toExtract[i];
    const archiveName = path.basename(archivePath);
    const existing = archiveState.archives[archiveName];
    const shouldTrackScanState = existing?.status !== 'completed';
    const archiveSizeBytes = await getFileSizeBestEffort(archivePath);

    if (shouldTrackScanState) {
      archiveState.archives[archiveName] = {
        status: 'extracting',
        entryCount: existing?.entryCount ?? 0,
        uploadedCount: existing?.uploadedCount ?? 0,
        skippedCount: existing?.skippedCount ?? 0,
        failedCount: existing?.failedCount ?? 0,
        archiveSizeBytes: existing?.archiveSizeBytes ?? archiveSizeBytes,
        mediaBytes: existing?.mediaBytes,
        startedAt: existing?.startedAt ?? new Date().toISOString(),
        completedAt: existing?.completedAt,
        error: undefined,
      };
      await persistArchiveHistoryState(archiveStatePath, archiveState);
    }

    // Weight extraction as 0‒65 % of total progress
    const percent = Math.round(((alreadyDone + i) / Math.max(totalArchives, 1)) * 65);
    onProgress?.({
      phase: 'extract',
      current: alreadyDone + i + 1,
      total: totalArchives,
      percent,
      detail: archiveName,
    });

    try {
      await effectiveExtractor(archivePath, config.workDir);
    } catch (error) {
      if (shouldTrackScanState) {
        archiveState.archives[archiveName] = {
          ...archiveState.archives[archiveName],
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        await persistArchiveHistoryState(archiveStatePath, archiveState);
      }
      throw error;
    }

    // Checkpoint immediately so a timeout / crash leaves progress intact
    scanState.extractedArchives.push(archiveName);
    await saveScanState(scanStatePath, scanState);

    if (shouldTrackScanState) {
      archiveState.archives[archiveName] = {
        ...archiveState.archives[archiveName],
        status: 'pending',
        error: undefined,
      };
      await persistArchiveHistoryState(archiveStatePath, archiveState);
    }
  }

  // ── Phase 2: Normalize (wipe first for idempotency) ───────────────────────
  // Wipe the normalized folder so that re-runs don't accumulate __dup files.
  // This directory is derived from Takeout/ so rebuilding it is always safe.
  // Use a safe recursive removal that skips corrupted/unreadable entries
  // rather than fs.rm(recursive) which deletes good data before throwing.
  onProgress?.({ phase: 'normalize', current: 0, total: 1, percent: 67, detail: 'Merging extracted folders...' });
  await safeRmRecursive(normalizedDir);

  const roots = await findGooglePhotosRoots(config.workDir);
  let mediaRoot: string;
  if (roots.length > 0) {
    mediaRoot = await normalizeTakeoutMediaRoot(config.workDir, (processed, total, fileName) => {
      const pct = 67 + Math.round((processed / Math.max(total, 1)) * 5);
      onProgress?.({
        phase: 'normalize',
        current: processed,
        total,
        percent: Math.min(pct, 72),
        detail: `${processed.toLocaleString()}/${total.toLocaleString()} files — ${fileName}`,
      });
    });
  } else {
    const hasMedia = await containsMediaFiles(config.workDir);
    if (!hasMedia) {
      throw new Error(
        'No Google Photos folders or media files found after extracting archives.\n' +
        'Make sure you downloaded ALL parts of the Google Takeout export.',
      );
    }
    mediaRoot = config.workDir;
  }

  onProgress?.({ phase: 'normalize', current: 1, total: 1, percent: 72, detail: 'Folders merged.' });

  // ── Phase 2b: Cleanup extracted Takeout directories ───────────────────────
  // normalizeTakeoutMediaRoot now moves (not copies) files, so the original
  // Google Photos roots are mostly empty. Remove them and any parent Takeout
  // directories to reclaim disk space (metadata sidecar .json files, empty dirs).
  if (roots.length > 0) {
    for (const root of roots) {
      try { await fs.rm(root, { recursive: true, force: true }); } catch { /* ok */ }
      // Also try to remove the parent Takeout/ folder if it's now empty
      const takeoutDir = path.dirname(root);
      try {
        const remaining = await fs.readdir(takeoutDir);
        if (remaining.length === 0) await fs.rmdir(takeoutDir);
      } catch { /* ok */ }
    }
  }

  // ── Phase 3: Build manifest ────────────────────────────────────────────────
  onProgress?.({ phase: 'manifest', current: 0, total: 0, percent: 73, detail: 'Building manifest...' });

  const rawEntries = await buildManifest(mediaRoot, (processed, total) => {
    const pct = 73 + Math.round((processed / Math.max(total, 1)) * 18);
    onProgress?.({ phase: 'manifest', current: processed, total, percent: pct, detail: `${processed.toLocaleString()}/${total.toLocaleString()} files` });
  });

  onProgress?.({ phase: 'manifest', current: 0, total: 0, percent: 92, detail: 'Deduplicating manifest...' });
  const dedup = await deduplicateManifest(rawEntries, (hashed, total) => {
    const pct = 92 + Math.round((hashed / Math.max(total, 1)) * 6);
    onProgress?.({ phase: 'manifest', current: hashed, total, percent: pct, detail: `Dedup: hashing ${hashed.toLocaleString()}/${total.toLocaleString()}` });
  });
  if (dedup.removedCount > 0) {
    console.log(`[runner] Manifest dedup: removed ${dedup.removedCount} duplicate entries (${(dedup.removedBytes / 1e9).toFixed(2)} GB)`);
  }
  const entries = dedup.entries;
  await persistManifestJsonl(entries, manifestPath);

  // Clear scan-state — the next batch of archives starts fresh
  try { await fs.rm(scanStatePath, { force: true }); } catch { /* ok if absent */ }

  onProgress?.({
    phase: 'done', current: 1, total: 1, percent: 100,
    detail: `Scan complete — ${entries.length.toLocaleString()} files`,
  });

  return {
    manifestPath,
    mediaRoot,
    archives: allArchives,
    entryCount: entries.length,
  };
}

export async function runTakeoutUpload(
  config: TakeoutConfig,
  provider: CloudProvider,
  manifestPath = path.join(config.workDir, DEFAULT_MANIFEST_FILE),
  options: UploadRunOptions = {},
): Promise<UploadRunResult> {
  await assertManifestExists(manifestPath);
  const entries = await loadManifestJsonl(manifestPath);

  const summary = await uploadManifest({
    provider,
    entries,
    statePath: config.statePath,
    uploadConcurrency: options.uploadConcurrency ?? config.uploadConcurrency,
    retryCount: config.uploadRetryCount,
    dryRun: options.dryRun,
    maxFailures: options.maxFailures,
    includeFilter: options.includeFilter,
    excludeFilter: options.excludeFilter,
    progressIntervalMs: options.progressIntervalMs,
    onProgress: options.onUploadProgress,
  });

  const state = await loadUploadState(config.statePath);
  const report = buildReconciliationReport(entries, state, summary);

  const reportDir = options.reportDir ?? path.join(config.workDir, 'reports');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportJsonPath = path.join(reportDir, `upload-${stamp}.json`);
  const reportCsvPath = path.join(reportDir, `upload-${stamp}.csv`);

  await persistReportJson(report, reportJsonPath);
  await persistReportCsv(state, reportCsvPath);

  return { summary, reportJsonPath, reportCsvPath };
}

export async function runTakeoutResume(
  config: TakeoutConfig,
  provider: CloudProvider,
  manifestPath = path.join(config.workDir, DEFAULT_MANIFEST_FILE),
  options: UploadRunOptions = {},
): Promise<UploadRunResult> {
  return runTakeoutUpload(config, provider, manifestPath, options);
}

export async function runTakeoutVerify(
  config: TakeoutConfig,
  provider: CloudProvider,
  manifestPath = path.join(config.workDir, DEFAULT_MANIFEST_FILE),
): Promise<VerifySummary> {
  await assertManifestExists(manifestPath);
  const entries = await loadManifestJsonl(manifestPath);
  const indexedKeys = await preloadDestinationIndex(provider, entries);
  const confirmedExistingKeys = new Set<string>(indexedKeys);
  const existenceCache = new Map<string, boolean>();
  const missingKeys: string[] = [];
  let present = 0;

  // Safe: nextIndex++ and counter mutations are synchronous between awaits
  // in single-threaded Node.js — no two workers touch them in the same microtick.
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(config.uploadConcurrency, 1), Math.max(entries.length, 1));

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= entries.length) {
        return;
      }

      const key = entries[index].destinationKey;

      if (confirmedExistingKeys.has(key)) {
        present += 1;
        continue;
      }

      const exists = await objectExistsCached(provider, key, confirmedExistingKeys, existenceCache);
      if (exists) {
        present += 1;
      } else {
        missingKeys.push(key);
      }
    }
  });

  await Promise.all(workers);

  return {
    total: entries.length,
    present,
    missing: missingKeys.length,
    missingKeys,
  };
}

export function withDefaults(partial: Partial<TakeoutConfig>): TakeoutConfig {
  return {
    inputDir: partial.inputDir ?? './data/takeout/input',
    workDir: partial.workDir ?? './data/takeout/work',
    statePath: partial.statePath ?? './data/takeout/state.json',
    uploadConcurrency: partial.uploadConcurrency ?? 4,
    uploadRetryCount: partial.uploadRetryCount ?? 5,
  };
 }

/**
 * Recursively remove a directory tree, skipping corrupted/unreadable entries
 * instead of aborting. Unlike fs.rm(recursive), this won't delete good data
 * before throwing on a corrupted sibling — each entry is handled independently.
 */
async function safeRmRecursive(dirPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    // Directory doesn't exist or is unreadable — nothing to do
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    try {
      const stat = await fs.lstat(fullPath);
      if (stat.isDirectory()) {
        await safeRmRecursive(fullPath);
        // Try to remove the now-empty directory
        try { await fs.rmdir(fullPath); } catch {
          console.warn(`[runner] Could not remove directory (corrupted?): ${fullPath} — skipping`);
        }
      } else {
        await fs.unlink(fullPath);
      }
    } catch {
      console.warn(`[runner] Could not remove entry (corrupted?): ${fullPath} — skipping`);
    }
  }

  // Try to remove the directory itself if it's now empty
  try { await fs.rmdir(dirPath); } catch { /* ok if not empty due to skipped entries */ }
}

