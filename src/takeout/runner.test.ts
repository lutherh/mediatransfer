import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import type { CloudProvider, ObjectInfo } from '../providers/types.js';
import { persistManifestJsonl, type ManifestEntry } from './manifest.js';
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
      await expect(fs.access(result.manifestPath)).resolves.toBeUndefined();

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
      // checkpointed but the pipeline crashed before normalize/manifest/clear.
      const scanStatePath = path.join(workDir, 'scan-state.json');
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(scanStatePath, JSON.stringify({
        version: 1,
        extractedArchives: ['takeout-1.zip'],
        lastUpdatedAt: new Date().toISOString(),
      }));

      // Also write a stale manifest from a prior batch (different content)
      await persistManifestJsonl([], path.join(workDir, 'manifest.jsonl'));

      // Put extracted content in workDir as if extraction already happened
      const mediaDir = path.join(workDir, 'Takeout', 'Google Photos', 'Album1');
      await fs.mkdir(mediaDir, { recursive: true });
      await fs.writeFile(path.join(mediaDir, 'IMG_1.jpg'), 'x');
      await fs.writeFile(path.join(mediaDir, 'IMG_2.jpg'), 'y');

      // The extractor should NOT be called (archives already extracted)
      let extractorCalled = false;
      const result = await runTakeoutScan(config, async () => {
        extractorCalled = true;
      });

      expect(extractorCalled).toBe(false);
      expect(result.entryCount).toBe(2);
      // Scan-state should be cleared after full pipeline completes
      await expect(fs.access(scanStatePath)).rejects.toThrow();
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
