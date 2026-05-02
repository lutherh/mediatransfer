import path from 'node:path';
import fs from 'node:fs/promises';
import type { CloudProvider } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
import { isFileNotFoundError, isCrossDeviceError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import {
  discoverTakeoutArchives,
  extractArchive,
  findGooglePhotosRoots,
  type ArchiveExtractor,
} from './unpack.js';
import {
  buildManifest,
  loadManifestJsonl,
  persistManifestJsonl,
  refineDatesFromMetadata,
  type ManifestEntry,
} from './manifest.js';
import {
  loadUploadState,
  uploadManifest,
  type UploadSkipReason,
  type UploadProgressSnapshot,
  type UploadSummary,
} from './uploader.js';
import {
  buildReconciliationReport,
  persistReportCsv,
  persistReportJson,
} from './report.js';
import { extractAndPersistArchiveMetadata, loadArchiveMetadata } from './archive-metadata.js';
import type { ArchiveMetadata } from './archive-metadata.js';
import { DEFAULT_MANIFEST_FILE } from './runner.js';
import { isPauseRequested } from './pause-flag.js';

const log = getLogger().child({ module: 'incremental' });

// ─── Archive-level state tracking ──────────────────────────────────────────

export type ArchiveStatus = 'pending' | 'extracting' | 'uploading' | 'completed' | 'failed';

export type ArchiveStateItem = {
  status: ArchiveStatus;
  entryCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  transientFailedCount?: number;
  permanentFailedCount?: number;
  skipReasons?: Partial<Record<UploadSkipReason, number>>;
  archiveSizeBytes?: number;
  mediaBytes?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type ArchiveState = {
  version: 1;
  updatedAt: string;
  archives: Record<string, ArchiveStateItem>;
};

export function createEmptyArchiveState(): ArchiveState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    archives: {},
  };
}

export async function loadArchiveState(statePath: string): Promise<ArchiveState> {
  try {
    const raw = (await fs.readFile(statePath, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as ArchiveState;
    if (parsed.version !== 1 || typeof parsed.archives !== 'object') {
      return createEmptyArchiveState();
    }
    return parsed;
  } catch (err) {
    if (!isFileNotFoundError(err)) {
      log.debug({ err }, '[incremental] Failed to load archive state, using empty state');
    }
    return createEmptyArchiveState();
  }
}

export async function persistArchiveState(
  statePath: string,
  state: ArchiveState,
): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const dir = path.dirname(statePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  const serialized = JSON.stringify(state, null, 2);

  try {
    await fs.writeFile(tmpPath, serialized, 'utf8');
    await fs.rename(tmpPath, statePath);
    return;
  } catch (error) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }

    if (!isNoSpaceLeftError(error)) {
      throw error;
    }

    log.warn(
      {
        statePath,
        error: error instanceof Error ? error.message : String(error),
      },
      '[incremental] Low disk space while writing archive state tmp file; retrying in-place',
    );
  }

  await fs.writeFile(statePath, serialized, 'utf8');
}

// ─── Incremental processing ────────────────────────────────────────────────

export type IncrementalOptions = {
  dryRun?: boolean;
  maxFailures?: number;
  uploadConcurrency?: number;
  deleteArchiveAfterUpload?: boolean;
  moveArchiveAfterUpload?: boolean;
  completedArchiveDir?: string;
  deleteExtractedAfterUpload?: boolean;
  reportDir?: string;
  metadataDir?: string;
  progressIntervalMs?: number;
  onArchiveStart?: (archiveName: string, index: number, total: number) => void;
  onArchiveComplete?: (archiveName: string, summary: UploadSummary) => void;
  onArchiveError?: (archiveName: string, error: unknown) => void;
  onUploadProgress?: (archiveName: string, snapshot: UploadProgressSnapshot) => void;
  /**
   * Called once when a pause flag is observed at an archive boundary and the
   * loop is about to exit early. `remainingArchives` includes the archive that
   * would have been processed next.
   */
  onPaused?: (remainingArchives: number) => void;
};

async function persistArchiveMetadataBestEffort(
  extractDir: string,
  entries: ManifestEntry[],
  archiveName: string,
  metadataDir: string,
): Promise<void> {
  try {
    await extractAndPersistArchiveMetadata(extractDir, entries, archiveName, metadataDir);
  } catch (error) {
    log.warn(
      {
        archiveName,
        metadataDir,
        error: error instanceof Error ? error.message : String(error),
      },
      '[incremental] Failed to persist archive metadata; continuing upload',
    );
  }
}

async function loadArchiveMetadataBestEffort(
  metadataDir: string,
  archiveName: string,
): Promise<ArchiveMetadata | undefined> {
  try {
    return await loadArchiveMetadata(metadataDir, archiveName);
  } catch {
    return undefined;
  }
}

export type IncrementalResult = {
  totalArchives: number;
  processedArchives: number;
  skippedArchives: number;
  failedArchives: number;
  totalEntries: number;
  totalUploaded: number;
  totalSkipped: number;
  totalFailed: number;
  reportJsonPath?: string;
  reportCsvPath?: string;
  /** True when the loop exited early because a pause flag was observed at an archive boundary. */
  paused?: boolean;
  /** Archives left in the pending queue when paused. Undefined when `paused` is not true. */
  remainingAfterPause?: number;
};

/**
 * Process Google Takeout archives one at a time, uploading each to the cloud
 * provider before moving to the next. This keeps disk usage bounded to
 * roughly the size of one extracted archive (~10 GB) rather than the entire
 * library.
 *
 * Flow per archive:
 *   1. Extract to a temporary work directory
 *   2. Find Google Photos roots inside the extraction
 *   3. Build manifest entries for this archive's media files
 *   4. Upload entries (reuses global state.json for dedup)
 *   5. Append entries to the global manifest
 *   6. Record archive as completed in archive-state.json
 *   7. Clean up extracted files to free disk space
 */
export async function runTakeoutIncremental(
  config: TakeoutConfig,
  provider: CloudProvider,
  options: IncrementalOptions = {},
  extractor: ArchiveExtractor = extractArchive,
): Promise<IncrementalResult> {
  const archiveStatePath = path.join(config.workDir, 'archive-state.json');
  const archiveState = await loadArchiveState(archiveStatePath);
  const archives = await discoverTakeoutArchives(config.inputDir);

  // Filter out already-completed archives
  const pending = archives.filter((archivePath) => {
    const name = path.basename(archivePath);
    return archiveState.archives[name]?.status !== 'completed';
  });

  const result: IncrementalResult = {
    totalArchives: archives.length,
    processedArchives: 0,
    skippedArchives: archives.length - pending.length,
    failedArchives: 0,
    totalEntries: 0,
    totalUploaded: 0,
    totalSkipped: 0,
    totalFailed: 0,
  };

  const globalManifestPath = path.join(config.workDir, DEFAULT_MANIFEST_FILE);
  const metadataDir = options.metadataDir ?? path.join(config.workDir, 'metadata');

  for (let i = 0; i < pending.length; i += 1) {
    // Graceful pause check: stop cleanly between archives so the next run
    // resumes from the same point. Per-archive boundary is the safest place
    // — extraction has not started, no temp files exist, and archive-state
    // already reflects everything we've persisted.
    if (await isPauseRequested(config.workDir)) {
      const remaining = pending.length - i;
      log.info(
        { remaining, completed: i, total: pending.length },
        '[incremental] Pause flag detected; stopping at archive boundary. Re-run upload to resume.',
      );
      result.paused = true;
      result.remainingAfterPause = remaining;
      options.onPaused?.(remaining);
      break;
    }

    const archivePath = pending[i];
    const archiveName = path.basename(archivePath);
    const extractDir = path.join(config.workDir, 'temp-extract');
    const archiveSizeBytes = await getFileSizeBestEffort(archivePath);

    options.onArchiveStart?.(archiveName, i + 1, pending.length);

    // Mark as extracting
    archiveState.archives[archiveName] = {
      status: 'extracting',
      entryCount: 0,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      archiveSizeBytes,
      startedAt: new Date().toISOString(),
    };
    await persistArchiveState(archiveStatePath, archiveState);

    try {
      // 1. Extract this single archive
      await cleanupDir(extractDir);
      await fs.mkdir(extractDir, { recursive: true });
      await extractor(archivePath, extractDir);

      // 2. Find Google Photos roots
      const roots = await findGooglePhotosRoots(extractDir);
      let archiveSummary: UploadSummary | undefined;

      if (roots.length === 0) {
        // If no Google Photos folder, try treating the extraction root as media root
        // (handles edge case of non-standard Takeout formatting)
        const entries = await buildManifest(extractDir);
        if (entries.length === 0) {
          archiveState.archives[archiveName] = {
            ...archiveState.archives[archiveName],
            status: 'completed',
            completedAt: new Date().toISOString(),
          };
          await persistArchiveState(archiveStatePath, archiveState);
          result.processedArchives += 1;
          await cleanupDir(extractDir);
          continue;
        }
        // Save album + sidecar + duplicate metadata before cleanup
        await persistArchiveMetadataBestEffort(extractDir, entries, archiveName, metadataDir);
        // Refine dates using archive metadata (edited→original, cross-extension, album median)
        const archiveMeta = await loadArchiveMetadataBestEffort(metadataDir, archiveName);
        if (archiveMeta) {
          const { refinedCount, breakdown } = refineDatesFromMetadata(entries, archiveMeta);
          if (refinedCount > 0) {
            log.info({ archiveName, refinedCount, breakdown }, '[incremental] Date refinement for archive: entries improved');
          }
        }
        // Process entries from the root
        archiveSummary = await processArchiveEntries(
          entries,
          archiveName,
          config,
          provider,
          archiveState,
          archiveStatePath,
          globalManifestPath,
          result,
          options,
        );
        if (archiveSummary.failed > 0) {
          result.failedArchives += 1;
        }
      } else {
        // 3. Build manifest from each Google Photos root
        const allEntries: ManifestEntry[] = [];
        for (const root of roots) {
          const entries = await buildManifest(root);
          allEntries.push(...entries);
        }

        // Save album + sidecar + duplicate metadata before cleanup
        await persistArchiveMetadataBestEffort(extractDir, allEntries, archiveName, metadataDir);

        // Refine dates using archive metadata (edited→original, cross-extension, album median)
        const archiveMeta = await loadArchiveMetadataBestEffort(metadataDir, archiveName);
        if (archiveMeta) {
          const { refinedCount, breakdown } = refineDatesFromMetadata(allEntries, archiveMeta);
          if (refinedCount > 0) {
            log.info({ archiveName, refinedCount, breakdown }, '[incremental] Date refinement for archive: entries improved');
          }
        }

        archiveSummary = await processArchiveEntries(
          allEntries,
          archiveName,
          config,
          provider,
          archiveState,
          archiveStatePath,
          globalManifestPath,
          result,
          options,
        );
        if (archiveSummary.failed > 0) {
          result.failedArchives += 1;
        }
      }

      const archiveUploadSucceeded = (archiveSummary?.failed ?? 0) === 0;

      // Post-upload operations: cleanup and archive move/delete.
      // These must NOT affect the archive status — data is already safely in the cloud.
      try {
        // 7. Clean up extracted files
        if (!options.dryRun && options.deleteExtractedAfterUpload !== false && archiveUploadSucceeded) {
          await cleanupDir(extractDir);
        }

        // Optionally delete the source archive to free download space
        if (!options.dryRun && archiveUploadSucceeded && options.deleteArchiveAfterUpload) {
          await fs.unlink(archivePath);
        } else if (!options.dryRun && archiveUploadSucceeded && options.moveArchiveAfterUpload) {
          const completedArchiveDir = options.completedArchiveDir ?? path.join(config.inputDir, 'uploaded-archives');
          await moveArchiveToCompletedDir(archivePath, completedArchiveDir);
        }
      } catch (postUploadError) {
        // Log but don't change archive status — upload data is safe
        log.warn({ archiveName, err: postUploadError }, '[incremental] Post-upload operation failed for archive');
      }

      options.onArchiveComplete?.(archiveName, {
        total: archiveState.archives[archiveName].entryCount,
        processed: archiveState.archives[archiveName].uploadedCount +
          archiveState.archives[archiveName].skippedCount +
          archiveState.archives[archiveName].failedCount,
        uploaded: archiveState.archives[archiveName].uploadedCount,
        skipped: archiveState.archives[archiveName].skippedCount,
        failed: archiveState.archives[archiveName].failedCount,
        transientFailures: archiveState.archives[archiveName].transientFailedCount ?? 0,
        permanentFailures: archiveState.archives[archiveName].permanentFailedCount ?? 0,
        dryRun: options.dryRun ?? false,
        stoppedEarly: archiveState.archives[archiveName].failedCount > 0,
        failureLimitReached: false,
      });
    } catch (error) {
      const currentStatus = archiveState.archives[archiveName]?.status;
      if (currentStatus === 'completed') {
        // Upload already succeeded and was persisted — don't overwrite to 'failed'
        log.warn({ archiveName, err: error }, '[incremental] Post-upload error for archive, keeping completed status');
      } else {
        const wasAlreadyFailed = currentStatus === 'failed';
        archiveState.archives[archiveName] = {
          ...archiveState.archives[archiveName],
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
        await persistArchiveState(archiveStatePath, archiveState);
        if (!wasAlreadyFailed) {
          result.failedArchives += 1;
        }
      }

      options.onArchiveError?.(archiveName, error);

      // Clean up even on failure
      await cleanupDir(extractDir).catch(() => {});

      // Continue to next archive — don't let one failure block everything
    }
  }

  // Reconcile stale manifest entries when all archives have been processed.
  // The scan phase writes manifest entries with destinationKeys that may differ
  // from the upload phase (due to date refinement).  After incremental upload
  // completes, the manifest contains BOTH sets — the scan's stale keys (no
  // state record) and the upload's valid keys.  Remove the stale ones so the
  // status endpoint shows accurate counts instead of phantom "pending" items.
  const reconcileResult = await reconcileManifest(globalManifestPath, config.statePath);
  if (reconcileResult.removed > 0) {
    log.info(
      { removed: reconcileResult.removed, kept: reconcileResult.kept },
      '[incremental] Manifest reconciled',
    );
  }

  const entries = await loadManifestJsonl(globalManifestPath);
  const state = await loadUploadState(config.statePath);
  const finalSummary: UploadSummary = {
    total: result.totalEntries,
    processed: result.totalUploaded + result.totalSkipped + result.totalFailed,
    uploaded: result.totalUploaded,
    skipped: result.totalSkipped,
    failed: result.totalFailed,
    transientFailures: 0,
    permanentFailures: 0,
    dryRun: options.dryRun ?? false,
    stoppedEarly: false,
    failureLimitReached: false,
  };

  const report = buildReconciliationReport(entries, state, finalSummary);
  const reportDir = options.reportDir ?? path.join(config.workDir, 'reports');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportJsonPath = path.join(reportDir, `incremental-${stamp}.json`);
  const reportCsvPath = path.join(reportDir, `incremental-${stamp}.csv`);
  await persistReportJson(report, reportJsonPath);
  await persistReportCsv(state, reportCsvPath);
  result.reportJsonPath = reportJsonPath;
  result.reportCsvPath = reportCsvPath;

  return result;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

async function processArchiveEntries(
  entries: ManifestEntry[],
  archiveName: string,
  config: TakeoutConfig,
  provider: CloudProvider,
  archiveState: ArchiveState,
  archiveStatePath: string,
  globalManifestPath: string,
  result: IncrementalResult,
  options: IncrementalOptions,
): Promise<UploadSummary> {
  // Update archive state with entry count
  archiveState.archives[archiveName] = {
    ...archiveState.archives[archiveName],
    status: 'uploading',
    entryCount: entries.length,
  };
  await persistArchiveState(archiveStatePath, archiveState);

  // 4. Upload entries (global state.json handles dedup)
  const summary = await uploadManifest({
    provider,
    entries,
    statePath: config.statePath,
    uploadConcurrency: options.uploadConcurrency ?? config.uploadConcurrency,
    retryCount: config.uploadRetryCount,
    dryRun: options.dryRun,
    maxFailures: options.maxFailures,
    progressIntervalMs: options.progressIntervalMs,
    onProgress: options.onUploadProgress
      ? (snapshot) => options.onUploadProgress?.(archiveName, snapshot)
      : undefined,
  });

  // 5. Append to global manifest
  await appendManifestJsonl(entries, globalManifestPath);

  // 6. Mark archive completed
  const failed = summary.failed > 0;
  archiveState.archives[archiveName] = {
    ...archiveState.archives[archiveName],
    status: failed ? 'failed' : 'completed',
    entryCount: entries.length,
    uploadedCount: summary.uploaded,
    skippedCount: summary.skipped,
    failedCount: summary.failed,
    transientFailedCount: summary.transientFailures,
    permanentFailedCount: summary.permanentFailures,
    skipReasons: summary.skipReasons,
    mediaBytes: entries.reduce((sum, entry) => sum + Math.max(0, entry.size ?? 0), 0),
    completedAt: new Date().toISOString(),
    error: failed ? `${summary.failed} item(s) failed in archive upload` : undefined,
  };
  await persistArchiveState(archiveStatePath, archiveState);

  if (!failed) {
    result.processedArchives += 1;
  }
  result.totalEntries += entries.length;
  result.totalUploaded += summary.uploaded;
  result.totalSkipped += summary.skipped;
  result.totalFailed += summary.failed;

  return summary;
}

async function appendManifestJsonl(
  entries: ManifestEntry[],
  manifestPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const lines = entries.map((entry) => JSON.stringify(entry));
  const appended = `${existing}${lines.join('\n')}\n`;
  const tmpPath = `${manifestPath}.tmp`;
  await fs.writeFile(tmpPath, appended, 'utf8');
  await fs.rename(tmpPath, manifestPath);
}

async function cleanupDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (err) {
    log.debug({ dirPath, err }, '[incremental] Best-effort cleanup failed');
    // best-effort cleanup
  }
}

async function moveArchiveToCompletedDir(archivePath: string, completedDir: string): Promise<void> {
  // Skip move if the archive is already in the target directory (e.g. Input === Archive)
  const sourceDir = path.resolve(path.dirname(archivePath));
  const targetDir = path.resolve(completedDir);
  if (sourceDir.toLowerCase() === targetDir.toLowerCase()) {
    return;
  }

  await fs.mkdir(completedDir, { recursive: true });
  const archiveName = path.basename(archivePath);
  const destinationPath = await getUniqueDestinationPath(completedDir, archiveName);

  try {
    await fs.rename(archivePath, destinationPath);
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
    // Cross-device (e.g. external HD): copy then delete
    await fs.copyFile(archivePath, destinationPath);
    await fs.unlink(archivePath);
  }
}

async function getUniqueDestinationPath(directory: string, fileName: string): Promise<string> {
  const parsed = path.parse(fileName);
  const baseName = parsed.name;
  const extension = parsed.ext;

  // Read existing files once and compute next available suffix in memory
  let existingNames: Set<string>;
  try {
    const dirEntries = await fs.readdir(directory);
    existingNames = new Set(dirEntries);
  } catch (err) {
    log.debug({ directory, err }, '[incremental] Destination directory not readable, using base file name');
    // Directory doesn't exist yet — no collisions possible
    return path.join(directory, fileName);
  }

  if (!existingNames.has(fileName)) {
    return path.join(directory, fileName);
  }

  let suffix = 1;
  while (true) {
    const candidateName = `${baseName}-${suffix}${extension}`;
    if (!existingNames.has(candidateName)) {
      return path.join(directory, candidateName);
    }
    suffix += 1;
  }
}

/** @deprecated Use `isCrossDeviceError` from `../utils/errors.js` instead. */
export { isCrossDeviceError as isCrossDeviceRenameError } from '../utils/errors.js';

function isNoSpaceLeftError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOSPC',
  );
}

async function getFileSizeBestEffort(filePath: string): Promise<number | undefined> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return undefined;
  }
}

// ─── Reconciliation ────────────────────────────────────────────────────────

/**
 * Marks stale pending/extracting/uploading archives as completed when the
 * overall upload is done (all manifest items uploaded, none failed).
 *
 * This handles the case where archives were processed through the
 * non-incremental scan→upload flow: the scan step creates archive-state
 * entries as 'pending', but the bulk upload step doesn't update them.
 *
 * Returns the number of archives reconciled (0 if nothing changed).
 */
export async function reconcileStaleArchives(
  archiveStatePath: string,
): Promise<number> {
  const state = await loadArchiveState(archiveStatePath);
  const { archives, reconciled } = reconcileArchiveEntries(state.archives);
  state.archives = archives;

  if (reconciled > 0) {
    await persistArchiveState(archiveStatePath, state);
  }
  return reconciled;
}

export function reconcileArchiveEntries(
  archives: Record<string, ArchiveStateItem>,
): { archives: Record<string, ArchiveStateItem>; reconciled: number } {
  let reconciled = 0;
  const nextArchives: Record<string, ArchiveStateItem> = {};

  for (const [name, item] of Object.entries(archives)) {
    if (item.status === 'extracting' || item.status === 'pending') {
      if (item.entryCount === 0 && item.uploadedCount === 0) {
        // Never processed — drop from state so the archive gets reprocessed
        reconciled += 1;
        continue;
      }
      if (item.failedCount === 0 && (item.uploadedCount + item.skippedCount) >= item.entryCount && item.entryCount > 0) {
        // Fully handled despite stale status — mark completed for accurate status/reporting.
        nextArchives[name] = {
          ...item,
          status: 'completed',
          error: undefined,
          completedAt: item.completedAt ?? new Date().toISOString(),
        };
        reconciled += 1;
        continue;
      }
      // Had entries scanned/partially processed — mark failed for retry
      nextArchives[name] = {
        ...item,
        status: 'failed',
        completedAt: item.completedAt ?? new Date().toISOString(),
        error: 'Interrupted during ' + item.status,
      };
      reconciled += 1;
    } else if (item.status === 'uploading') {
      if (item.failedCount === 0 && (item.uploadedCount + item.skippedCount) >= item.entryCount && item.entryCount > 0) {
        // All items were actually uploaded/skipped — safe to mark completed
        nextArchives[name] = {
          ...item,
          status: 'completed',
          completedAt: item.completedAt ?? new Date().toISOString(),
        };
      } else {
        // Upload was interrupted — mark failed for retry
        nextArchives[name] = {
          ...item,
          status: 'failed',
          completedAt: item.completedAt ?? new Date().toISOString(),
          error: 'Interrupted during upload',
        };
      }
      reconciled += 1;
    } else if (item.status === 'failed' && item.failedCount === 0 && item.entryCount > 0
      && (item.uploadedCount + item.skippedCount) >= item.entryCount) {
      // Upload succeeded but post-upload operation (e.g. archive move) caused 'failed' status.
      // All items were actually handled — safe to mark completed.
      nextArchives[name] = {
        ...item,
        status: 'completed',
        error: undefined,
        completedAt: item.completedAt ?? new Date().toISOString(),
      };
      reconciled += 1;
    } else {
      nextArchives[name] = item;
    }
  }

  return { archives: nextArchives, reconciled };
}

// ─── Manifest reconciliation ───────────────────────────────────────────────

/**
 * Remove stale manifest entries whose `destinationKey` has no corresponding
 * record in the upload state (state.json).
 *
 * This happens when the scan phase writes manifest entries with one set of
 * destinationKeys and the incremental upload later appends entries with
 * different keys (due to improved date refinement with sidecar/metadata).
 * The old scan entries become orphaned "pending" items that can never be
 * uploaded because their archives are already marked completed.
 *
 * Returns the number of entries removed and kept.
 */
export async function reconcileManifest(
  manifestPath: string,
  statePath: string,
): Promise<{ removed: number; kept: number }> {
  let entries: ManifestEntry[];
  try {
    entries = await loadManifestJsonl(manifestPath);
  } catch {
    return { removed: 0, kept: 0 };
  }

  if (entries.length === 0) {
    return { removed: 0, kept: 0 };
  }

  let state: Awaited<ReturnType<typeof loadUploadState>>;
  try {
    state = await loadUploadState(statePath);
  } catch {
    // State file missing or corrupt — can't reconcile without it
    return { removed: 0, kept: 0 };
  }
  const stateKeys = new Set(Object.keys(state.items));

  // Keep entries that have a matching record in the upload state
  const kept = entries.filter((e) => stateKeys.has(e.destinationKey));
  const removed = entries.length - kept.length;

  if (removed > 0) {
    await persistManifestJsonl(kept, manifestPath);
  }

  return { removed, kept: kept.length };
}

// ─── Summary / progress helpers ────────────────────────────────────────────

export function formatIncrementalProgress(
  archiveState: ArchiveState,
  totalExpected: number,
): string {
  const entries = Object.entries(archiveState.archives);
  const completed = entries.filter(([, v]) => v.status === 'completed').length;
  const failed = entries.filter(([, v]) => v.status === 'failed').length;
  const inProgress = entries.filter(
    ([, v]) => v.status === 'extracting' || v.status === 'uploading',
  ).length;

  const totalUploaded = entries.reduce((sum, [, v]) => sum + v.uploadedCount, 0);
  const totalEntries = entries.reduce((sum, [, v]) => sum + v.entryCount, 0);

  return [
    `Archives: ${completed}/${totalExpected} completed, ${inProgress} in-progress, ${failed} failed`,
    `Media items: ${totalUploaded} uploaded, ${totalEntries} total processed`,
  ].join('\n');
}
