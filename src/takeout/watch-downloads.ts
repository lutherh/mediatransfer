import path from 'node:path';
import fs from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import type { CloudProvider } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
import { isCrossDeviceError } from '../utils/errors.js';
import {
  runTakeoutIncremental,
  type IncrementalOptions,
  type IncrementalResult,
} from './incremental.js';

// ─── Types ─────────────────────────────────────────────────────────────────

const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz'] as const;
const CRDOWNLOAD_EXT = '.crdownload';

export type WatchDownloadsOptions = {
  /** Directory to watch for incoming archive downloads (e.g. user's Downloads folder). */
  downloadsDir: string;
  /** Polling interval in milliseconds (default: 10_000 = 10 seconds). */
  pollIntervalMs?: number;
  /**
   * How long a file's size must remain stable before considering it complete (ms).
   * This prevents processing a file that is still being written/moved. Default: 5_000.
   */
  stabilityThresholdMs?: number;
  /** If true, delete the archive from the downloads folder after successful processing. */
  deleteFromDownloadsAfterUpload?: boolean;
  /** Called when a new complete archive is detected. */
  onArchiveDetected?: (fileName: string) => void;
  /** Called with in-progress .crdownload file names each poll cycle. */
  onDownloadsInProgress?: (fileNames: string[]) => void;
  /** Called when processing of an archive finishes (success or failure). */
  onArchiveProcessed?: (fileName: string, result: IncrementalResult) => void;
  /** Called when an error occurs during processing of an archive. */
  onArchiveProcessingError?: (fileName: string, error: unknown) => void;
  /** Called each poll cycle with the current watcher state. */
  onPollCycle?: (state: WatcherState) => void;
  /** Called when the watcher is idle (no archives to process, no downloads in progress). */
  onIdle?: () => void;
};

export type WatcherState = {
  /** Archives currently waiting to be processed (already moved to inputDir). */
  pendingArchives: string[];
  /** .crdownload files currently being tracked (still downloading). */
  inProgressDownloads: string[];
  /** How many archives have been processed so far this session. */
  processedCount: number;
  /** Total files uploaded across all archives this session. */
  totalUploaded: number;
  /** Total files that failed across all archives this session. */
  totalFailed: number;
  /** Whether the watcher is currently processing an archive. */
  isProcessing: boolean;
  /** Whether processing is paused (polling still continues). */
  isPaused: boolean;
  /** Cumulative bytes freed by processing + deleting archives this session. */
  bytesFreed: number;
  /** Size of the archive currently being processed (bytes). */
  currentArchiveSizeBytes: number;
  /** Free disk space on the downloads directory drive (bytes), updated each poll. */
  diskFreeBytes: number;
};

// ─── File-size stability tracker ───────────────────────────────────────────

type FileSizeRecord = {
  size: number;
  stableSince: number; // timestamp when this size was first observed
};

/**
 * Tracks file sizes across poll cycles. A file is considered "stable" when its
 * size has not changed for at least `stabilityThresholdMs`.
 */
class FileSizeTracker {
  private readonly records = new Map<string, FileSizeRecord>();

  constructor(private readonly stabilityThresholdMs: number) {}

  /** Update a file's recorded size. Returns true if file is stable. */
  update(fileName: string, currentSize: number): boolean {
    const now = Date.now();
    const existing = this.records.get(fileName);

    if (!existing || existing.size !== currentSize) {
      // Size changed (or first time seen) — reset stability timer
      this.records.set(fileName, { size: currentSize, stableSince: now });
      return false;
    }

    // Size unchanged — check if stable long enough
    return now - existing.stableSince >= this.stabilityThresholdMs;
  }

  /** Remove tracking for a file (e.g. after it was moved/processed). */
  remove(fileName: string): void {
    this.records.delete(fileName);
  }

  /** Remove entries for files that no longer exist on disk. */
  pruneAbsent(existingFileNames: Set<string>): void {
    for (const key of this.records.keys()) {
      if (!existingFileNames.has(key)) {
        this.records.delete(key);
      }
    }
  }
}

// ─── Core watcher ──────────────────────────────────────────────────────────

/**
 * Continuously watches the downloads directory for completed Google Takeout
 * archive files. When one is detected (stable file size, not a .crdownload),
 * it is moved to the takeout inputDir and processed through the existing
 * incremental pipeline — one archive at a time.
 *
 * This enables processing 1.7 TB+ takeout exports on a machine with e.g. 
 * only 50 GB free: the user starts downloading all 432 parts in Chrome,
 * and the watcher picks them up as they finish, processes them, deletes
 * the source archive, and frees disk space for the next download.
 *
 * Returns a handle to stop, pause, or resume watching.
 */
export type WatcherHandle = {
  /** Stop watching permanently. The `done` promise resolves once the loop exits. */
  stop: () => void;
  /** Pause processing — polling continues (downloads are still tracked) but no archives are picked up. */
  pause: () => void;
  /** Resume processing after a pause. */
  resume: () => void;
  /** Whether the watcher is currently paused. */
  readonly isPaused: boolean;
  /** Resolves when the watcher loop exits (after `stop()` is called). */
  done: Promise<void>;
};

export function watchDownloadsFolder(
  config: TakeoutConfig,
  provider: CloudProvider,
  incrementalOptions: IncrementalOptions,
  watchOptions: WatchDownloadsOptions,
): WatcherHandle {
  const pollIntervalMs = watchOptions.pollIntervalMs ?? 10_000;
  const stabilityThresholdMs = watchOptions.stabilityThresholdMs ?? 5_000;
  const tracker = new FileSizeTracker(stabilityThresholdMs);
  const processedFiles = new Set<string>();

  let stopped = false;
  let paused = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const state: WatcherState = {
    pendingArchives: [],
    inProgressDownloads: [],
    processedCount: 0,
    totalUploaded: 0,
    totalFailed: 0,
    isProcessing: false,
    isPaused: false,
    bytesFreed: 0,
    currentArchiveSizeBytes: 0,
    diskFreeBytes: 0,
  };

  const done = runWatchLoop();

  const handle: WatcherHandle = {
    stop() {
      stopped = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    get isPaused() {
      return paused;
    },
    done,
  };

  return handle;

  // ── Main loop ────────────────────────────────────────

  async function runWatchLoop(): Promise<void> {
    // Ensure directories exist
    await fs.mkdir(watchOptions.downloadsDir, { recursive: true });
    await fs.mkdir(config.inputDir, { recursive: true });

    while (!stopped) {
      try {
        await pollCycle();
      } catch (error) {
        // Log but don't crash the watcher for transient errors
        console.error('[watch] Poll cycle error:', error instanceof Error ? error.message : error);
      }

      if (stopped) break;
      await sleep(pollIntervalMs);
    }
  }

  async function pollCycle(): Promise<void> {
    // Update disk free space
    state.diskFreeBytes = await getDiskFreeBytes(watchOptions.downloadsDir);

    const dirEntries = await fs.readdir(watchOptions.downloadsDir, { withFileTypes: true });
    const files = dirEntries.filter((e) => e.isFile());

    // Separate .crdownload files from completed archives
    const crDownloads: string[] = [];
    const readyArchives: string[] = [];
    const allFileNames = new Set<string>();

    for (const file of files) {
      allFileNames.add(file.name);
      const lower = file.name.toLowerCase();

      if (lower.endsWith(CRDOWNLOAD_EXT)) {
        crDownloads.push(file.name);
        continue;
      }

      if (!isArchiveFile(lower)) continue;
      if (processedFiles.has(file.name)) continue;

      // Check file size stability
      const filePath = path.join(watchOptions.downloadsDir, file.name);
      const stats = await fs.stat(filePath).catch(() => null);
      if (!stats || stats.size === 0) continue;

      const isStable = tracker.update(file.name, stats.size);
      if (isStable) {
        readyArchives.push(file.name);
      }
    }

    // Prune tracker for files that disappeared (downloaded, renamed, etc.)
    tracker.pruneAbsent(allFileNames);

    // Update state
    state.inProgressDownloads = crDownloads;
    state.pendingArchives = readyArchives;
    state.isPaused = paused;

    watchOptions.onPollCycle?.(state);

    if (crDownloads.length > 0) {
      watchOptions.onDownloadsInProgress?.(crDownloads);
    }

    // Process ready archives one at a time (oldest first by name)
    readyArchives.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (readyArchives.length > 0 && !paused) {
      // Process only one archive per cycle to keep disk usage bounded
      const archiveName = readyArchives[0];
      await processOneArchive(archiveName);
    } else if (crDownloads.length === 0 && readyArchives.length === 0) {
      watchOptions.onIdle?.();
    }
  }

  async function processOneArchive(archiveName: string): Promise<void> {
    const sourcePath = path.join(watchOptions.downloadsDir, archiveName);
    const destPath = path.join(config.inputDir, archiveName);

    // Record archive size before moving (used for bytesFreed tracking)
    const archiveSize = await getFileSizeOrZero(sourcePath);
    state.currentArchiveSizeBytes = archiveSize;

    watchOptions.onArchiveDetected?.(archiveName);

    state.isProcessing = true;

    try {
      // Move archive from downloads to inputDir for processing
      // Use copy+delete to handle cross-drive moves (Downloads on C:, work on D:)
      await moveFileSafe(sourcePath, destPath);
      tracker.remove(archiveName);

      // Run the incremental pipeline — it will pick up this archive
      const result = await runTakeoutIncremental(config, provider, {
        ...incrementalOptions,
        // Always delete the archive from inputDir after successful upload
        // to free disk space for the next download
        deleteArchiveAfterUpload: true,
      });

      processedFiles.add(archiveName);
      state.processedCount += 1;
      state.totalUploaded += result.totalUploaded;
      state.totalFailed += result.totalFailed;
      state.bytesFreed += archiveSize;
      state.currentArchiveSizeBytes = 0;
      state.isProcessing = false;

      watchOptions.onArchiveProcessed?.(archiveName, result);

      // Optionally delete from downloads dir (if it's still there and wasn't moved)
      if (watchOptions.deleteFromDownloadsAfterUpload) {
        await fs.unlink(sourcePath).catch(() => {});
      }
    } catch (error) {
      state.isProcessing = false;
      watchOptions.onArchiveProcessingError?.(archiveName, error);

      // Mark as processed to avoid retrying the same broken file endlessly.
      // User can restart the watcher to retry.
      processedFiles.add(archiveName);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      timeoutHandle = setTimeout(resolve, ms);
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isArchiveFile(lowerName: string): boolean {
  return ARCHIVE_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

/**
 * Move a file from source to destination, handling cross-device moves
 * (e.g. Downloads on C: → work dir on D:) by falling back to copy+delete.
 */
async function moveFileSafe(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });

  try {
    await fs.rename(source, destination);
  } catch (error) {
    // Cross-device rename not supported — copy then delete
    if (isCrossDeviceError(error)) {
      await fs.copyFile(source, destination);
      await fs.unlink(source);
    } else {
      throw error;
    }
  }
}

async function getDiskFreeBytes(dirPath: string): Promise<number> {
  try {
    const stats = await statfs(dirPath);
    return stats.bfree * stats.bsize;
  } catch {
    return 0;
  }
}

async function getFileSizeOrZero(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}
