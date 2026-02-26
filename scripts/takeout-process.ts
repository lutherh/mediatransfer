import * as dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadTakeoutConfig } from '../src/takeout/config.js';
import {
  runTakeoutIncremental,
  loadArchiveState,
  formatIncrementalProgress,
} from '../src/takeout/incremental.js';
import { loadArchiveBrowserSummary } from '../src/takeout/archive-browser.js';
import { validateScalewayConfig, ScalewayProvider } from '../src/providers/scaleway.js';
import { discoverTakeoutArchives } from '../src/takeout/unpack.js';

dotenv.config();

const config = loadTakeoutConfig();
const scalewayConfig = validateScalewayConfig({
  provider: 'scaleway',
  region: process.env.SCW_REGION,
  bucket: process.env.SCW_BUCKET,
  accessKey: process.env.SCW_ACCESS_KEY,
  secretKey: process.env.SCW_SECRET_KEY,
  prefix: process.env.SCW_PREFIX,
});

const provider = new ScalewayProvider(scalewayConfig);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const deleteArchive = args.includes('--delete-archive');
const keepExtracted = args.includes('--keep-extracted');
const maxFailures = readNumberArg(args, '--max-failures');
const concurrency = readNumberArg(args, '--concurrency');
const statusOnly = args.includes('--status');

// ─── Status-only mode ──────────────────────────────────────────────────────
if (statusOnly) {
  const archives = await discoverTakeoutArchives(config.inputDir);
  const archiveStatePath = `${config.workDir}/archive-state.json`;
  const archiveState = await loadArchiveState(archiveStatePath);
  const archiveBrowserPath = await findArchiveBrowserPath(config);
  const browserSummary = archiveBrowserPath
    ? await loadArchiveBrowserSummary(archiveBrowserPath).catch(() => undefined)
    : undefined;

  console.log('\n📊 Takeout Incremental Processing Status\n');
  console.log(formatIncrementalProgress(archiveState, archives.length));

  const entries = Object.entries(archiveState.archives);
  const failed = entries.filter(([, v]) => v.status === 'failed');
  if (failed.length > 0) {
    console.log('\n❌ Failed archives:');
    for (const [name, item] of failed) {
      console.log(`   ${name}: ${item.error ?? 'unknown error'}`);
    }
  }

  const totalSize = entries.reduce(
    (sum, [, v]) => sum + v.uploadedCount + v.skippedCount,
    0,
  );
  console.log(`\n📁 ${archives.length} archives in input directory`);
  console.log(`✅ ${entries.filter(([, v]) => v.status === 'completed').length} completed`);
  console.log(`⏳ ${archives.length - entries.length} not yet started`);

  if (browserSummary) {
    console.log('\n🧾 archive_browser.html summary');
    if (browserSummary.serviceName) {
      console.log(`   Service: ${browserSummary.serviceName}`);
    }
    if (browserSummary.serviceFileCount) {
      console.log(`   Estimated files: ${browserSummary.serviceFileCount.toLocaleString()}`);
    }
    if (browserSummary.totalSizeText) {
      console.log(`   Estimated size: ${browserSummary.totalSizeText}`);
    }
    console.log(`   Folders detected: ${browserSummary.folderNames.length}`);
    if (browserSummary.folderNames.length > 0) {
      const sample = browserSummary.folderNames.slice(0, 8).join(' | ');
      console.log(`   Sample folders: ${sample}`);
    }
    console.log(
      `   Sidecar metadata listed: ${browserSummary.hasSupplementalMetadata ? 'yes' : 'no'}`,
    );
  }

  console.log('');
  process.exit(0);
}

// ─── Main processing ───────────────────────────────────────────────────────

console.log('');
console.log('┌─────────────────────────────────────────────┐');
console.log('│  Google Takeout → Scaleway Incremental Mode  │');
console.log('└─────────────────────────────────────────────┘');
console.log('');
console.log('This processes archives one at a time to minimize disk usage.');
console.log(`  Input dir: ${config.inputDir}`);
console.log(`  Work dir: ${config.workDir}`);
console.log(`  Dry run: ${dryRun}`);
console.log(`  Delete archive after upload: ${deleteArchive}`);
console.log(`  Upload concurrency: ${concurrency ?? config.uploadConcurrency}`);
console.log('');

const startTime = Date.now();

const result = await runTakeoutIncremental(config, provider, {
  dryRun,
  maxFailures,
  uploadConcurrency: concurrency,
  deleteArchiveAfterUpload: deleteArchive,
  deleteExtractedAfterUpload: !keepExtracted,
  onArchiveStart(name, index, total) {
    const elapsed = formatDuration(Date.now() - startTime);
    console.log(`\n📦 [${index}/${total}] Processing: ${name}  (elapsed: ${elapsed})`);
  },
  onArchiveComplete(name, summary) {
    console.log(
      `   ✅ Done: ${summary.uploaded} uploaded, ${summary.skipped} skipped, ${summary.failed} failed`,
    );
  },
  onArchiveError(name, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`   ❌ Failed: ${message}`);
    console.log('   Continuing to next archive...');
  },
});

const elapsed = formatDuration(Date.now() - startTime);

console.log('');
console.log('┌──────────────────────────────────────┐');
console.log('│         Processing Complete           │');
console.log('└──────────────────────────────────────┘');
console.log(`  Total archives:      ${result.totalArchives}`);
console.log(`  Already completed:   ${result.skippedArchives}`);
console.log(`  Processed now:       ${result.processedArchives}`);
console.log(`  Failed:              ${result.failedArchives}`);
console.log(`  Total media items:   ${result.totalEntries}`);
console.log(`  Uploaded:            ${result.totalUploaded}`);
console.log(`  Skipped (dedup):     ${result.totalSkipped}`);
console.log(`  Failed items:        ${result.totalFailed}`);
console.log(`  Elapsed:             ${elapsed}`);
if (result.reportJsonPath) {
  console.log(`  Report JSON:         ${result.reportJsonPath}`);
}
if (result.reportCsvPath) {
  console.log(`  Report CSV:          ${result.reportCsvPath}`);
}
console.log('');

if (result.failedArchives > 0) {
  console.log('💡 Tip: Re-run to retry failed archives. Completed archives are skipped automatically.');
  process.exitCode = 2;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readStringArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function readNumberArg(args: string[], name: string): number | undefined {
  const value = readStringArg(args, name);
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60_000) % 60;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

async function findArchiveBrowserPath(config: { inputDir: string; workDir: string }): Promise<string | undefined> {
  const candidates = [
    path.resolve('archive_browser.html'),
    path.join(config.inputDir, 'archive_browser.html'),
    path.join(config.workDir, 'archive_browser.html'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }

  return undefined;
}
