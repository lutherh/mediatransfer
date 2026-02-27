import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ScalewayCatalogService, decodeKey, encodeKey } from './scaleway-catalog.js';

function makeService(send: ReturnType<typeof vi.fn>) {
  return new ScalewayCatalogService(
    { region: 'nl-ams', bucket: 'media', accessKey: 'access', secretKey: 'secret' },
    { send } as any,
  );
}

describe('scaleway catalog service', () => {
  it('encodes and decodes keys symmetrically', () => {
    const key = 'photos/by-hash/00/24/00243b6e3e8e28a78e11ce7a8f78a0253eadb1f70794f7b3e338164ca9c700af.HEIC';
    const encoded = encodeKey(key);

    expect(decodeKey(encoded)).toBe(key);
  });

  it('falls back content type from extension when object metadata is missing', async () => {
    const send = vi.fn(async () => ({
      Body: Readable.from([Buffer.from('ok')]),
      ContentType: undefined,
    }));

    const service = makeService(send);
    const media = await service.getObject(encodeKey('2026/02/20/photo.HEIC'));

    expect(media.contentType).toBe('image/heic');
  });

  it('keeps storage content type when provided', async () => {
    const send = vi.fn(async () => ({
      Body: Readable.from([Buffer.from('ok')]),
      ContentType: 'image/jpeg',
    }));

    const service = makeService(send);
    const media = await service.getObject(encodeKey('2026/02/20/photo.jpg'));

    expect(media.contentType).toBe('image/jpeg');
  });

  it('infers captured date from filename timestamp when available', async () => {
    const send = vi.fn(async () => ({
      Contents: [
        {
          Key: 'archive/IMG_20200203_132211.jpg',
          Size: 123,
          LastModified: new Date('2026-02-24T10:00:00.000Z'),
        },
      ],
      IsTruncated: false,
    }));

    const service = makeService(send);
    const page = await service.listPage({ max: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.capturedAt).toBe('2020-02-03T13:22:11.000Z');
    expect(page.items[0]?.sectionDate).toBe('2020-02-03');
  });

  it('falls back to nested path date when filename date is invalid', async () => {
    const send = vi.fn(async () => ({
      Contents: [
        {
          Key: 'backup/family/2021/09/14/IMG_20211340_999999.jpg',
          Size: 123,
          LastModified: new Date('2026-02-24T10:00:00.000Z'),
        },
      ],
      IsTruncated: false,
    }));

    const service = makeService(send);
    const page = await service.listPage({ max: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.capturedAt).toBe('2021-09-14T00:00:00.000Z');
    expect(page.items[0]?.sectionDate).toBe('2021-09-14');
  });

  describe('listAll', () => {
    it('returns all items across multiple pages', async () => {
      let callCount = 0;
      const send = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            Contents: [
              { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
              { Key: '2020/01/02/b.jpg', Size: 200, LastModified: new Date('2020-01-02') },
            ],
            IsTruncated: true,
            NextContinuationToken: 'tok1',
          };
        }
        return {
          Contents: [
            { Key: '2021/06/15/c.mp4', Size: 300, LastModified: new Date('2021-06-15') },
          ],
          IsTruncated: false,
        };
      });

      const service = makeService(send);
      const items = await service.listAll();
      expect(items).toHaveLength(3);
      // Should be sorted newest first
      expect(items[0]?.key).toBe('2021/06/15/c.mp4');
      expect(items[2]?.key).toBe('2020/01/01/a.jpg');
    });

    it('filters non-media files', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
          { Key: '_albums.json', Size: 50, LastModified: new Date('2024-01-01') },
          { Key: '2020/01/01/readme.txt', Size: 10, LastModified: new Date('2020-01-01') },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const items = await service.listAll();
      expect(items).toHaveLength(1);
      expect(items[0]?.key).toBe('2020/01/01/a.jpg');
    });
  });

  describe('deleteObjects', () => {
    it('deletes objects and returns results', async () => {
      const send = vi.fn(async () => ({
        Deleted: [{ Key: '2020/01/01/a.jpg' }, { Key: '2020/01/02/b.jpg' }],
        Errors: [],
      }));

      const service = makeService(send);
      const result = await service.deleteObjects([
        encodeKey('2020/01/01/a.jpg'),
        encodeKey('2020/01/02/b.jpg'),
      ]);

      expect(result.deleted).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      expect(result.deleted).toContain('2020/01/01/a.jpg');
    });

    it('reports partially failed deletions', async () => {
      const send = vi.fn(async () => ({
        Deleted: [{ Key: '2020/01/01/a.jpg' }],
        Errors: [{ Key: '2020/01/02/b.jpg', Message: 'Access denied' }],
      }));

      const service = makeService(send);
      const result = await service.deleteObjects([
        encodeKey('2020/01/01/a.jpg'),
        encodeKey('2020/01/02/b.jpg'),
      ]);

      expect(result.deleted).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.error).toBe('Access denied');
    });

    it('handles full batch failure gracefully', async () => {
      const send = vi.fn(async () => {
        throw new Error('Network error');
      });

      const service = makeService(send);
      const result = await service.deleteObjects([encodeKey('2020/01/01/a.jpg')]);

      expect(result.deleted).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.error).toContain('Network error');
    });

    it('invalidates stats cache after deletion', async () => {
      let statsCallCount = 0;
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'ListObjectsV2Command') {
          statsCallCount++;
          return {
            Contents: [
              { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
            ],
            IsTruncated: false,
          };
        }
        if (name === 'DeleteObjectsCommand') {
          return { Deleted: [{ Key: '2020/01/01/a.jpg' }], Errors: [] };
        }
        return {};
      });

      const service = makeService(send);
      // Prime cache
      await service.getStats();
      const firstCount = statsCallCount;
      // Use cache
      await service.getStats();
      expect(statsCallCount).toBe(firstCount);
      // Delete should invalidate
      await service.deleteObjects([encodeKey('2020/01/01/a.jpg')]);
      await service.getStats();
      expect(statsCallCount).toBeGreaterThan(firstCount);
    });
  });

  describe('moveObject', () => {
    it('copies to new path and deletes original', async () => {
      const calls: string[] = [];
      const send = vi.fn(async (cmd: any) => {
        calls.push(cmd.constructor?.name ?? 'unknown');
        if (cmd.constructor?.name === 'CopyObjectCommand') {
          return {};
        }
        if (cmd.constructor?.name === 'DeleteObjectCommand') {
          return {};
        }
        return {};
      });

      const service = makeService(send);
      const result = await service.moveObject(encodeKey('2026/02/24/photo.jpg'), '2020/03/15');

      expect(result.from).toBe('2026/02/24/photo.jpg');
      expect(result.to).toBe('2020/03/15/photo.jpg');
      expect(calls).toContain('CopyObjectCommand');
      expect(calls).toContain('DeleteObjectCommand');
    });

    it('preserves filename during move', async () => {
      const send = vi.fn(async () => ({}));
      const service = makeService(send);
      const result = await service.moveObject(encodeKey('2026/02/24/IMG_20200315_120000.jpg'), '2020/03/15');
      expect(result.to).toBe('2020/03/15/IMG_20200315_120000.jpg');
    });
  });

  describe('albums', () => {
    it('returns empty manifest when no albums file exists', async () => {
      const send = vi.fn(async () => {
        const err = new Error('Not found') as any;
        err.name = 'NoSuchKey';
        throw err;
      });

      const service = makeService(send);
      const manifest = await service.getAlbums();
      expect(manifest.albums).toEqual([]);
    });

    it('reads existing albums manifest', async () => {
      const manifest = { albums: [{ id: '1', name: 'Vacation', keys: ['a.jpg'], createdAt: '', updatedAt: '' }] };
      const send = vi.fn(async () => ({
        Body: Readable.from([Buffer.from(JSON.stringify(manifest))]),
      }));

      const service = makeService(send);
      const result = await service.getAlbums();
      expect(result.albums).toHaveLength(1);
      expect(result.albums[0]?.name).toBe('Vacation');
    });

    it('saves albums manifest via PutObjectCommand', async () => {
      const calls: any[] = [];
      const send = vi.fn(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const service = makeService(send);
      await service.saveAlbums({ albums: [{ id: '1', name: 'Test', keys: [], createdAt: '', updatedAt: '' }] });

      expect(calls).toHaveLength(1);
      const putCmd = calls[0];
      expect(putCmd.input?.ContentType).toBe('application/json');
      const body = putCmd.input?.Body;
      expect(body).toContain('"Test"');
    });
  });

  describe('getStats', () => {
    it('counts files and byte sizes correctly', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 1000, LastModified: new Date('2020-01-01') },
          { Key: '2020/01/02/b.mp4', Size: 5000, LastModified: new Date('2020-01-02') },
          { Key: '2021/06/15/c.png', Size: 2000, LastModified: new Date('2021-06-15') },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const stats = await service.getStats();

      expect(stats.totalFiles).toBe(3);
      expect(stats.totalBytes).toBe(8000);
      expect(stats.imageCount).toBe(2);
      expect(stats.videoCount).toBe(1);
    });

    it('caches stats within TTL', async () => {
      let callCount = 0;
      const send = vi.fn(async () => {
        callCount++;
        return {
          Contents: [{ Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') }],
          IsTruncated: false,
        };
      });

      const service = makeService(send);
      await service.getStats();
      await service.getStats();
      // Second call should use cache
      expect(callCount).toBe(1);
    });
  });
});
