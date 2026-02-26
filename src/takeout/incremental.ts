import path from 'node:path';
import fs from 'node:fs/promises';
import type { CloudProvider } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
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
  type ManifestEntry,
} from './manifest.js';
import {
  loadUploadState,
  uploadManifest,
  type UploadSummary,
} from './uploader.js';
import {
  buildReconciliationReport,
  persistReportCsv,
  persistReportJson,
} from './report.js';
import { DEFAULT_MANIFEST_FILE } from './runner.js';

// ─── Archive-level state tracking ──────────────────────────────────────────

export type ArchiveStatus = 'pending' | 'extracting' | 'uploading' | 'completed' | 'failed';

export type ArchiveStateItem = {
  status: ArchiveStatus;
  entryCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
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
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as ArchiveState;
    if (parsed.version !== 1 || typeof parsed.archives !== 'object') {
      return createEmptyArchiveState();
    }
    return parsed;
  } catch {
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
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmpPath, statePath);
}

// ─── Incremental processing ────────────────────────────────────────────────

export type IncrementalOptions = {
  dryRun?: boolean;
  maxFailures?: number;
  uploadConcurrency?: number;
  deleteArchiveAfterUpload?: boolean;
  deleteExtractedAfterUpload?: boolean;
  reportDir?: string;
  onArchiveStart?: (archiveName: string, index: number, total: number) => void;
  onArchiveComplete?: (archiveName: string, summary: UploadSummary) => void;
  onArchiveError?: (archiveName: string, error: unknown) => void;
};

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

  for (let i = 0; i < pending.length; i += 1) {
    const archivePath = pending[i];
    const archiveName = path.basename(archivePath);
    const extractDir = path.join(config.workDir, 'temp-extract');

    options.onArchiveStart?.(archiveName, i + 1, pending.length);

    // Mark as extracting
    archiveState.archives[archiveName] = {
      status: 'extracting',
      entryCount: 0,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
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
        // Process entries from the root
        const archiveSummary = await processArchiveEntries(
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

        const archiveSummary = await processArchiveEntries(
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

      // 7. Clean up extracted files
      if (options.deleteExtractedAfterUpload !== false) {
        await cleanupDir(extractDir);
      }

      // Optionally delete the source archive to free download space
      if (options.deleteArchiveAfterUpload) {
        await fs.unlink(archivePath);
      }

      options.onArchiveComplete?.(archiveName, {
        total: archiveState.archives[archiveName].entryCount,
        processed: archiveState.archives[archiveName].uploadedCount +
          archiveState.archives[archiveName].skippedCount +
          archiveState.archives[archiveName].failedCount,
        uploaded: archiveState.archives[archiveName].uploadedCount,
        skipped: archiveState.archives[archiveName].skippedCount,
        failed: archiveState.archives[archiveName].failedCount,
        dryRun: options.dryRun ?? false,
        stoppedEarly: archiveState.archives[archiveName].failedCount > 0,
        failureLimitReached: false,
      });
    } catch (error) {
      const wasAlreadyFailed = archiveState.archives[archiveName]?.status === 'failed';
      archiveState.archives[archiveName] = {
        ...archiveState.archives[archiveName],
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      await persistArchiveState(archiveStatePath, archiveState);
      if (!wasAlreadyFailed) {
        result.failedArchives += 1;
      }

      options.onArchiveError?.(archiveName, error);

      // Clean up even on failure
      await cleanupDir(extractDir).catch(() => {});

      // Continue to next archive — don't let one failure block everything
    }
  }

  const entries = await loadManifestJsonl(globalManifestPath).catch(() => []);
  const state = await loadUploadState(config.statePath);
  const finalSummary: UploadSummary = {
    total: result.totalEntries,
    processed: result.totalUploaded + result.totalSkipped + result.totalFailed,
    uploaded: result.totalUploaded,
    skipped: result.totalSkipped,
    failed: result.totalFailed,
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
  const lines = entries.map((entry) => JSON.stringify(entry));
  await fs.appendFile(manifestPath, `${lines.join('\n')}\n`, 'utf8');
}

async function cleanupDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
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
