import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { CloudProvider, ObjectInfo } from '../providers/types.js';
import type { MediaItem, PhotosProvider } from '../providers/photos-types.js';
import { loadGoogleApiTransferState, runGoogleApiBatchTransferLoop } from './google-api-runner.js';

class FakePhotosProvider implements PhotosProvider {
  readonly name = 'Google Photos';

  private readonly pages: Array<{ items: MediaItem[]; nextPageToken?: string }>;
  private readonly payloads: Map<string, Buffer>;

  constructor(pages: Array<{ items: MediaItem[]; nextPageToken?: string }>, payloads: Map<string, Buffer>) {
    this.pages = pages;
    this.payloads = payloads;
  }

  async listAlbums() {
    return { albums: [], nextPageToken: undefined };
  }

  async listMediaItems(options?: { pageToken?: string }): Promise<{ items: MediaItem[]; nextPageToken?: string }> {
    const token = options?.pageToken;
    if (!token) {
      return this.pages[0] ?? { items: [], nextPageToken: undefined };
    }

    const page = this.pages.find((entry) => entry.nextPageToken === token);
    if (page) {
      return page;
    }

    const currentIndex = this.pages.findIndex((entry) => entry.nextPageToken === token);
    if (currentIndex >= 0 && currentIndex + 1 < this.pages.length) {
      return this.pages[currentIndex + 1];
    }

    return { items: [], nextPageToken: undefined };
  }

  async getMediaItem(id: string): Promise<MediaItem> {
    for (const page of this.pages) {
      const found = page.items.find((item) => item.id === id);
      if (found) {
        return found;
      }
    }
    throw new Error(`Unknown media item ${id}`);
  }

  async downloadMedia(mediaItemId: string): Promise<Readable> {
    const payload = this.payloads.get(mediaItemId);
    if (!payload) {
      throw new Error(`Missing payload for ${mediaItemId}`);
    }
    return Readable.from([payload]);
  }
}

class FakeCloudProvider implements CloudProvider {
  readonly name = 'Scaleway Object Storage';
  private readonly objects = new Map<string, Buffer>();

  async list(options?: { prefix?: string; maxResults?: number }): Promise<ObjectInfo[]> {
    const prefix = options?.prefix ?? '';
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .slice(0, options?.maxResults ?? Number.MAX_SAFE_INTEGER);

    return keys.map((key) => ({
      key,
      size: this.objects.get(key)?.byteLength ?? 0,
      lastModified: new Date(),
      contentType: undefined,
    }));
  }

  async download(key: string): Promise<Readable> {
    const payload = this.objects.get(key);
    if (!payload) {
      throw new Error(`Missing object ${key}`);
    }
    return Readable.from([payload]);
  }

  async upload(key: string, stream: Readable): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.objects.set(key, Buffer.concat(chunks));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function mediaItem(id: string, filename: string): MediaItem {
  return {
    id,
    filename,
    mimeType: 'image/jpeg',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    width: 100,
    height: 100,
    baseUrl: `https://example.com/${id}`,
  };
}

async function makeTempDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(process.cwd(), `.tmp-google-api-${name}-`));
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

const dirsToCleanup: string[] = [];

afterEach(async () => {
  await Promise.all(dirsToCleanup.splice(0).map((dir) => removeDir(dir)));
});

describe('takeout/google-api-runner', () => {
  it('transfers, verifies, deletes local files, and checkpoints state', async () => {
    const tempRoot = await makeTempDir('basic');
    dirsToCleanup.push(tempRoot);
    const statePath = path.join(tempRoot, 'state.json');
    const tempDir = path.join(tempRoot, 'temp');

    const pageOne = {
      items: [mediaItem('a1', 'one.jpg'), mediaItem('a2', 'two.jpg')],
      nextPageToken: undefined,
    };

    const source = new FakePhotosProvider(
      [pageOne],
      new Map([
        ['a1', Buffer.from('aaa')],
        ['a2', Buffer.from('bbbb')],
      ]),
    );
    const destination = new FakeCloudProvider();

    const result = await runGoogleApiBatchTransferLoop(source, destination, {
      statePath,
      tempDir,
      batchMaxItems: 100,
      batchMaxBytes: 1024,
    });

    expect(result.totalDownloaded).toBe(2);
    expect(result.totalUploaded).toBe(2);
    expect(result.totalVerified).toBe(2);
    expect(result.totalDeletedLocal).toBe(2);
    expect(result.completed).toBe(true);

    const files = await fs.readdir(tempDir);
    expect(files).toHaveLength(0);

    const state = await loadGoogleApiTransferState(statePath);
    expect(Object.keys(state.transferred)).toHaveLength(2);
  });

  it('respects byte limit per batch and resumes remaining items in next batch', async () => {
    const tempRoot = await makeTempDir('limit');
    dirsToCleanup.push(tempRoot);
    const statePath = path.join(tempRoot, 'state.json');
    const tempDir = path.join(tempRoot, 'temp');

    const pageOne = {
      items: [mediaItem('b1', 'one.jpg'), mediaItem('b2', 'two.jpg')],
      nextPageToken: undefined,
    };

    const source = new FakePhotosProvider(
      [pageOne],
      new Map([
        ['b1', Buffer.from('1234')],
        ['b2', Buffer.from('5678')],
      ]),
    );
    const destination = new FakeCloudProvider();

    const result = await runGoogleApiBatchTransferLoop(source, destination, {
      statePath,
      tempDir,
      batchMaxItems: 100,
      batchMaxBytes: 5,
    });

    expect(result.batches.length).toBeGreaterThanOrEqual(2);
    expect(result.totalUploaded).toBe(2);
    expect(result.completed).toBe(true);
  });
});