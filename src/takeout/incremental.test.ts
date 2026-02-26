import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import type { CloudProvider, ObjectInfo } from '../providers/types.js';
import type { TakeoutConfig } from './config.js';
import { runTakeoutIncremental, loadArchiveState } from './incremental.js';

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
});