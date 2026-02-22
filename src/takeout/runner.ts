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
  loadUploadState,
  uploadManifest,
  type UploadSummary,
} from './uploader.js';
import {
  buildReconciliationReport,
  persistReportCsv,
  persistReportJson,
} from './report.js';

export const DEFAULT_MANIFEST_FILE = 'manifest.jsonl';

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
};

export type UploadRunResult = {
  summary: UploadSummary;
  reportJsonPath: string;
  reportCsvPath: string;
};

export async function runTakeoutScan(
  config: TakeoutConfig,
  extractor?: ArchiveExtractor,
): Promise<ScanResult> {
  const { archives, mediaRoot } = await unpackAndNormalizeTakeout(
    config.inputDir,
    config.workDir,
    extractor,
  );

  const entries = await buildManifest(mediaRoot);
  const manifestPath = path.join(config.workDir, DEFAULT_MANIFEST_FILE);
  await persistManifestJsonl(entries, manifestPath);

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
  const indexedKeys = await preloadVerifyDestinationIndex(provider, entries);
  const existingCache = new Map<string, boolean>();
  const missingKeys: string[] = [];
  let present = 0;
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

      if (indexedKeys.has(key)) {
        present += 1;
        continue;
      }

      const exists = await objectExistsCached(provider, key, existingCache);
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

async function preloadVerifyDestinationIndex(
  provider: CloudProvider,
  entries: Array<{ destinationKey: string }>,
): Promise<Set<string>> {
  const prefixes = collectDatePrefixes(entries);
  const keys = new Set<string>();

  for (const prefix of prefixes) {
    const listed = await provider.list({ prefix });
    for (const item of listed) {
      keys.add(item.key);
    }
  }

  return keys;
}

function collectDatePrefixes(entries: Array<{ destinationKey: string }>): string[] {
  const prefixes = new Set<string>();

  for (const entry of entries) {
    const match = /^(\d{4}\/\d{2}\/\d{2})\//.exec(entry.destinationKey);
    if (match?.[1]) {
      prefixes.add(`${match[1]}/`);
    }
  }

  return [...prefixes].sort((a, b) => a.localeCompare(b));
}

async function objectExistsCached(
  provider: CloudProvider,
  key: string,
  existingCache: Map<string, boolean>,
): Promise<boolean> {
  const cached = existingCache.get(key);
  if (typeof cached === 'boolean') {
    return cached;
  }

  const objects = await provider.list({ prefix: key, maxResults: 20 });
  const exists = objects.some((obj) => obj.key === key);
  existingCache.set(key, exists);
  return exists;
}
