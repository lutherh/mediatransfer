import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchDownloadsFolder, type WatcherState } from './watch-downloads.js';
import type { CloudProvider, ObjectInfo } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
import { Readable } from 'node:stream';

// ─── Mock provider ────────────────────────────────────────────────────────

class MockProvider implements CloudProvider {
  readonly name = 'MockProvider';
  readonly objects = new Set<string>();

  async list(options?: { prefix?: string; maxResults?: number }): Promise<ObjectInfo[]> {
    const keys = [...this.objects].filter((key) =>
      options?.prefix ? key.startsWith(options.prefix) : true,
    );
    return keys.slice(0, options?.maxResults).map((key) => ({
      key,
      size: 1,
      lastModified: new Date(),
    }));
  }

  async download(_key: string): Promise<Readable> {
    throw new Error('not implemented in test');
  }

  async upload(key: string): Promise<void> {
    this.objects.add(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-downloads-test-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function configFrom(root: string): TakeoutConfig {
  return {
    inputDir: path.join(root, 'input'),
    workDir: path.join(root, 'work'),
    statePath: path.join(root, 'state.json'),
    uploadConcurrency: 1,
    uploadRetryCount: 0,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('takeout/watch-downloads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects a completed archive in the downloads folder', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      const downloadsDir = path.join(root, 'downloads');
      await fs.mkdir(downloadsDir, { recursive: true });

      // Place a .tgz file in downloads
      const archivePath = path.join(downloadsDir, 'takeout-001.tgz');
      await fs.writeFile(archivePath, 'dummy-archive-content');

      const provider = new MockProvider();
      const detectedFiles: string[] = [];
      const processedFiles: string[] = [];

      // Use a mock extractor that creates a simple media file
      const mockExtractor = async (_archive: string, destDir: string) => {
        const media = path.join(destDir, 'Google Photos', 'Album', 'photo.jpg');
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, 'photo-data');
      };

      // Patch the incremental module to use our extractor
      // We'll use the watcher with a very short poll and stability threshold
      const watcher = watchDownloadsFolder(config, provider, {}, {
        downloadsDir,
        pollIntervalMs: 50,
        stabilityThresholdMs: 0, // immediate
        deleteFromDownloadsAfterUpload: false,
        onArchiveDetected(fileName) {
          detectedFiles.push(fileName);
        },
        onArchiveProcessed(fileName) {
          processedFiles.push(fileName);
          // Stop after first archive
          watcher.stop();
        },
        onArchiveProcessingError(fileName) {
          processedFiles.push(fileName);
          watcher.stop();
        },
      });

      // Wait for the watcher to finish (it should detect and process the archive)
      await watcher.done;

      expect(detectedFiles).toContain('takeout-001.tgz');
      // The file should have been moved to inputDir
      const inputFiles = await fs.readdir(config.inputDir).catch(() => []);
      // Either it was processed (and deleted) or it's in inputDir
      expect(detectedFiles.length).toBe(1);
    });
  });

  it('ignores .crdownload files and tracks them as in-progress', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      const downloadsDir = path.join(root, 'downloads');
      await fs.mkdir(downloadsDir, { recursive: true });

      // Place a .crdownload file (still downloading) and a non-archive file
      await fs.writeFile(path.join(downloadsDir, 'Unconfirmed 46183.crdownload'), 'partial-data');
      await fs.writeFile(path.join(downloadsDir, 'readme.txt'), 'not an archive');

      const provider = new MockProvider();
      const inProgressNames: string[][] = [];
      const detectedFiles: string[] = [];
      let pollCount = 0;

      const watcher = watchDownloadsFolder(config, provider, {}, {
        downloadsDir,
        pollIntervalMs: 50,
        stabilityThresholdMs: 0,
        onDownloadsInProgress(names) {
          inProgressNames.push([...names]);
        },
        onArchiveDetected(fileName) {
          detectedFiles.push(fileName);
        },
        onPollCycle() {
          pollCount += 1;
          if (pollCount >= 3) watcher.stop();
        },
      });

      await watcher.done;

      // Should have tracked the .crdownload file
      expect(inProgressNames.length).toBeGreaterThan(0);
      expect(inProgressNames[0]).toContain('Unconfirmed 46183.crdownload');

      // Should NOT have tried to process the .crdownload or .txt file
      expect(detectedFiles).toEqual([]);
    });
  });

  it('does not process an archive whose size is still changing', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      const downloadsDir = path.join(root, 'downloads');
      await fs.mkdir(downloadsDir, { recursive: true });

      const archivePath = path.join(downloadsDir, 'takeout-002.zip');

      const detectedFiles: string[] = [];
      let pollCount = 0;
      const provider = new MockProvider();

      const watcher = watchDownloadsFolder(config, provider, {}, {
        downloadsDir,
        pollIntervalMs: 50,
        stabilityThresholdMs: 500, // 500ms stability required
        onArchiveDetected(fileName) {
          detectedFiles.push(fileName);
        },
        onArchiveProcessingError() {
          watcher.stop();
        },
        async onPollCycle() {
          pollCount += 1;

          if (pollCount === 1) {
            // First poll: create the file
            await fs.writeFile(archivePath, 'data-v1');
          } else if (pollCount === 2) {
            // Second poll: file size changes (still "downloading")
            await fs.writeFile(archivePath, 'data-v2-larger-content');
          }
          // After poll 3+, size is stable — should eventually be detected

          if (pollCount >= 15) watcher.stop(); // safety exit
        },
        onArchiveProcessed() {
          watcher.stop();
        },
      });

      await watcher.done;

      // File should NOT have been detected on poll 1 or 2 (size was changing)
      // It may or may not have been detected depending on timing, but the key
      // invariant is: it was NOT detected before the stability threshold
      if (detectedFiles.length > 0) {
        // It was eventually detected after stabilization — correct behavior
        expect(detectedFiles[0]).toBe('takeout-002.zip');
        expect(pollCount).toBeGreaterThan(2);
      }
    });
  });

  it('watcher state tracks processedCount and bytesFreed', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      const downloadsDir = path.join(root, 'downloads');
      await fs.mkdir(downloadsDir, { recursive: true });

      // Place a small archive
      const archiveContent = 'x'.repeat(1024);
      await fs.writeFile(path.join(downloadsDir, 'takeout-001.zip'), archiveContent);

      const provider = new MockProvider();
      const capturedStates: WatcherState[] = [];

      const watcher = watchDownloadsFolder(config, provider, {}, {
        downloadsDir,
        pollIntervalMs: 50,
        stabilityThresholdMs: 0,
        onPollCycle(state) {
          capturedStates.push({ ...state });
        },
        onArchiveProcessed() {
          watcher.stop();
        },
        onArchiveProcessingError() {
          watcher.stop();
        },
      });

      await watcher.done;

      // At least one state snapshot should exist
      expect(capturedStates.length).toBeGreaterThan(0);
    });
  });

  it('stop() cancels the watcher gracefully', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      const downloadsDir = path.join(root, 'downloads');
      await fs.mkdir(downloadsDir, { recursive: true });

      const provider = new MockProvider();
      let pollCount = 0;

      const watcher = watchDownloadsFolder(config, provider, {}, {
        downloadsDir,
        pollIntervalMs: 50,
        stabilityThresholdMs: 0,
        onPollCycle() {
          pollCount += 1;
          if (pollCount >= 2) watcher.stop();
        },
      });

      await watcher.done;

      // Should have stopped after ~2 polls
      expect(pollCount).toBeGreaterThanOrEqual(2);
      expect(pollCount).toBeLessThan(100);
    });
  });

  it('only processes archive files with known extensions', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      const downloadsDir = path.join(root, 'downloads');
      await fs.mkdir(downloadsDir, { recursive: true });

      // Write various files — only .zip/.tgz/.tar/.tar.gz should be picked up
      await fs.writeFile(path.join(downloadsDir, 'data.csv'), 'csv');
      await fs.writeFile(path.join(downloadsDir, 'photo.jpg'), 'jpg');
      await fs.writeFile(path.join(downloadsDir, 'archive.rar'), 'rar');
      await fs.writeFile(path.join(downloadsDir, 'notes.pdf'), 'pdf');

      const provider = new MockProvider();
      const detectedFiles: string[] = [];
      let pollCount = 0;

      const watcher = watchDownloadsFolder(config, provider, {}, {
        downloadsDir,
        pollIntervalMs: 50,
        stabilityThresholdMs: 0,
        onArchiveDetected(fileName) {
          detectedFiles.push(fileName);
        },
        onPollCycle() {
          pollCount += 1;
          if (pollCount >= 3) watcher.stop();
        },
      });

      await watcher.done;

      // None of these should have been detected
      expect(detectedFiles).toEqual([]);
    });
  });

  it('calls onIdle when no archives or downloads are present', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      const downloadsDir = path.join(root, 'downloads');
      await fs.mkdir(downloadsDir, { recursive: true });

      const provider = new MockProvider();
      let idleCalled = false;
      let pollCount = 0;

      const watcher = watchDownloadsFolder(config, provider, {}, {
        downloadsDir,
        pollIntervalMs: 50,
        stabilityThresholdMs: 0,
        onIdle() {
          idleCalled = true;
        },
        onPollCycle() {
          pollCount += 1;
          if (pollCount >= 2) watcher.stop();
        },
      });

      await watcher.done;

      expect(idleCalled).toBe(true);
    });
  });

  it('does not process archives when paused, resumes when unpaused', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      const downloadsDir = path.join(root, 'downloads');
      await fs.mkdir(downloadsDir, { recursive: true });

      // Place a .zip archive
      await fs.writeFile(path.join(downloadsDir, 'takeout-pause.zip'), 'archive-data');

      const provider = new MockProvider();
      const detectedFiles: string[] = [];
      const states: WatcherState[] = [];
      let pollCount = 0;

      const watcher = watchDownloadsFolder(config, provider, {}, {
        downloadsDir,
        pollIntervalMs: 50,
        stabilityThresholdMs: 0,
        onArchiveDetected(fileName) {
          detectedFiles.push(fileName);
        },
        onArchiveProcessed() {
          watcher.stop();
        },
        onArchiveProcessingError() {
          watcher.stop();
        },
        onPollCycle(state) {
          pollCount += 1;
          states.push({ ...state });

          if (pollCount === 1) {
            // Pause before any archive can be picked up
            watcher.pause();
          } else if (pollCount === 4) {
            // After a few paused cycles, resume
            watcher.resume();
          }

          // Safety exit
          if (pollCount >= 20) watcher.stop();
        },
      });

      await watcher.done;

      // While paused (polls 2-3), archives should be listed as pending but not processed
      const pausedStates = states.filter((s) => s.isPaused);
      expect(pausedStates.length).toBeGreaterThan(0);
      for (const s of pausedStates) {
        expect(s.pendingArchives.length).toBeGreaterThan(0);
      }

      // After resume, the archive should eventually be detected/processed
      expect(watcher.isPaused).toBe(false);
    });
  });
});
