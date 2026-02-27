import * as dotenv from 'dotenv';
import path from 'node:path';
import { loadTakeoutConfig } from '../src/takeout/config.js';
import { runTakeoutUpload } from '../src/takeout/runner.js';
import type { UploadProgressSnapshot } from '../src/takeout/uploader.js';
import { validateScalewayConfig, ScalewayProvider } from '../src/providers/scaleway.js';

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
const maxFailures = readNumberArg(args, '--max-failures');
const includeFilter = readStringArg(args, '--include');
const excludeFilter = readStringArg(args, '--exclude');
const progressIntervalSec = readNumberArg(args, '--progress-interval-sec');
const progressIntervalMs = progressIntervalSec !== undefined
  ? Math.max(0.5, progressIntervalSec) * 1000
  : undefined;

const progressTracker = createUploadProgressTracker();

console.log('⬆️ Uploading Takeout manifest to Scaleway...');
const { summary, reportJsonPath, reportCsvPath } = await runTakeoutUpload(
  config,
  provider,
  undefined,
  {
    dryRun,
    maxFailures,
    includeFilter,
    excludeFilter,
    progressIntervalMs,
    onUploadProgress(snapshot) {
      progressTracker.render(snapshot);
    },
  },
);
progressTracker.complete();
console.log('✅ Upload finished');
console.log(`   Total: ${summary.total}`);
console.log(`   Processed: ${summary.processed}`);
console.log(`   Uploaded: ${summary.uploaded}`);
console.log(`   Skipped: ${summary.skipped}`);
console.log(`   Failed: ${summary.failed}`);
console.log(`   Dry run: ${summary.dryRun}`);
console.log(`   Stopped early: ${summary.stoppedEarly}`);
console.log(`   Report JSON: ${reportJsonPath}`);
console.log(`   Report CSV: ${reportCsvPath}`);

if (summary.failureLimitReached) {
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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60_000) % 60;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex >= 2 ? 1 : 0)} ${units[unitIndex]}`;
}
