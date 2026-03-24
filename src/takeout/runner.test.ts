import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import type { CloudProvider, ObjectInfo } from '../providers/types.js';
import { persistManifestJsonl, type ManifestEntry } from './manifest.js';
import { persistArchiveState, createEmptyArchiveState } from './incremental.js';
import {
  runTakeoutScan,
  runTakeoutUpload,
  runTakeoutResume,
  runTakeoutVerify,
  withDefaults,
} from './runner.js';

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
    throw new Error('not needed');
  }

  async upload(key: string): Promise<void> {
    this.objects.add(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mediatransfer-runner-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createEntry(baseDir: string, fileName: string, destinationKey: string): Promise<ManifestEntry> {
  const sourcePath = path.join(baseDir, fileName);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, 'content');
  const stat = await fs.stat(sourcePath);

  return {
    sourcePath,
    relativePath: fileName.replace(/\\/g, '/'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    capturedAt: new Date('2025-12-13T00:00:00Z').toISOString(),
    datePath: '2025/12/13',
    destinationKey,
  };
}

describe('takeout/runner', () => {
  it('runs scan flow and writes manifest file', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'takeout-1.zip'), 'archive');

      const config = withDefaults({
        inputDir,
        workDir,
        statePath: path.join(dir, 'state.json'),
      });

      const result = await runTakeoutScan(config, async (_archive, destinationDir) => {
        const mediaDir = path.join(destinationDir, 'Takeout', 'Google Photos', 'Album1');
        await fs.mkdir(mediaDir, { recursive: true });
        await fs.writeFile(path.join(mediaDir, 'IMG_1.jpg'), 'x');
      });

      expect(result.entryCount).toBe(1);
      expect(result.mediaRoot).toBe(inputDir);
      await expect(fs.access(result.manifestPath)).resolves.toBeUndefined();
      // Extracted files are deleted — no normalized dir or temp-extract
      await expect(fs.access(path.join(workDir, 'normalized'))).rejects.toThrow();
      await expect(fs.access(path.join(workDir, 'temp-extract'))).rejects.toThrow();

      const archiveStatePath = path.join(workDir, 'archive-state.json');
      const archiveStateRaw = await fs.readFile(archiveStatePath, 'utf8');
      const archiveState = JSON.parse(archiveStateRaw) as {
        archives: Record<string, { status: string }>;
      };
      expect(archiveState.archives['takeout-1.zip']?.status).toBe('pending');
    });
  });

  it('recovers when previous scan was interrupted after extraction', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'takeout-1.zip'), 'archive');

      const config = withDefaults({
        inputDir,
        workDir,
        statePath: path.join(dir, 'state.json'),
      });

      // Simulate a previous interrupted scan: extraction completed and was
      // checkpointed but the pipeline crashed before manifest finalization.
      const scanStatePath = path.join(workDir, 'scan-state.json');
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(scanStatePath, JSON.stringify({
        version: 1,
        extractedArchives: ['takeout-1.zip'],
        lastUpdatedAt: new Date().toISOString(),
      }));

      // Partial manifest has entries from the checkpointed archive
      const partialManifestPath = path.join(workDir, 'scan-entries.jsonl');
      const entry1 = JSON.stringify({
        sourcePath: '/tmp/old/IMG_1.jpg',
        relativePath: 'Album1/IMG_1.jpg',
        size: 100,
        mtimeMs: Date.now(),
        capturedAt: '2025-12-13T00:00:00.000Z',
        datePath: '2025/12/13',
        destinationKey: 'transfers/2025/12/13/Album1/IMG_1.jpg',
      });
      const entry2 = JSON.stringify({
        sourcePath: '/tmp/old/IMG_2.jpg',
        relativePath: 'Album1/IMG_2.jpg',
        size: 200,
        mtimeMs: Date.now(),
        capturedAt: '2025-12-13T00:00:00.000Z',
        datePath: '2025/12/13',
        destinationKey: 'transfers/2025/12/13/Album1/IMG_2.jpg',
      });
      await fs.writeFile(partialManifestPath, `${entry1}\n${entry2}\n`);

      // The extractor should NOT be called (archive already checkpointed)
      let extractorCalled = false;
      const result = await runTakeoutScan(config, async () => {
        extractorCalled = true;
      });

      expect(extractorCalled).toBe(false);
      expect(result.entryCount).toBe(2);
      // Scan-state and partial manifest should be cleared after completion
      await expect(fs.access(scanStatePath)).rejects.toThrow();
      await expect(fs.access(partialManifestPath)).rejects.toThrow();
    });
  });

  it('skips archives already completed in archive-state during re-scan', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'takeout-1.zip'), 'archive-1');
      await fs.writeFile(path.join(inputDir, 'takeout-2.zip'), 'archive-2');

      const config = withDefaults({
        inputDir,
        workDir,
        statePath: path.join(dir, 'state.json'),
      });

      // Pre-populate archive-state marking takeout-1.zip as completed
      await fs.mkdir(workDir, { recursive: true });
      const archiveStatePath = path.join(workDir, 'archive-state.json');
      const archiveState = createEmptyArchiveState();
      archiveState.archives['takeout-1.zip'] = {
        status: 'completed',
        entryCount: 5,
        uploadedCount: 5,
        skippedCount: 0,
        failedCount: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      await persistArchiveState(archiveStatePath, archiveState);

      // Pre-populate manifest with entries from the completed archive
      const manifestPath = path.join(workDir, 'manifest.jsonl');
      const existingEntry = JSON.stringify({
        sourcePath: path.join(inputDir, 'old/IMG_1.jpg'),
        relativePath: 'Album/IMG_1.jpg',
        size: 100,
        mtimeMs: Date.now(),
        capturedAt: '2025-12-13T00:00:00.000Z',
        datePath: '2025/12/13',
        destinationKey: 'transfers/2025/12/13/Album/IMG_1.jpg',
      });
      await fs.writeFile(manifestPath, `${existingEntry}\n`);

      // Track which archives the extractor was called for
      const extractedArchives: string[] = [];
      const result = await runTakeoutScan(config, async (archivePath, destinationDir) => {
        const archiveName = path.basename(archivePath);
        extractedArchives.push(archiveName);
        const mediaDir = path.join(destinationDir, 'Takeout', 'Google Photos', 'Album2');
        await fs.mkdir(mediaDir, { recursive: true });
        await fs.writeFile(path.join(mediaDir, 'IMG_2.jpg'), 'photo-2');
      });

      // Only takeout-2.zip should be extracted — takeout-1.zip is completed
      expect(extractedArchives).toEqual(['takeout-2.zip']);
      expect(result.entryCount).toBeGreaterThanOrEqual(1);
    });
  });

  it('scans multiple archives without keeping extracted files on disk', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'takeout-1.zip'), 'archive-1');
      await fs.writeFile(path.join(inputDir, 'takeout-2.zip'), 'archive-2');

      const config = withDefaults({
        inputDir,
        workDir,
        statePath: path.join(dir, 'state.json'),
      });

      const result = await runTakeoutScan(config, async (archivePath, destinationDir) => {
        const archiveId = path.basename(archivePath, '.zip');
        const mediaDir = path.join(destinationDir, 'Takeout', 'Google Photos', archiveId);
        await fs.mkdir(mediaDir, { recursive: true });
        await fs.writeFile(path.join(mediaDir, `${archiveId}.jpg`), archiveId);
      });

      expect(result.entryCount).toBe(2);
      // No files left on disk — no normalized dir or temp-extract
      await expect(fs.access(path.join(workDir, 'normalized'))).rejects.toThrow();
      await expect(fs.access(path.join(workDir, 'temp-extract'))).rejects.toThrow();
      // Manifest has entries from both archives
      const manifest = await fs.readFile(path.join(workDir, 'manifest.jsonl'), 'utf8');
      expect(manifest.trim().split('\n')).toHaveLength(2);
    });
  });

  it('refines unknown-date entries using metadata from another scanned archive before writing the manifest', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'takeout-1.zip'), 'archive-1');
      await fs.writeFile(path.join(inputDir, 'takeout-2.zip'), 'archive-2');

      const config = withDefaults({
        inputDir,
        workDir,
        statePath: path.join(dir, 'state.json'),
      });

      const result = await runTakeoutScan(config, async (archivePath, destinationDir) => {
        const archiveName = path.basename(archivePath);
        const mediaDir = path.join(destinationDir, 'Takeout', 'Google Photos');

        if (archiveName === 'takeout-1.zip') {
          const otherAlbum = path.join(mediaDir, 'Other Album');
          await fs.mkdir(otherAlbum, { recursive: true });
          const mediaPath = path.join(otherAlbum, 'IMG_0031.MOV');
          await fs.writeFile(mediaPath, 'video-from-archive-1');
          await fs.writeFile(
            `${mediaPath}.json`,
            JSON.stringify({
              photoTakenTime: { timestamp: '1496563200' },
            }),
          );
        } else {
          const familyAlbum = path.join(mediaDir, 'Familie og venner');
          await fs.mkdir(familyAlbum, { recursive: true });
          await fs.writeFile(path.join(familyAlbum, 'IMG_0031.MOV'), 'video-from-archive-2');
        }
      });

      expect(result.entryCount).toBe(2);

      const manifestRaw = await fs.readFile(path.join(workDir, 'manifest.jsonl'), 'utf8');
      const manifest = manifestRaw.trim().split('\n').map((line) => JSON.parse(line) as ManifestEntry);
      const refined = manifest.find((entry) => entry.relativePath === 'Familie og venner/IMG_0031.MOV');

      expect(refined).toBeDefined();
      expect(refined?.datePath).toBe('2017/06/04');
      expect(refined?.destinationKey).toBe('transfers/2017/06/04/Familie_og_venner/IMG_0031.MOV');
    });
  });

  it('runs upload then resume and skips already uploaded entries', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const config = withDefaults({
        inputDir: path.join(dir, 'input'),
        workDir: path.join(dir, 'work'),
        statePath: path.join(dir, 'state.json'),
        uploadRetryCount: 1,
      });

      await fs.mkdir(config.workDir, { recursive: true });
      await fs.writeFile(config.statePath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: {} }));
      const entry = await createEntry(dir, 'Album/IMG_2.jpg', '2025/12/13/Album/IMG_2.jpg');
      const manifestPath = path.join(config.workDir, 'manifest.jsonl');
      await persistManifestJsonl([entry], manifestPath);

      const first = await runTakeoutUpload(config, provider, manifestPath);
      const second = await runTakeoutResume(config, provider, manifestPath);

      expect(first.summary.uploaded).toBe(1);
      expect(first.summary.skipped).toBe(0);
      expect(first.summary.failed).toBe(0);
      expect(second.summary.uploaded).toBe(0);
      expect(second.summary.skipped).toBe(1);
      expect(second.summary.failed).toBe(0);
      await expect(fs.access(first.reportJsonPath)).resolves.toBeUndefined();
      await expect(fs.access(first.reportCsvPath)).resolves.toBeUndefined();
    });
  });

  it('verifies present and missing objects', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const config = withDefaults({
        inputDir: path.join(dir, 'input'),
        workDir: path.join(dir, 'work'),
        statePath: path.join(dir, 'state.json'),
      });

      await fs.mkdir(config.workDir, { recursive: true });
      const entry1 = await createEntry(dir, 'Album/IMG_A.jpg', '2025/12/13/Album/IMG_A.jpg');
      const entry2 = await createEntry(dir, 'Album/IMG_B.jpg', '2025/12/13/Album/IMG_B.jpg');
      const manifestPath = path.join(config.workDir, 'manifest.jsonl');
      await persistManifestJsonl([entry1, entry2], manifestPath);

      provider.objects.add(entry1.destinationKey);

      const summary = await runTakeoutVerify(config, provider, manifestPath);
      expect(summary.total).toBe(2);
      expect(summary.present).toBe(1);
      expect(summary.missing).toBe(1);
      expect(summary.missingKeys).toEqual([entry2.destinationKey]);
    });
  });
});
