import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudProvider } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
import {
  buildManifest,
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
  const normalizedDir  = path.join(config.workDir, 'normalized');

  // ── No archive files at all: fall back to direct-media / descriptive error ─
  if (allArchives.length === 0) {
    const { archives, mediaRoot } = await unpackAndNormalizeTakeout(
      config.inputDir, config.workDir, extractor,
    );
    onProgress?.({ phase: 'manifest', current: 0, total: 0, percent: 72, detail: 'Building manifest...' });
    const entries = await buildManifest(mediaRoot, (processed, total) => {
      const pct = 72 + Math.round((processed / Math.max(total, 1)) * 26);
      onProgress?.({ phase: 'manifest', current: processed, total, percent: pct, detail: `${processed}/${total} files` });
    });
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
      ? 'All archives already extracted'
      : `${allArchives.length - toExtract.length} already extracted, ${toExtract.length} remaining`,
  });

  // ── Short-circuit: nothing left to extract + manifest already built ────────
  if (toExtract.length === 0) {
    try {
      const existingEntries = await loadManifestJsonl(manifestPath);
      if (existingEntries.length > 0) {
        onProgress?.({
          phase: 'done', current: 1, total: 1, percent: 100,
          detail: `No new archives — ${existingEntries.length.toLocaleString()} files already in manifest`,
        });
        return { manifestPath, mediaRoot: config.workDir, archives: [], entryCount: existingEntries.length };
      }
    } catch { /* no manifest yet — fall through to normalize+build */ }
  }

  // ── Phase 1: Extract new archives one at a time (checkpointed) ────────────
  const effectiveExtractor = extractor ?? extractArchive;
  const totalArchives  = allArchives.length;
  const alreadyDone    = totalArchives - toExtract.length;

  for (let i = 0; i < toExtract.length; i++) {
    const archivePath = toExtract[i];
    const archiveName = path.basename(archivePath);

    // Weight extraction as 0‒65 % of total progress
    const percent = Math.round(((alreadyDone + i) / Math.max(totalArchives, 1)) * 65);
    onProgress?.({
      phase: 'extract',
      current: alreadyDone + i + 1,
      total: totalArchives,
      percent,
      detail: archiveName,
    });

    await effectiveExtractor(archivePath, config.workDir);

    // Checkpoint immediately so a timeout / crash leaves progress intact
    scanState.extractedArchives.push(archiveName);
    await saveScanState(scanStatePath, scanState);
  }

  // ── Phase 2: Normalize (wipe first for idempotency) ───────────────────────
  // Wipe the normalized folder so that re-runs don't accumulate __dup files.
  // This directory is derived from Takeout/ so rebuilding it is always safe.
  onProgress?.({ phase: 'normalize', current: 0, total: 1, percent: 67, detail: 'Merging extracted folders...' });
  try { await fs.rm(normalizedDir, { recursive: true, force: true }); } catch { /* ok if absent */ }

  const roots = await findGooglePhotosRoots(config.workDir);
  let mediaRoot: string;
  if (roots.length > 0) {
    mediaRoot = await normalizeTakeoutMediaRoot(config.workDir);
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

  // ── Phase 3: Build manifest ────────────────────────────────────────────────
  onProgress?.({ phase: 'manifest', current: 0, total: 0, percent: 73, detail: 'Building manifest...' });

  const entries = await buildManifest(mediaRoot, (processed, total) => {
    const pct = 73 + Math.round((processed / Math.max(total, 1)) * 25);
    onProgress?.({ phase: 'manifest', current: processed, total, percent: pct, detail: `${processed.toLocaleString()}/${total.toLocaleString()} files` });
  });

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


