import * as dotenv from 'dotenv';
import path from 'node:path';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';
import { runTakeoutIncremental } from '../src/takeout/incremental.js';
import type { UploadProgressSnapshot } from '../src/takeout/uploader.js';
import { validateScalewayConfig, ScalewayProvider } from '../src/providers/scaleway.js';
import { formatDuration, formatBytes } from '../src/utils/format.js';
import { ensureCaffeinate } from '../src/utils/caffeinate.js';

dotenv.config();
ensureCaffeinate();

const args = process.argv.slice(2);
const pathOverrides = parseTakeoutPathArgs(args);
const config = loadTakeoutConfig(undefined, pathOverrides);
const scalewayConfig = validateScalewayConfig({
  provider: 'scaleway',
  region: process.env.SCW_REGION,
  bucket: process.env.SCW_BUCKET,
  accessKey: process.env.SCW_ACCESS_KEY,
  secretKey: process.env.SCW_SECRET_KEY,
  prefix: process.env.SCW_PREFIX,
});

const provider = new ScalewayProvider(scalewayConfig);
const dryRun = args.includes('--dry-run');
const maxFailures = readNumberArg(args, '--max-failures');
const progressIntervalSec = readNumberArg(args, '--progress-interval-sec');
const progressIntervalMs = progressIntervalSec !== undefined
  ? Math.max(0.5, progressIntervalSec) * 1000
  : undefined;

const moveArchives = args.includes('--move-archives') || !!config.archiveDir;
const archiveDirOverride = readStringArg(args, '--archive-dir');
const completedArchiveDir = archiveDirOverride
  ? path.resolve(archiveDirOverride)
  : config.archiveDir;

const progressTracker = createUploadProgressTracker();

console.log('🔁 Resuming Takeout upload (incremental pipeline — skips completed archives)...');
if (completedArchiveDir) {
  console.log(`   Archive dir: ${completedArchiveDir} (uploaded .tgz files will be moved here)`);
}
const result = await runTakeoutIncremental(
  config,
  provider,
  {
    dryRun,
    maxFailures,
    uploadConcurrency: config.uploadConcurrency,
    moveArchiveAfterUpload: moveArchives,
    completedArchiveDir,
    progressIntervalMs,
    onArchiveStart(archiveName, index, total) {
      console.log(`\n📦 [${index}/${total}] Resuming archive: ${archiveName}`);
    },
    onArchiveComplete(archiveName, summary) {
      console.log(`   ✅ ${archiveName}: ${summary.uploaded} uploaded, ${summary.skipped} skipped, ${summary.failed} failed`);
    },
    onArchiveError(archiveName, error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`   ❌ ${archiveName}: ${msg}`);
    },
    onUploadProgress(_archiveName, snapshot) {
      progressTracker.render(snapshot);
    },
  },
);
progressTracker.complete();
console.log('\n✅ Resume finished');
console.log(`   Archives: ${result.processedArchives}/${result.totalArchives} processed, ${result.skippedArchives} skipped, ${result.failedArchives} failed`);
console.log(`   Total entries: ${result.totalEntries}`);
console.log(`   Uploaded: ${result.totalUploaded}`);
console.log(`   Skipped: ${result.totalSkipped}`);
console.log(`   Failed: ${result.totalFailed}`);
console.log(`   Dry run: ${dryRun}`);
if (result.reportJsonPath) console.log(`   Report JSON: ${result.reportJsonPath}`);
if (result.reportCsvPath) console.log(`   Report CSV: ${result.reportCsvPath}`);

if (result.totalFailed > 0) {
  process.exitCode = 2;
}

function readStringArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function readNumberArg(args: string[], name: string): number | undefined {
  const value = readStringArg(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type UploadProgressState = {
  lastRenderAtMs: number;
  lastSnapshotAtMs: number;
  lastTransferredBytes: number;
};

function createUploadProgressTracker() {
  const state: UploadProgressState = {
    lastRenderAtMs: 0,
    lastSnapshotAtMs: 0,
    lastTransferredBytes: 0,
  };

  return {
    render(snapshot: UploadProgressSnapshot): void {
      const now = Date.now();
      const elapsedSinceSnapshotMs = Math.max(1, now - state.lastSnapshotAtMs);
      const deltaBytes = Math.max(0, snapshot.transferredBytes - state.lastTransferredBytes);
      const speedBytesPerSec = Math.floor((deltaBytes / elapsedSinceSnapshotMs) * 1000);
      const remainingBytes = Math.max(0, snapshot.totalBytes - snapshot.transferredBytes);
      const etaSeconds = speedBytesPerSec > 0
        ? Math.floor(remainingBytes / speedBytesPerSec)
        : undefined;

      const lastStatus = snapshot.lastItem?.status;
      const isImportant = lastStatus === 'retrying' || lastStatus === 'failed';
      const shouldRender =
        snapshot.phase === 'completed' ||
        isImportant ||
        now - state.lastRenderAtMs >= 1500;

      state.lastSnapshotAtMs = now;
      state.lastTransferredBytes = snapshot.transferredBytes;

      if (!shouldRender) {
        return;
      }

      const itemPercent = snapshot.totalItems > 0
        ? Math.floor((snapshot.processedItems / snapshot.totalItems) * 100)
        : 100;
      const bytePercent = snapshot.totalBytes > 0
        ? Math.floor((snapshot.transferredBytes / snapshot.totalBytes) * 100)
        : 100;

      console.log(
        `   ⬆️ items ${snapshot.processedItems}/${snapshot.totalItems} (${itemPercent}%) | bytes ${formatBytes(snapshot.transferredBytes)} / ${formatBytes(snapshot.totalBytes)} (${bytePercent}%) | speed ${formatBytes(speedBytesPerSec)}/s | ETA ${etaSeconds !== undefined ? formatDuration(etaSeconds * 1000) : '—'} | in-flight ${snapshot.inFlightItems}`,
      );

      if (snapshot.lastItem?.status === 'retrying') {
        const fileLabel = path.basename(snapshot.lastItem.key);
        console.log(
          `      ↻ retrying ${fileLabel} (attempt ${snapshot.lastItem.attempt}, waiting ${Math.ceil((snapshot.lastItem.delayMs ?? 0) / 1000)}s): ${snapshot.lastItem.error ?? 'upload error'}`,
        );
      }

      if (snapshot.lastItem?.status === 'failed') {
        const fileLabel = path.basename(snapshot.lastItem.key);
        console.log(`      ❌ failed ${fileLabel}: ${snapshot.lastItem.error ?? 'upload error'}`);
      }

      state.lastRenderAtMs = now;
    },
    complete(): void {
      state.lastRenderAtMs = 0;
      state.lastSnapshotAtMs = 0;
      state.lastTransferredBytes = 0;
    },
  };
}

