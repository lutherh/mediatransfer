import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import type { CloudProvider, ObjectInfo } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
import { runTakeoutIncremental, loadArchiveState, reconcileArchiveEntries } from './incremental.js';
import { loadArchiveMetadata } from './archive-metadata.js';
import { requestPause, isPauseRequested } from './pause-flag.js';

class MockProvider implements CloudProvider {
  readonly name = 'MockProvider';
  readonly objects = new Set<string>();
  readonly uploadAttempts = new Map<string, number>();
  failUploadsRemaining = 0;

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
    const attempts = (this.uploadAttempts.get(key) ?? 0) + 1;
    this.uploadAttempts.set(key, attempts);

    if (this.failUploadsRemaining > 0) {
      this.failUploadsRemaining -= 1;
      throw new Error('forced upload failure');
    }

    this.objects.add(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mediatransfer-incremental-'));
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

describe('takeout/incremental', () => {
  it('marks archive failed when item upload fails and retries on next run', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      await fs.mkdir(config.inputDir, { recursive: true });

      const archivePath = path.join(config.inputDir, 'takeout-001.zip');
      await fs.writeFile(archivePath, 'dummy');

      const provider = new MockProvider();
      provider.failUploadsRemaining = 1;

      let extractCounter = 0;
      const extractor = async (_archive: string, destinationDir: string) => {
        extractCounter += 1;
        const media = path.join(destinationDir, 'Google Photos', `Album${extractCounter}`, 'IMG_1.jpg');
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, 'img');
      };

      const first = await runTakeoutIncremental(config, provider, {}, extractor);
      expect(first.failedArchives).toBe(1);

      const archiveStatePath = path.join(config.workDir, 'archive-state.json');
      const stateAfterFirst = await loadArchiveState(archiveStatePath);
      expect(stateAfterFirst.archives['takeout-001.zip']?.status).toBe('failed');

      const second = await runTakeoutIncremental(config, provider, {}, extractor);
      expect(second.processedArchives).toBe(1);

      const stateAfterSecond = await loadArchiveState(archiveStatePath);
      expect(stateAfterSecond.archives['takeout-001.zip']?.status).toBe('completed');
    });
  });

  it('cleans extraction folder before processing next archive', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      await fs.mkdir(config.inputDir, { recursive: true });

      await fs.writeFile(path.join(config.inputDir, 'takeout-001.zip'), 'dummy');
      await fs.writeFile(path.join(config.inputDir, 'takeout-002.zip'), 'dummy');

      const provider = new MockProvider();

      const extractor = async (archivePath: string, destinationDir: string) => {
        const staleFile = path.join(destinationDir, 'stale.txt');
        const staleExists = await fs.access(staleFile).then(() => true).catch(() => false);
        if (path.basename(archivePath) === 'takeout-002.zip') {
          expect(staleExists).toBe(false);
        }

        await fs.writeFile(staleFile, 'stale');
        const media = path.join(destinationDir, 'Google Photos', 'Album', `${path.basename(archivePath)}.jpg`);
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, 'img');
      };

      const result = await runTakeoutIncremental(config, provider, {}, extractor);
      expect(result.processedArchives).toBe(2);
      expect(result.failedArchives).toBe(0);
    });
  });

  it('moves completed archive to uploaded-archives directory when enabled', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      await fs.mkdir(config.inputDir, { recursive: true });

      const archivePath = path.join(config.inputDir, 'takeout-001.tgz');
      await fs.writeFile(archivePath, 'dummy');

      const provider = new MockProvider();

      const extractor = async (_archivePath: string, destinationDir: string) => {
        const media = path.join(destinationDir, 'Google Photos', 'Album', 'IMG_1.jpg');
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, 'img');
      };

      const result = await runTakeoutIncremental(
        config,
        provider,
        { moveArchiveAfterUpload: true },
        extractor,
      );

      expect(result.processedArchives).toBe(1);
      await expect(fs.access(archivePath)).rejects.toBeDefined();
      await fs.access(path.join(config.inputDir, 'uploaded-archives', 'takeout-001.tgz'));
      const content = await fs.readFile(path.join(config.inputDir, 'uploaded-archives', 'takeout-001.tgz'), 'utf-8');
      expect(content).toBe('dummy');

      const archiveState = await loadArchiveState(path.join(config.workDir, 'archive-state.json'));
      const record = archiveState.archives['takeout-001.tgz'];
      expect(record.archiveSizeBytes).toBe(5);
      expect(record.mediaBytes).toBe(3);
    });
  });

  it('adds numeric suffix when moving archive and destination name already exists', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      await fs.mkdir(config.inputDir, { recursive: true });

      const archivePath = path.join(config.inputDir, 'takeout-001.tgz');
      await fs.writeFile(archivePath, 'dummy');

      const completedDir = path.join(config.inputDir, 'uploaded-archives');
      await fs.mkdir(completedDir, { recursive: true });
      await fs.writeFile(path.join(completedDir, 'takeout-001.tgz'), 'existing');

      const provider = new MockProvider();

      const extractor = async (_archivePath: string, destinationDir: string) => {
        const media = path.join(destinationDir, 'Google Photos', 'Album', 'IMG_1.jpg');
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, 'img');
      };

      const result = await runTakeoutIncremental(
        config,
        provider,
        { moveArchiveAfterUpload: true, completedArchiveDir: completedDir },
        extractor,
      );

      expect(result.processedArchives).toBe(1);
      await fs.access(path.join(completedDir, 'takeout-001.tgz'));
      await fs.access(path.join(completedDir, 'takeout-001-1.tgz'));
    });
  });

  it('persists archive metadata JSON while still cleaning extracted files', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      await fs.mkdir(config.inputDir, { recursive: true });

      const archivePath = path.join(config.inputDir, 'takeout-001.tgz');
      await fs.writeFile(archivePath, 'dummy');

      const provider = new MockProvider();

      const extractor = async (_archivePath: string, destinationDir: string) => {
        const album1 = path.join(destinationDir, 'Google Photos', 'Trip');
        const album2 = path.join(destinationDir, 'Google Photos', 'Family');
        await fs.mkdir(album1, { recursive: true });
        await fs.mkdir(album2, { recursive: true });

        const img1 = path.join(album1, 'IMG_1.jpg');
        const img2 = path.join(album2, 'IMG_2.jpg');

        await fs.writeFile(img1, 'same-content');
        await fs.writeFile(img2, 'same-content');

        await fs.writeFile(
          `${img1}.json`,
          JSON.stringify({
            title: 'Trip shot',
            photoTakenTime: { timestamp: '1765584000' },
            people: [{ name: 'Alice' }],
          }),
        );
      };

      const result = await runTakeoutIncremental(config, provider, {}, extractor);

      expect(result.processedArchives).toBe(1);

      // Extracted temp files should be cleaned up
      await expect(fs.access(path.join(config.workDir, 'temp-extract'))).rejects.toBeDefined();

      // Metadata should still exist after cleanup
      const metadata = await loadArchiveMetadata(path.join(config.workDir, 'metadata'), 'takeout-001.tgz');
      expect(metadata).toBeDefined();
      expect(metadata?.items.length).toBe(2);
      expect(Object.keys(metadata?.albums ?? {})).toEqual(expect.arrayContaining(['Trip', 'Family']));
      expect(metadata?.duplicates.length).toBe(1);
      expect(metadata?.duplicates[0].items.length).toBe(2);
    });
  });

  it('continues upload when metadata directory is invalid', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      await fs.mkdir(config.inputDir, { recursive: true });

      const archivePath = path.join(config.inputDir, 'takeout-001.tgz');
      await fs.writeFile(archivePath, 'dummy');

      const provider = new MockProvider();

      const extractor = async (_archivePath: string, destinationDir: string) => {
        const media = path.join(destinationDir, 'Google Photos', 'Album', 'IMG_1.jpg');
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, 'img');
      };

      // Point metadataDir at an existing file so mkdir(metadataDir) fails.
      const invalidMetadataPath = path.join(root, 'metadata-as-file');
      await fs.writeFile(invalidMetadataPath, 'not-a-directory');

      const result = await runTakeoutIncremental(
        config,
        provider,
        { metadataDir: invalidMetadataPath },
        extractor,
      );

      expect(result.processedArchives).toBe(1);
      expect(result.failedArchives).toBe(0);
    });
  });
});

describe('reconcileArchiveEntries', () => {
  it('drops extracting archives with 0 entries from state', () => {
    const { archives, reconciled } = reconcileArchiveEntries({
      'takeout-001.tgz': {
        status: 'extracting',
        entryCount: 0,
        uploadedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        archiveSizeBytes: 4_000_000_000,
        startedAt: '2026-03-01T00:00:00Z',
      },
    });
    expect(reconciled).toBe(1);
    expect(archives['takeout-001.tgz']).toBeUndefined();
  });

  it('drops pending archives with 0 entries from state', () => {
    const { archives, reconciled } = reconcileArchiveEntries({
      'takeout-002.tgz': {
        status: 'pending',
        entryCount: 0,
        uploadedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        archiveSizeBytes: 50_000_000_000,
        startedAt: '2026-03-01T00:00:00Z',
      },
    });
    expect(reconciled).toBe(1);
    expect(archives['takeout-002.tgz']).toBeUndefined();
  });

  it('marks pending archives with entries as failed for retry', () => {
    const { archives, reconciled } = reconcileArchiveEntries({
      'takeout-003.tgz': {
        status: 'pending',
        entryCount: 150,
        uploadedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        archiveSizeBytes: 4_000_000_000,
        startedAt: '2026-03-01T00:00:00Z',
      },
    });
    expect(reconciled).toBe(1);
    expect(archives['takeout-003.tgz']?.status).toBe('failed');
    expect(archives['takeout-003.tgz']?.entryCount).toBe(150);
  });

  it('marks interrupted uploading archives as failed', () => {
    const { archives, reconciled } = reconcileArchiveEntries({
      'takeout-004.tgz': {
        status: 'uploading',
        entryCount: 200,
        uploadedCount: 50,
        skippedCount: 0,
        failedCount: 0,
        archiveSizeBytes: 4_000_000_000,
        startedAt: '2026-03-01T00:00:00Z',
      },
    });
    expect(reconciled).toBe(1);
    expect(archives['takeout-004.tgz']?.status).toBe('failed');
    expect(archives['takeout-004.tgz']?.error).toContain('upload');
  });

  it('marks uploading archive as completed when all items were handled', () => {
    const { archives, reconciled } = reconcileArchiveEntries({
      'takeout-005.tgz': {
        status: 'uploading',
        entryCount: 100,
        uploadedCount: 90,
        skippedCount: 10,
        failedCount: 0,
        archiveSizeBytes: 4_000_000_000,
        startedAt: '2026-03-01T00:00:00Z',
      },
    });
    expect(reconciled).toBe(1);
    expect(archives['takeout-005.tgz']?.status).toBe('completed');
  });

  it('does not touch already-completed archives', () => {
    const { archives, reconciled } = reconcileArchiveEntries({
      'takeout-006.tgz': {
        status: 'completed',
        entryCount: 300,
        uploadedCount: 300,
        skippedCount: 0,
        failedCount: 0,
        archiveSizeBytes: 4_000_000_000,
        startedAt: '2026-03-01T00:00:00Z',
        completedAt: '2026-03-01T01:00:00Z',
      },
    });
    expect(reconciled).toBe(0);
    expect(archives['takeout-006.tgz']?.status).toBe('completed');
  });

  it('does not touch already-failed archives', () => {
    const { archives, reconciled } = reconcileArchiveEntries({
      'takeout-007.tgz': {
        status: 'failed',
        entryCount: 10,
        uploadedCount: 5,
        skippedCount: 0,
        failedCount: 5,
        archiveSizeBytes: 4_000_000_000,
        startedAt: '2026-03-01T00:00:00Z',
        error: 'upload failure',
      },
    });
    expect(reconciled).toBe(0);
    expect(archives['takeout-007.tgz']?.status).toBe('failed');
  });

  it('handles mixed archive states correctly', () => {
    const { archives, reconciled } = reconcileArchiveEntries({
      'completed.tgz': {
        status: 'completed',
        entryCount: 100,
        uploadedCount: 100,
        skippedCount: 0,
        failedCount: 0,
      },
      'unprocessed.tgz': {
        status: 'extracting',
        entryCount: 0,
        uploadedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        archiveSizeBytes: 4_000_000_000,
      },
      'partial-upload.tgz': {
        status: 'uploading',
        entryCount: 200,
        uploadedCount: 50,
        skippedCount: 0,
        failedCount: 0,
      },
      'fully-uploaded.tgz': {
        status: 'uploading',
        entryCount: 80,
        uploadedCount: 80,
        skippedCount: 0,
        failedCount: 0,
      },
      'all-skipped-uploading.tgz': {
        status: 'uploading',
        entryCount: 100,
        uploadedCount: 0,
        skippedCount: 100,
        failedCount: 0,
      },
      'failed-but-all-handled.tgz': {
        status: 'failed',
        entryCount: 591,
        uploadedCount: 0,
        skippedCount: 591,
        failedCount: 0,
        error: 'ENOENT: no such file or directory, mkdir \'\\\\?\'',
      },
      'failed-with-real-failures.tgz': {
        status: 'failed',
        entryCount: 200,
        uploadedCount: 190,
        skippedCount: 5,
        failedCount: 5,
        error: '5 item(s) failed in archive upload',
      },
    });

    expect(reconciled).toBe(5);
    expect(archives['completed.tgz']?.status).toBe('completed');
    expect(archives['unprocessed.tgz']).toBeUndefined();
    expect(archives['partial-upload.tgz']?.status).toBe('failed');
    expect(archives['fully-uploaded.tgz']?.status).toBe('completed');
    expect(archives['all-skipped-uploading.tgz']?.status).toBe('completed');
    expect(archives['failed-but-all-handled.tgz']?.status).toBe('completed');
    expect(archives['failed-but-all-handled.tgz']?.error).toBeUndefined();
    expect(archives['failed-with-real-failures.tgz']?.status).toBe('failed');
  });
});

describe('post-upload error does not overwrite completed status', () => {
  it('keeps completed status when moveArchive fails after successful upload', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      await fs.mkdir(config.inputDir, { recursive: true });

      const archivePath = path.join(config.inputDir, 'takeout-move-fail.zip');
      await fs.writeFile(archivePath, 'dummy');

      const provider = new MockProvider();

      const extractor = async (_archive: string, destinationDir: string) => {
        const media = path.join(destinationDir, 'Google Photos', 'Album', 'IMG_1.jpg');
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, 'img-content');
      };

      // Use moveArchiveAfterUpload with an invalid completedArchiveDir to trigger error
      const result = await runTakeoutIncremental(config, provider, {
        moveArchiveAfterUpload: true,
        completedArchiveDir: path.join(root, 'non', 'existent', '\0invalid'),
      }, extractor);

      // The upload itself succeeded — data is in the provider
      expect(provider.objects.size).toBe(1);

      // Archive status must remain 'completed' despite the post-upload error
      const archiveStatePath = path.join(config.workDir, 'archive-state.json');
      const archiveState = await loadArchiveState(archiveStatePath);
      const record = archiveState.archives['takeout-move-fail.zip'];
      expect(record).toBeDefined();
      expect(record.status).toBe('completed');
      expect(record.failedCount).toBe(0);
      expect(record.uploadedCount).toBe(1);

      // Should count as processed, not failed
      expect(result.processedArchives).toBe(1);
      expect(result.failedArchives).toBe(0);
    });
  });
});

describe('skipReasons propagation to archive-state', () => {
  it('stores skipReasons in archive-state when S3 duplicates are detected', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      await fs.mkdir(config.inputDir, { recursive: true });

      const archivePath = path.join(config.inputDir, 'takeout-dup.zip');
      await fs.writeFile(archivePath, 'dummy');

      const provider = new MockProvider();

      const extractor = async (_archive: string, destinationDir: string) => {
        const media = path.join(destinationDir, 'Google Photos', 'Album', 'IMG_1.jpg');
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, 'img-content');
      };

      // First run: upload succeeds
      const firstResult = await runTakeoutIncremental(config, provider, {}, extractor);
      expect(firstResult.totalUploaded).toBe(1);

      // Reset archive state AND global upload state to force re-processing
      // while keeping S3 objects intact — this simulates starting fresh with
      // files already present in the destination bucket.
      const archiveStatePath = path.join(config.workDir, 'archive-state.json');
      await fs.unlink(archiveStatePath);
      await fs.unlink(config.statePath).catch(() => {});
      // Also clean up the manifest so the incremental flow rebuilds it
      await fs.unlink(path.join(config.workDir, 'manifest.jsonl')).catch(() => {});

      // Re-create archive so it gets picked up again
      await fs.writeFile(archivePath, 'dummy');

      // Second run: entry already exists in S3 from first run
      const secondResult = await runTakeoutIncremental(config, provider, {}, extractor);
      expect(secondResult.totalSkipped).toBeGreaterThanOrEqual(1);

      const archiveState = await loadArchiveState(archiveStatePath);
      const record = archiveState.archives['takeout-dup.zip'];
      expect(record).toBeDefined();
      expect(record.status).toBe('completed');
      expect(record.skipReasons).toBeDefined();
      expect(record.skipReasons?.already_exists_in_destination).toBeGreaterThanOrEqual(1);
    });
  });

  it('stores zero-count skipReasons when no duplicates exist', async () => {
    await withTempDir(async (root) => {
      const config = configFrom(root);
      await fs.mkdir(config.inputDir, { recursive: true });

      const archivePath = path.join(config.inputDir, 'takeout-clean.zip');
      await fs.writeFile(archivePath, 'dummy');

      const provider = new MockProvider();

      const extractor = async (_archive: string, destinationDir: string) => {
        const media = path.join(destinationDir, 'Google Photos', 'Album', 'IMG_1.jpg');
        await fs.mkdir(path.dirname(media), { recursive: true });
        await fs.writeFile(media, 'img-content');
      };

      const result = await runTakeoutIncremental(config, provider, {}, extractor);
      expect(result.totalUploaded).toBe(1);

      const archiveStatePath = path.join(config.workDir, 'archive-state.json');
      const archiveState = await loadArchiveState(archiveStatePath);
      const record = archiveState.archives['takeout-clean.zip'];
      expect(record).toBeDefined();
      expect(record.skipReasons).toBeDefined();
      expect(record.skipReasons?.already_exists_in_destination).toBe(0);
      expect(record.skipReasons?.already_uploaded_in_state).toBe(0);
      expect(record.skipReasons?.already_skipped_in_state).toBe(0);
    });
  });

  describe('graceful pause flag', () => {
    it('stops at the next archive boundary when pause flag is set, leaving remaining archives pending', async () => {
      await withTempDir(async (root) => {
        const config = configFrom(root);
        await fs.mkdir(config.inputDir, { recursive: true });
        await fs.mkdir(config.workDir, { recursive: true });

        // Three archives queued.
        for (const name of ['takeout-001.zip', 'takeout-002.zip', 'takeout-003.zip']) {
          await fs.writeFile(path.join(config.inputDir, name), 'dummy');
        }

        const provider = new MockProvider();
        let extractCount = 0;
        const extractor = async (archivePath: string, destinationDir: string) => {
          extractCount += 1;
          // Set the pause flag *during* the first archive's extraction so the
          // loop sees it before iteration 2.
          if (extractCount === 1) {
            await requestPause(config.workDir, 'unit-test');
          }
          const media = path.join(
            destinationDir,
            'Google Photos',
            'Album',
            `${path.basename(archivePath)}.jpg`,
          );
          await fs.mkdir(path.dirname(media), { recursive: true });
          await fs.writeFile(media, 'img');
        };

        let pauseCallbackArg: number | undefined;
        const result = await runTakeoutIncremental(
          config,
          provider,
          { onPaused: (remaining) => { pauseCallbackArg = remaining; } },
          extractor,
        );

        // First archive completed; loop exited before extracting #2 and #3.
        expect(result.paused).toBe(true);
        expect(result.remainingAfterPause).toBe(2);
        expect(pauseCallbackArg).toBe(2);
        expect(extractCount).toBe(1);

        const state = await loadArchiveState(path.join(config.workDir, 'archive-state.json'));
        expect(state.archives['takeout-001.zip']?.status).toBe('completed');
        expect(state.archives['takeout-002.zip']).toBeUndefined();
        expect(state.archives['takeout-003.zip']).toBeUndefined();

        // Pause flag persists \u2014 the CLI script (not the library) decides
        // when to clear it. This guarantees the next run can detect that the
        // previous exit was a graceful pause if it inspects the flag.
        expect(await isPauseRequested(config.workDir)).toBe(true);
      });
    });

    it('resumes pending archives when pause flag is cleared and run is invoked again', async () => {
      await withTempDir(async (root) => {
        const config = configFrom(root);
        await fs.mkdir(config.inputDir, { recursive: true });
        await fs.mkdir(config.workDir, { recursive: true });

        for (const name of ['takeout-001.zip', 'takeout-002.zip']) {
          await fs.writeFile(path.join(config.inputDir, name), 'dummy');
        }

        const provider = new MockProvider();
        let firstRunExtracts = 0;
        const firstExtractor = async (archivePath: string, destinationDir: string) => {
          firstRunExtracts += 1;
          if (firstRunExtracts === 1) {
            await requestPause(config.workDir);
          }
          const media = path.join(destinationDir, 'Google Photos', 'Album', `${path.basename(archivePath)}.jpg`);
          await fs.mkdir(path.dirname(media), { recursive: true });
          await fs.writeFile(media, 'img');
        };

        const first = await runTakeoutIncremental(config, provider, {}, firstExtractor);
        expect(first.paused).toBe(true);
        expect(firstRunExtracts).toBe(1);

        // User clears the flag (or the CLI startup path does) and re-runs.
        await fs.rm(path.join(config.workDir, '.takeout-pause.flag'), { force: true });

        let secondRunExtracts = 0;
        const secondExtractor = async (archivePath: string, destinationDir: string) => {
          secondRunExtracts += 1;
          const media = path.join(destinationDir, 'Google Photos', 'Album', `${path.basename(archivePath)}.jpg`);
          await fs.mkdir(path.dirname(media), { recursive: true });
          await fs.writeFile(media, 'img');
        };

        const second = await runTakeoutIncremental(config, provider, {}, secondExtractor);
        expect(second.paused).toBeFalsy();
        // Only the still-pending archive (#2) should be extracted in the second run.
        expect(secondRunExtracts).toBe(1);

        const state = await loadArchiveState(path.join(config.workDir, 'archive-state.json'));
        expect(state.archives['takeout-001.zip']?.status).toBe('completed');
        expect(state.archives['takeout-002.zip']?.status).toBe('completed');
      });
    });
  });
});