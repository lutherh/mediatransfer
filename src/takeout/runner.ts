import path from 'node:path';
import type { CloudProvider } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
import {
  buildManifest,
  loadManifestJsonl,
  persistManifestJsonl,
} from './manifest.js';
import {
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

  const { archives, mediaRoot } = await unpackAndNormalizeTakeout(
    config.inputDir,
    config.workDir,
    extractor,
    (current, total, archiveName) => {
      const percent = Math.round((current / Math.max(total, 1)) * 70); // extract is ~70% of work
      onProgress?.({ phase: 'extract', current, total, percent, detail: archiveName });
    },
  );

  onProgress?.({ phase: 'manifest', current: 0, total: 0, percent: 72, detail: 'Building manifest...' });

  const entries = await buildManifest(mediaRoot, (processed, total) => {
    const percent = 72 + Math.round((processed / Math.max(total, 1)) * 26); // manifest is ~26%
    onProgress?.({ phase: 'manifest', current: processed, total, percent, detail: `${processed}/${total} files` });
  });

  const manifestPath = path.join(config.workDir, DEFAULT_MANIFEST_FILE);
  await persistManifestJsonl(entries, manifestPath);

  onProgress?.({ phase: 'done', current: 1, total: 1, percent: 100, detail: 'Scan complete' });

  return {
    manifestPath,
    mediaRoot,
    archives,
    entryCount: entries.length,
  };
}

export async function runTakeoutUpload(
  config: TakeoutConfig,
  provider: CloudProvider,
  manifestPath = path.join(config.workDir, DEFAULT_MANIFEST_FILE),
  options: UploadRunOptions = {},
): Promise<UploadRunResult> {
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


