import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import type { CloudProvider, ObjectInfo } from '../providers/types.js';
import type { ManifestEntry } from './manifest.js';
import { uploadManifest, loadUploadState, collectDatePrefixes, preloadDestinationIndex } from './uploader.js';

class MockProvider implements CloudProvider {
  readonly name = 'MockProvider';
  readonly objects = new Set<string>();
  readonly failAttempts = new Map<string, number>();
  readonly uploadAttempts = new Map<string, number>();
  listFailuresRemaining = 0;

  async list(options?: { prefix?: string; maxResults?: number }): Promise<ObjectInfo[]> {
    if (this.listFailuresRemaining > 0) {
      this.listFailuresRemaining -= 1;
      throw new Error('transient list failure');
    }

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

  async upload(key: string, _stream: Readable): Promise<void> {
    const attempts = (this.uploadAttempts.get(key) ?? 0) + 1;
    this.uploadAttempts.set(key, attempts);

    const fails = this.failAttempts.get(key) ?? 0;
    if (attempts <= fails) {
      throw new Error(`transient failure ${attempts}`);
    }

    this.objects.add(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mediatransfer-uploader-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createEntry(baseDir: string, name: string, destinationKey: string): Promise<ManifestEntry> {
  const sourcePath = path.join(baseDir, name);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, 'content');
  const stat = await fs.stat(sourcePath);

  return {
    sourcePath,
    relativePath: name.replace(/\\/g, '/'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    capturedAt: new Date('2025-12-13T00:00:00Z').toISOString(),
    datePath: '2025/12/13',
    destinationKey,
  };
}

describe('takeout/uploader', () => {
  it('uploads entries and writes uploaded state', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const entry = await createEntry(dir, 'Album/IMG_1.jpg', '2025/12/13/Album/IMG_1.jpg');
      const statePath = path.join(dir, 'state.json');

      const summary = await uploadManifest({
        provider,
        entries: [entry],
        statePath,
        retryCount: 1,
        sleep: async () => {},
      });

      expect(summary.uploaded).toBe(1);
      expect(summary.skipped).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.total).toBe(1);
      expect(summary.processed).toBe(1);
      expect(summary.dryRun).toBe(false);
      expect(provider.objects.has(entry.destinationKey)).toBe(true);

      const state = await loadUploadState(statePath);
      expect(state.items[entry.destinationKey]?.status).toBe('uploaded');
    });
  });

  it('skips entries already marked uploaded in state', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const entry = await createEntry(dir, 'Album/IMG_2.jpg', '2025/12/13/Album/IMG_2.jpg');
      const statePath = path.join(dir, 'state.json');

      await uploadManifest({
        provider,
        entries: [entry],
        statePath,
        retryCount: 0,
        sleep: async () => {},
      });

      const attemptsBefore = provider.uploadAttempts.get(entry.destinationKey) ?? 0;

      const summary = await uploadManifest({
        provider,
        entries: [entry],
        statePath,
        retryCount: 0,
        sleep: async () => {},
      });

      expect(summary.uploaded).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(summary.failed).toBe(0);
      const attemptsAfter = provider.uploadAttempts.get(entry.destinationKey) ?? 0;
      expect(attemptsAfter).toBe(attemptsBefore);
    });
  });

  it('skips when destination key already exists remotely', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const entry = await createEntry(dir, 'Album/IMG_3.jpg', '2025/12/13/Album/IMG_3.jpg');
      const statePath = path.join(dir, 'state.json');

      provider.objects.add(entry.destinationKey);

      const summary = await uploadManifest({
        provider,
        entries: [entry],
        statePath,
        retryCount: 0,
        sleep: async () => {},
      });

      expect(summary.uploaded).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(summary.failed).toBe(0);
      const state = await loadUploadState(statePath);
      expect(state.items[entry.destinationKey]?.status).toBe('skipped');
    });
  });

  it('retries transient errors and succeeds', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const entry = await createEntry(dir, 'Album/IMG_4.jpg', '2025/12/13/Album/IMG_4.jpg');
      const statePath = path.join(dir, 'state.json');

      provider.failAttempts.set(entry.destinationKey, 2);

      const summary = await uploadManifest({
        provider,
        entries: [entry],
        statePath,
        retryCount: 3,
        sleep: async () => {},
      });

      expect(summary.uploaded).toBe(1);
      expect(summary.skipped).toBe(0);
      expect(summary.failed).toBe(0);
      expect(provider.uploadAttempts.get(entry.destinationKey)).toBe(3);
    });
  });

  it('marks item as failed when retries are exhausted', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const entry = await createEntry(dir, 'Album/IMG_5.jpg', '2025/12/13/Album/IMG_5.jpg');
      const statePath = path.join(dir, 'state.json');

      provider.failAttempts.set(entry.destinationKey, 99);

      const summary = await uploadManifest({
        provider,
        entries: [entry],
        statePath,
        retryCount: 2,
        sleep: async () => {},
      });

      expect(summary.uploaded).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.failed).toBe(1);

      const state = await loadUploadState(statePath);
      expect(state.items[entry.destinationKey]?.status).toBe('failed');
      expect(state.items[entry.destinationKey]?.attempts).toBe(3);
      expect(state.items[entry.destinationKey]?.error).toContain('transient failure');
    });
  });

  it('supports dry-run without uploading objects', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const entry = await createEntry(dir, 'Album/IMG_6.jpg', '2025/12/13/Album/IMG_6.jpg');

      const summary = await uploadManifest({
        provider,
        entries: [entry],
        statePath: path.join(dir, 'state.json'),
        dryRun: true,
        sleep: async () => {},
      });

      expect(summary.dryRun).toBe(true);
      expect(summary.uploaded).toBe(1);
      expect(provider.objects.has(entry.destinationKey)).toBe(false);
    });
  });

  it('stops early when max-failures is reached', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const entry1 = await createEntry(dir, 'Album/F1.jpg', '2025/12/13/Album/F1.jpg');
      const entry2 = await createEntry(dir, 'Album/F2.jpg', '2025/12/13/Album/F2.jpg');

      provider.failAttempts.set(entry1.destinationKey, 99);
      provider.failAttempts.set(entry2.destinationKey, 99);

      const summary = await uploadManifest({
        provider,
        entries: [entry1, entry2],
        statePath: path.join(dir, 'state.json'),
        retryCount: 0,
        maxFailures: 1,
        sleep: async () => {},
      });

      expect(summary.failed).toBe(1);
      expect(summary.stoppedEarly).toBe(true);
      expect(summary.failureLimitReached).toBe(true);
      expect(summary.processed).toBe(1);
    });
  });

  it('applies include/exclude filters', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const a = await createEntry(dir, 'Album/A.jpg', '2025/12/13/Album/A.jpg');
      const b = await createEntry(dir, 'Private/B.jpg', '2025/12/13/Private/B.jpg');

      const summary = await uploadManifest({
        provider,
        entries: [a, b],
        statePath: path.join(dir, 'state.json'),
        includeFilter: 'Album',
        excludeFilter: 'Private',
        sleep: async () => {},
      });

      expect(summary.total).toBe(1);
      expect(summary.uploaded).toBe(1);
      expect(provider.objects.has(a.destinationKey)).toBe(true);
      expect(provider.objects.has(b.destinationKey)).toBe(false);
    });
  });

  it('uploads concurrently with multiple workers without corrupting state', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const entries: ManifestEntry[] = [];

      for (let i = 0; i < 20; i += 1) {
        entries.push(
          await createEntry(dir, `Album/IMG_C${i}.jpg`, `2025/12/13/Album/IMG_C${i}.jpg`),
        );
      }

      const statePath = path.join(dir, 'state.json');

      const summary = await uploadManifest({
        provider,
        entries,
        statePath,
        uploadConcurrency: 4,
        retryCount: 1,
        sleep: async () => {},
      });

      expect(summary.uploaded).toBe(20);
      expect(summary.skipped).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.processed).toBe(20);
      expect(summary.total).toBe(20);
      expect(provider.objects.size).toBe(20);

      const state = await loadUploadState(statePath);
      const uploadedKeys = Object.entries(state.items)
        .filter(([, v]) => v.status === 'uploaded')
        .map(([k]) => k);
      expect(uploadedKeys.length).toBe(20);
    });
  });

  it('continues upload when preloading/list checks fail transiently', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      provider.listFailuresRemaining = 2;

      const entry = await createEntry(dir, 'Album/IMG_L1.jpg', '2025/12/13/Album/IMG_L1.jpg');
      const summary = await uploadManifest({
        provider,
        entries: [entry],
        statePath: path.join(dir, 'state.json'),
        retryCount: 0,
        sleep: async () => {},
      });

      expect(summary.uploaded).toBe(1);
      expect(summary.failed).toBe(0);
      expect(provider.objects.has(entry.destinationKey)).toBe(true);
    });
  });

  it('batches state persistence according to persistEvery', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const entries: ManifestEntry[] = [];

      for (let i = 0; i < 9; i += 1) {
        entries.push(
          await createEntry(dir, `Album/IMG_P${i}.jpg`, `2025/12/13/Album/IMG_P${i}.jpg`),
        );
      }

      const statePath = path.join(dir, 'state.json');

      const summary = await uploadManifest({
        provider,
        entries,
        statePath,
        uploadConcurrency: 1,
        retryCount: 0,
        persistEvery: 3,
        flushIntervalMs: 60_000,  // effectively disabled — only count-based flushes
        sleep: async () => {},
      });

      expect(summary.uploaded).toBe(9);

      // After flush, all 9 items must be in state
      const state = await loadUploadState(statePath);
      expect(Object.keys(state.items).length).toBe(9);

      for (const entry of entries) {
        expect(state.items[entry.destinationKey]?.status).toBe('uploaded');
      }
    });
  });

  it('preloads destination index across multiple date prefixes', async () => {
    const provider = new MockProvider();

    // Simulate objects in two different date directories
    provider.objects.add('transfers/2025/12/13/Album/IMG_1.jpg');
    provider.objects.add('transfers/2025/12/13/Album/IMG_2.jpg');
    provider.objects.add('transfers/2026/01/05/Trip/IMG_3.jpg');
    provider.objects.add('transfers/2026/01/05/Trip/IMG_4.jpg');
    provider.objects.add('transfers/2026/02/20/Other/IMG_5.jpg');

    const entries = [
      { destinationKey: 'transfers/2025/12/13/Album/IMG_1.jpg' },
      { destinationKey: 'transfers/2025/12/13/Album/IMG_2.jpg' },
      { destinationKey: 'transfers/2026/01/05/Trip/IMG_3.jpg' },
      { destinationKey: 'transfers/2026/01/05/Trip/IMG_4.jpg' },
      { destinationKey: 'transfers/2026/02/20/Other/IMG_5.jpg' },
    ];

    const prefixes = collectDatePrefixes(entries);
    expect(prefixes).toEqual(['transfers/2025/12/13/', 'transfers/2026/01/05/', 'transfers/2026/02/20/']);

    const index = await preloadDestinationIndex(provider, entries as ManifestEntry[]);
    expect(index.size).toBe(5);
    expect(index.has('transfers/2025/12/13/Album/IMG_1.jpg')).toBe(true);
    expect(index.has('transfers/2026/01/05/Trip/IMG_3.jpg')).toBe(true);
    expect(index.has('transfers/2026/02/20/Other/IMG_5.jpg')).toBe(true);
  });

  it('does not retry ENOENT errors (missing source file)', async () => {
    await withTempDir(async (dir) => {
      const provider = new MockProvider();
      const statePath = path.join(dir, 'state.json');

      // Create a manifest entry pointing to a file that doesn't exist
      const entry: ManifestEntry = {
        sourcePath: path.join(dir, 'nonexistent', 'IMG_dup1.jpg'),
        relativePath: 'nonexistent/IMG_dup1.jpg',
        size: 100,
        mtimeMs: Date.now(),
        capturedAt: new Date('2025-12-13T00:00:00Z').toISOString(),
        datePath: '2025/12/13',
        destinationKey: 'transfers/2025/12/13/nonexistent/IMG_dup1.jpg',
      };

      let retryCount = 0;
      const summary = await uploadManifest({
        provider,
        entries: [entry],
        statePath,
        retryCount: 5,
        sleep: async () => { retryCount++; },
      });

      // Should fail immediately without retries
      expect(summary.failed).toBe(1);
      expect(summary.uploaded).toBe(0);
      expect(retryCount).toBe(0);

      const state = await loadUploadState(statePath);
      expect(state.items[entry.destinationKey]?.status).toBe('failed');
      expect(state.items[entry.destinationKey]?.error).toContain('ENOENT');
    });
  });
});
