import * as dotenv from 'dotenv';
import path from 'node:path';
import { statfs } from 'node:fs/promises';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';
import { watchDownloadsFolder, type WatcherState } from '../src/takeout/watch-downloads.js';
import type { UploadProgressSnapshot } from '../src/takeout/uploader.js';
import { validateScalewayConfig, ScalewayProvider } from '../src/providers/scaleway.js';
import { formatDuration, formatBytes } from '../src/utils/format.js';
import { ensureCaffeinate } from '../src/utils/caffeinate.js';

ensureCaffeinate();

dotenv.config();

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

// ─── CLI args ──────────────────────────────────────────────────────────────

const dryRun = args.includes('--dry-run');
const downloadsDir = readStringArg(args, '--downloads-dir')
  ?? getDefaultDownloadsDir();
const keepDownloads = args.includes('--keep-downloads');
const keepExtracted = args.includes('--keep-extracted');
const maxFailures = readNumberArg(args, '--max-failures');
const concurrency = readNumberArg(args, '--concurrency');
const pollIntervalSec = readNumberArg(args, '--poll-interval') ?? 10;
const pollIntervalMs = Math.max(1, pollIntervalSec) * 1000;
const stabilityThresholdSec = readNumberArg(args, '--stability-threshold') ?? 5;
const stabilityThresholdMs = Math.max(1, stabilityThresholdSec) * 1000;
const progressIntervalSec = readNumberArg(args, '--progress-interval-sec');
const progressIntervalMs = progressIntervalSec !== undefined
  ? Math.max(0.5, progressIntervalSec) * 1000
  : undefined;
const metadataDirArg = readStringArg(args, '--metadata-dir');
const metadataDir = metadataDirArg ? path.resolve(metadataDirArg) : undefined;

if (args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

// ─── Main ──────────────────────────────────────────────────────────────────

const startTime = Date.now();
const uploadProgressTracker = createUploadProgressTracker();

const diskFreeBytes = await getDiskFreeBytes(downloadsDir);

console.log('');
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║          Google Takeout — Continuous Download Watcher         ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('');
console.log('  HOW THIS WORKS:');
console.log('  ─────────────────────────────────────────────────────────────');
console.log('  1. Go to takeout.google.com and start downloading your files');
console.log('  2. Save the .zip/.tgz files to your Downloads folder');
console.log('  3. This watcher will automatically:');
console.log('     • Detect when a download finishes (even from .crdownload)');
console.log('     • Unpack the archive, upload all photos to the cloud');
console.log('     • Delete the archive to free up disk space');
console.log('     • Move on to the next completed download');
console.log('');
console.log('  WHY THIS IS USEFUL:');
console.log('  ─────────────────────────────────────────────────────────────');
console.log('  Your Google Takeout may be 1-2 TB spread across 400+ files.');
console.log('  You don\'t need 2 TB of free space — this processes and deletes');
console.log('  each ~4 GB archive as it arrives, so you only need ~15-20 GB free.');
console.log('');
console.log('  CURRENT SETUP:');
console.log('  ─────────────────────────────────────────────────────────────');
console.log(`  Watching folder:     ${downloadsDir}`);
console.log(`  Disk free space:     ${formatBytes(diskFreeBytes)}`);
console.log(`  Poll interval:       every ${pollIntervalSec}s`);
console.log(`  Upload concurrency:  ${concurrency ?? config.uploadConcurrency} parallel uploads`);
console.log(`  Delete after upload: ${!keepDownloads ? 'yes (frees disk space)' : 'no (archives kept)'}`);
console.log(`  Dry run:             ${dryRun ? 'yes (no actual uploads)' : 'no'}`);
console.log('');

if (diskFreeBytes > 0 && diskFreeBytes < 10 * 1024 * 1024 * 1024) {
  console.log('  ⚠️  LOW DISK SPACE WARNING');
  console.log(`     Only ${formatBytes(diskFreeBytes)} free. Each Takeout part is ~4 GB and needs`);
  console.log('     ~8-12 GB during extraction. Consider freeing space or using a');
  console.log('     different drive with --downloads-dir.');
  console.log('');
}

console.log('  CONTROLS:');
console.log('  ─────────────────────────────────────────────────────────────');
console.log('  Press  P  to pause processing (downloads keep being tracked)');
console.log('  Press  R  to resume processing');
console.log('  Press  Q  or Ctrl+C to stop (safe — no data is lost)');
console.log('  You can restart anytime and it will resume where it left off.');
console.log('');
console.log('  ─────────────────────────────────────────────────────────────');
console.log('  👀 Now watching for downloads... start downloading your Takeout!');
console.log('');

let lastIdleLogAt = 0;
let lastInProgressLogAt = 0;

const watcher = watchDownloadsFolder(config, provider, {
  dryRun,
  maxFailures,
  uploadConcurrency: concurrency,
  progressIntervalMs,
  metadataDir,
  deleteExtractedAfterUpload: !keepExtracted,
  onArchiveStart(name, index, total) {
    const elapsed = formatDuration(Date.now() - startTime);
    console.log(`\n📦 [${index}/${total}] Processing: ${name}  (elapsed: ${elapsed})`);
  },
  onArchiveComplete(name, summary) {
    uploadProgressTracker.finishArchive(name);
    console.log(
      `   ✅ Done: ${summary.uploaded} uploaded, ${summary.skipped} skipped, ${summary.failed} failed`,
    );
  },
  onArchiveError(name, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`   ❌ Failed: ${message}`);
    console.log('   Continuing to next archive...');
  },
  onUploadProgress(name, snapshot) {
    uploadProgressTracker.render(name, snapshot);
  },
}, {
  downloadsDir,
  pollIntervalMs,
  stabilityThresholdMs,
  deleteFromDownloadsAfterUpload: !keepDownloads,

  onArchiveDetected(fileName) {
    const elapsed = formatDuration(Date.now() - startTime);
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────────');
    console.log(`  │ 📥 DOWNLOAD COMPLETE: ${fileName}`);
    console.log(`  │    Moving to processing queue... (session time: ${elapsed})`);
    console.log('  └─────────────────────────────────────────────────────────');
  },

  onDownloadsInProgress(fileNames) {
    const now = Date.now();
    // Only log in-progress downloads every 30 seconds to avoid spam
    if (now - lastInProgressLogAt < 30_000) return;
    lastInProgressLogAt = now;

    console.log(`\n  ⏳ ${fileNames.length} download(s) still in progress:`);
    for (const name of fileNames.slice(0, 5)) {
      // Try to show a friendlier name for .crdownload files
      console.log(`     ⬇️  ${name}`);
    }
    if (fileNames.length > 5) {
      console.log(`     ... and ${fileNames.length - 5} more`);
    }
    console.log('     (These will be processed automatically when they finish)');
  },

  onArchiveProcessed(fileName, result) {
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────────');
    console.log(`  │ ✅ DONE: ${fileName}`);
    console.log(`  │    Photos uploaded:  ${result.totalUploaded}`);
    console.log(`  │    Already in cloud: ${result.totalSkipped} (skipped)`);
    if (result.totalFailed > 0) {
      console.log(`  │    ⚠️  Failed:       ${result.totalFailed} (will retry on next run)`);
    }
    console.log(`  │    Archive deleted to free disk space.`);
    console.log('  └─────────────────────────────────────────────────────────');
  },

  onArchiveProcessingError(fileName, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────────');
    console.log(`  │ ❌ ERROR processing: ${fileName}`);
    console.log(`  │    ${message}`);
    console.log('  │    Skipping this file. Restart the watcher to retry it.');
    console.log('  │    Other downloads will continue processing normally.');
    console.log('  └─────────────────────────────────────────────────────────');
  },

  onPollCycle(watcherState: WatcherState) {
    // Show a running-total after each completed archive
    if (watcherState.isProcessing) return;

    if (watcherState.isPaused) {
      const now = Date.now();
      if (now - lastIdleLogAt < 60_000) return;
      lastIdleLogAt = now;

      const pendingCount = watcherState.pendingArchives.length;
      const dlCount = watcherState.inProgressDownloads.length;
      console.log(`  ⏸️  Paused | ${pendingCount} archive(s) ready | ${dlCount} download(s) in progress | Press R to resume`);
      return;
    }

    if (watcherState.processedCount > 0 && watcherState.pendingArchives.length === 0 && watcherState.inProgressDownloads.length === 0) {
      // Show session summary when idle after processing
      const now = Date.now();
      if (now - lastIdleLogAt < 60_000) return;
      lastIdleLogAt = now;

      const elapsed = formatDuration(Date.now() - startTime);
      console.log('');
      console.log(`  📊 SESSION SO FAR (${elapsed}):`);
      console.log(`     Archives processed: ${watcherState.processedCount}`);
      console.log(`     Photos uploaded:    ${watcherState.totalUploaded}`);
      console.log(`     Disk space freed:   ${formatBytes(watcherState.bytesFreed)}`);
      console.log(`     Disk space free:    ${formatBytes(watcherState.diskFreeBytes)}`);
      if (watcherState.totalFailed > 0) {
        console.log(`     ⚠️  Items failed:   ${watcherState.totalFailed}`);
      }
      console.log('');
      console.log('  👀 Watching for more downloads...');
    } else if (watcherState.pendingArchives.length > 0) {
      console.log(`  📋 ${watcherState.pendingArchives.length} archive(s) ready — processing next...`);
    }
  },

  onIdle() {
    const now = Date.now();
    // Only log idle status every 120 seconds
    if (now - lastIdleLogAt < 120_000) return;
    lastIdleLogAt = now;

    const elapsed = formatDuration(Date.now() - startTime);
    console.log(`  👀 Watching for new archives... (${elapsed} elapsed)`);
  },
});

// ─── Keyboard controls ─────────────────────────────────────────────────────

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    const lower = key.toLowerCase();
    if (lower === 'p' && !watcher.isPaused) {
      watcher.pause();
      console.log('\n  ⏸️  PAUSED — downloads are still being tracked.');
      console.log('  Press R to resume processing, Q to quit.\n');
    } else if (lower === 'r' && watcher.isPaused) {
      watcher.resume();
      console.log('\n  ▶️  RESUMED — processing ready archives again.\n');
    } else if (lower === 'q' || key === '\u0003') {
      // 'q' or Ctrl+C
      console.log('\n\n🛑 Stopping watcher...');
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      watcher.stop();
    }
  });
}

process.on('SIGINT', () => {
  console.log('\n\n🛑 Stopping watcher (Ctrl+C)...');
  watcher.stop();
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Stopping watcher (SIGTERM)...');
  watcher.stop();
});

await watcher.done;

const elapsed = formatDuration(Date.now() - startTime);
console.log('');
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║                     Watcher Stopped                          ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log(`  Total time running: ${elapsed}`);
console.log('');
console.log('  To resume, just run this command again.');
console.log('  Completed archives are remembered — nothing gets re-uploaded.');
console.log('');

// ─── Helpers ───────────────────────────────────────────────────────────────

function readStringArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

function readNumberArg(argv: string[], name: string): number | undefined {
  const value = readStringArg(argv, name);
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function getDefaultDownloadsDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(home, 'Downloads');
}

function printUsage(): void {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║          Google Takeout — Continuous Download Watcher         ║
╚════════════════════════════════════════════════════════════════╝

WHAT THIS DOES:
  Watches your Downloads folder for Google Takeout archive files
  (.zip, .tgz, .tar.gz). When a download finishes, it automatically:
    1. Unpacks the archive
    2. Uploads all photos to your cloud storage
    3. Deletes the archive to free disk space
    4. Waits for the next download

WHY YOU NEED THIS:
  Google Takeout splits your library into 400+ files of ~4 GB each.
  Total: ~1.7 TB. But your hard drive might only have 50-100 GB free.
  This watcher processes files AS they download, so you never run out
  of space. Just start all the downloads in Chrome and walk away.

USAGE:
  npx tsx scripts/takeout-watch.ts [options]

COMMON OPTIONS:
  --downloads-dir <path>      Folder to watch (default: ~/Downloads)
  --poll-interval <seconds>   Check interval (default: 10)
  --concurrency <n>           Parallel uploads (default: 4)
  --dry-run                   Test without uploading
  --help, -h                  Show this help

ADVANCED OPTIONS:
  --input-dir <path>          Takeout work input directory
  --work-dir <path>           Takeout work directory
  --stability-threshold <sec> File size stable time (default: 5)
  --max-failures <n>          Stop archive after N failures
  --keep-downloads            Don't delete archives after processing
  --keep-extracted            Keep unpacked files after upload
  --metadata-dir <path>       Album/sidecar metadata storage
  --progress-interval-sec <n> Upload progress log interval

EXAMPLES:
  # Simplest: watch your default Downloads folder
  npx tsx scripts/takeout-watch.ts

  # Watch a specific folder
  npx tsx scripts/takeout-watch.ts --downloads-dir "D:\\Google Takeout"

  # Faster polling, more upload threads
  npx tsx scripts/takeout-watch.ts --poll-interval 5 --concurrency 8

  # Test run (no uploads, just see what would happen)
  npx tsx scripts/takeout-watch.ts --dry-run
  `);
}

// ─── Upload progress display (reused from takeout-process.ts) ──────────────

async function getDiskFreeBytes(dirPath: string): Promise<number> {
  try {
    const stats = await statfs(dirPath);
    return stats.bfree * stats.bsize;
  } catch {
    return 0;
  }
}

type UploadProgressState = {
  lastRenderAtMs: number;
  lastSnapshotAtMs: number;
  lastTransferredBytes: number;
};

function createUploadProgressTracker() {
  const states = new Map<string, UploadProgressState>();

  return {
    render(archiveName: string, snapshot: UploadProgressSnapshot): void {
      const now = Date.now();
      const state = states.get(archiveName) ?? {
        lastRenderAtMs: 0,
        lastSnapshotAtMs: 0,
        lastTransferredBytes: 0,
      };

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
        states.set(archiveName, state);
        return;
      }

      const itemPercent = snapshot.totalItems > 0
        ? Math.floor((snapshot.processedItems / snapshot.totalItems) * 100)
        : 100;
      const bytePercent = snapshot.totalBytes > 0
        ? Math.floor((snapshot.transferredBytes / snapshot.totalBytes) * 100)
        : 100;

      const itemInfo = `${snapshot.processedItems}/${snapshot.totalItems} (${itemPercent}%)`;
      const byteInfo = `${formatBytes(snapshot.transferredBytes)} / ${formatBytes(snapshot.totalBytes)} (${bytePercent}%)`;
      const speedInfo = `${formatBytes(speedBytesPerSec)}/s`;
      const etaInfo = etaSeconds !== undefined ? formatDuration(etaSeconds * 1000) : '—';

      console.log(
        `   ⬆️ ${archiveName} | items ${itemInfo} | bytes ${byteInfo} | speed ${speedInfo} | ETA ${etaInfo} | in-flight ${snapshot.inFlightItems}`,
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
      states.set(archiveName, state);
    },
    finishArchive(archiveName: string): void {
      states.delete(archiveName);
    },
  };
}
