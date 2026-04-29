import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudProvider } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
import { getLogger } from '../utils/logger.js';
import {
  buildManifest,
  loadManifestJsonl,
  persistManifestJsonl,
  refineDatesFromAllMetadata,
  type ManifestEntry,
} from './manifest.js';
import {
  extractAndPersistArchiveMetadata,
  loadAllArchiveMetadata,
} from './archive-metadata.js';

const log = getLogger().child({ module: 'runner' });
import {
  containsMediaFiles,
  discoverTakeoutArchives,
  extractArchive,
  findGooglePhotosRoots,
  unpackAndNormalizeTakeout,
  type ArchiveExtractor,
} from './unpack.js';
import {
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
import {
  loadArchiveState,
  persistArchiveState,
} from './incremental.js';

export const DEFAULT_MANIFEST_FILE = 'manifest.jsonl';

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
// crash — only archives that have NOT yet been staged into normalized storage
// are processed on the next run.

type ScanState = {
  version: 1;
  /** Basenames of archives already merged into normalized storage. */
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

async function persistArchiveMetadataBestEffort(
  extractDir: string,
  entries: ManifestEntry[],
  archiveName: string,
  metadataDir: string,
): Promise<void> {
  if (entries.length === 0) return;

  try {
    await extractAndPersistArchiveMetadata(extractDir, entries, archiveName, metadataDir);
  } catch (error) {
    log.warn(
      {
        archiveName,
        metadataDir,
        error: error instanceof Error ? error.message : String(error),
      },
      '[runner] Failed to persist archive metadata; continuing scan',
    );
  }
}

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
  const partialManifestPath = path.join(config.workDir, 'scan-entries.jsonl');
  const tempExtractDir = path.join(config.workDir, 'temp-extract');
  const metadataDir = path.join(config.workDir, 'metadata');
  const archiveState = await loadArchiveState(archiveStatePath);

  // ── No archive files at all: fall back to direct-media / descriptive error ─
  if (allArchives.length === 0) {
    const { archives, mediaRoot } = await unpackAndNormalizeTakeout(
      config.inputDir, config.workDir, extractor,
    );
    onProgress?.({ phase: 'manifest', current: 0, total: 0, percent: 72, detail: 'Building manifest...' });
    const entries = await buildManifest(mediaRoot, (processed, total) => {
      const pct = 72 + Math.round((processed / Math.max(total, 1)) * 25);
      onProgress?.({ phase: 'manifest', current: processed, total, percent: pct, detail: `${processed}/${total} files` });
    });
      await persistArchiveMetadataBestEffort(mediaRoot, entries, 'direct-input', metadataDir);

      const allMetadata = await loadAllArchiveMetadata(metadataDir);
      const { refinedCount, breakdown } = refineDatesFromAllMetadata(entries, allMetadata);
      if (refinedCount > 0) {
        log.info({ refinedCount, breakdown }, '[runner] Global date refinement: entries improved');
      }

    await persistManifestJsonl(entries, manifestPath);
    onProgress?.({ phase: 'done', current: 1, total: 1, percent: 100, detail: 'Scan complete' });
    return { manifestPath, mediaRoot, archives, entryCount: entries.length };
  }

  // ── Load checkpoint: which archives were already scanned in a prior run ────
  const scanState = await loadScanState(scanStatePath);
  const alreadyScanned = new Set(scanState.extractedArchives);
  const toScan = allArchives.filter((a) => {
    const name = path.basename(a);
    // Skip if already scanned in this run (crash-recovery state)
    if (alreadyScanned.has(name)) return false;
    // Skip if already completed in a prior upload cycle (prevents re-extraction)
    if (archiveState.archives[name]?.status === 'completed') return false;
    return true;
  });

  onProgress?.({
    phase: 'discover',
    current: allArchives.length - toScan.length,
    total: allArchives.length,
    percent: 2,
    detail: toScan.length === 0
      ? 'All archives already scanned — rebuilding manifest...'
      : `${allArchives.length - toScan.length} already scanned, ${toScan.length} remaining`,
  });

  // ── Phase 1: Extract each archive, build manifest entries, then delete ─────
  // Unlike the old approach which merged into a persistent `normalized/`
  // directory (consuming disk equal to all archives), this only keeps ONE
  // archive extracted at a time. Entries are appended to a partial manifest
  // file for crash recovery.
  const effectiveExtractor = extractor ?? extractArchive;
  const totalArchives = allArchives.length;
  const alreadyDone = totalArchives - toScan.length;
  let sawMetadataOnlyArchive = false;

  for (let i = 0; i < toScan.length; i++) {
    const archivePath = toScan[i];
    const archiveName = path.basename(archivePath);
    const existing = archiveState.archives[archiveName];
    const shouldTrackState = existing?.status !== 'completed';
    const archiveSizeBytes = await getFileSizeBestEffort(archivePath);

    if (shouldTrackState) {
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
      await persistArchiveState(archiveStatePath, archiveState);
    }

    const percent = Math.round(((alreadyDone + i) / Math.max(totalArchives, 1)) * 80);
    onProgress?.({
      phase: 'extract',
      current: alreadyDone + i + 1,
      total: totalArchives,
      percent,
      detail: archiveName,
    });

    try {
      await safeRmRecursive(tempExtractDir);
      await fs.mkdir(tempExtractDir, { recursive: true });
      await effectiveExtractor(archivePath, tempExtractDir);

      // Find media roots and build manifest entries while files are on disk
      const roots = await findGooglePhotosRoots(tempExtractDir);
      let archiveEntries: ManifestEntry[];

      if (roots.length > 0) {
        const perRoot = await Promise.all(roots.map((root) => buildManifest(root)));
        archiveEntries = perRoot.flat();
      } else if (await containsMediaFiles(tempExtractDir)) {
        archiveEntries = await buildManifest(tempExtractDir);
      } else if (await pathExists(path.join(tempExtractDir, 'Takeout', 'archive_browser.html'))) {
        sawMetadataOnlyArchive = true;
        archiveEntries = [];
      } else {
        archiveEntries = [];
      }

      onProgress?.({
        phase: 'manifest',
        current: alreadyDone + i + 1,
        total: totalArchives,
        percent: Math.min(percent + 5, 85),
        detail: `${archiveName}: ${archiveEntries.length.toLocaleString()} files`,
      });

      // Persist entries before deleting temp so a crash doesn't lose them
      if (archiveEntries.length > 0) {
        await persistArchiveMetadataBestEffort(tempExtractDir, archiveEntries, archiveName, metadataDir);
        await appendJsonl(archiveEntries, partialManifestPath);
      }

      if (shouldTrackState) {
        const mediaBytes = archiveEntries.reduce((s, e) => s + Math.max(0, e.size ?? 0), 0);
        archiveState.archives[archiveName] = {
          ...archiveState.archives[archiveName],
          status: 'pending',
          entryCount: archiveEntries.length,
          mediaBytes,
          error: undefined,
        };
        await persistArchiveState(archiveStatePath, archiveState);
      }
    } catch (error) {
      if (shouldTrackState) {
        archiveState.archives[archiveName] = {
          ...archiveState.archives[archiveName],
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        await persistArchiveState(archiveStatePath, archiveState);
      }
      throw error;
    } finally {
      // Always delete extracted files — this is the core disk-saving change
      await safeRmRecursive(tempExtractDir);
    }

    scanState.extractedArchives.push(archiveName);
    await saveScanState(scanStatePath, scanState);
  }

  // ── Phase 2: Build final manifest from all scanned entries ─────────────────
  onProgress?.({ phase: 'manifest', current: 0, total: 0, percent: 85, detail: 'Building final manifest...' });

  // Load entries from both the partial manifest (previously scanned) and any
  // legacy normalized directory left by a prior version of the scan.
  let allEntries = await loadManifestJsonl(partialManifestPath);

  if (allEntries.length === 0 && toScan.length === 0) {
    // All archives were already scanned in a prior run and the partial
    // manifest was cleared. Reload the final manifest if it exists.
    allEntries = await loadManifestJsonl(manifestPath);
  }

  if (allEntries.length === 0 && !sawMetadataOnlyArchive) {
    throw new Error(
      'No media files found in any archive.\n'
      + 'Make sure you downloaded ALL parts of the Google Takeout export (not just metadata archives).',
    );
  }

  // Dedup by destinationKey (no file I/O needed — files are deleted)
  const dedupMap = new Map<string, ManifestEntry>();
  for (const entry of allEntries) {
    if (!dedupMap.has(entry.destinationKey)) {
      dedupMap.set(entry.destinationKey, entry);
    }
  }
  const entries = [...dedupMap.values()].sort((a, b) =>
    a.destinationKey.localeCompare(b.destinationKey),
  );

  const removedCount = allEntries.length - entries.length;
  if (removedCount > 0) {
    log.info({ removedCount }, '[runner] Manifest dedup: removed duplicate entries by destination key');
  }

  const allMetadata = await loadAllArchiveMetadata(metadataDir);
  if (allMetadata.length > 0) {
    const { refinedCount, breakdown } = refineDatesFromAllMetadata(entries, allMetadata);
    if (refinedCount > 0) {
      log.info({ refinedCount, breakdown }, '[runner] Global date refinement: entries improved');
    }
  }

  await persistManifestJsonl(entries, manifestPath);

  // Clean up intermediate files
  try { await fs.rm(scanStatePath, { force: true }); } catch { /* ok */ }
  try { await fs.rm(partialManifestPath, { force: true }); } catch { /* ok */ }

  onProgress?.({
    phase: 'done', current: 1, total: 1, percent: 100,
    detail: `Scan complete — ${entries.length.toLocaleString()} files in ${allArchives.length} archives`,
  });

  return {
    manifestPath,
    mediaRoot: config.inputDir,
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

  let indexedKeys: Set<string>;
  try {
    indexedKeys = await preloadDestinationIndex(provider, entries);
  } catch (err) {
    log.warn({ err: (err as Error).message }, '⚠️ preloadDestinationIndex failed, falling back to per-key checks');
    indexedKeys = new Set<string>();
  }

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

      try {
        const exists = await objectExistsCached(provider, key, confirmedExistingKeys, existenceCache);
        if (exists) {
          present += 1;
        } else {
          missingKeys.push(key);
        }
      } catch (err) {
        // Transient S3 error after retries — don't count as missing
        log.warn({ key, err: (err as Error).message }, '⚠️ verify check failed, skipping');
        present += 1;
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
    archiveDir: partial.archiveDir,
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
        try { await fs.rmdir(fullPath); } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
            log.warn({ fullPath }, '[runner] Could not remove directory (corrupted?), skipping');
          }
        }
      } else {
        await fs.unlink(fullPath);
      }
    } catch {
      log.warn({ fullPath }, '[runner] Could not remove entry (corrupted?), skipping');
    }
  }

  // Try to remove the directory itself if it's now empty
  try { await fs.rmdir(dirPath); } catch { /* ok if not empty due to skipped entries */ }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getFileSizeBestEffort(filePath: string): Promise<number | undefined> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

async function appendJsonl(entries: ManifestEntry[], filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch {
    // File may not exist yet on first append.
  }

  const lines = entries.map((e) => JSON.stringify(e));
  const next = `${existing}${lines.join('\n')}\n`;
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, next, 'utf8');
  await fs.rename(tmpPath, filePath);
}

