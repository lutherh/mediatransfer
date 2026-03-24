import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  DiskThumbnailCache,
  ScalewayCatalogService,
  VIDEO_THUMB_RANGE_BYTES,
  buildDuplicateGroups,
  decodeKey,
  encodeKey,
  scoreKeyForKeep,
} from './scaleway-catalog.js';

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

  it('uses path date instead of false-positive filename digit match', async () => {
    // Filenames like 68120710305__… contain "2071" embedded in a longer digit
    // sequence. The regex should NOT extract a bogus 2071-03-05 date from that;
    // it should prefer the reliable YYYY/MM/DD path date.
    const send = vi.fn(async () => ({
      Contents: [
        {
          Key: 'transfers/2022/08/03/Photos_from_2022/68120710305__48F6AE01-7E45-45D1-9DE6-9175E5E32C.JPG',
          Size: 2_600_000,
          LastModified: new Date('2026-03-18T23:31:01.000Z'),
        },
      ],
      IsTruncated: false,
    }));

    const service = makeService(send);
    const page = await service.listPage({ max: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.capturedAt).toBe('2022-08-03T00:00:00.000Z');
    expect(page.items[0]?.sectionDate).toBe('2022-08-03');
  });

  it('excludes unknown-date items from listPage', async () => {
    const send = vi.fn(async () => ({
      Contents: [
        { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
        { Key: 'transfers/unknown-date/b.jpg', Size: 200, LastModified: new Date('2024-01-01') },
        { Key: '2021/06/15/c.mp4', Size: 300, LastModified: new Date('2021-06-15') },
      ],
      IsTruncated: false,
    }));

    const service = makeService(send);
    const page = await service.listPage({ max: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items.map((i) => i.key)).toEqual(['2020/01/01/a.jpg', '2021/06/15/c.mp4']);
  });

  describe('listPage with sort=desc', () => {
    function makeDescService() {
      let callCount = 0;
      const send = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            Contents: [
              { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
              { Key: '2021/06/15/b.jpg', Size: 200, LastModified: new Date('2021-06-15') },
              { Key: '2024/03/10/c.mp4', Size: 300, LastModified: new Date('2024-03-10') },
              { Key: '2025/12/25/d.jpg', Size: 400, LastModified: new Date('2025-12-25') },
            ],
            IsTruncated: false,
          };
        }
        return { Contents: [], IsTruncated: false };
      });
      return makeService(send);
    }

    it('returns items sorted newest-first', async () => {
      const service = makeDescService();
      const page = await service.listPage({ max: 10, sort: 'desc' });
      expect(page.items).toHaveLength(4);
      expect(page.items[0]?.key).toBe('2025/12/25/d.jpg');
      expect(page.items[3]?.key).toBe('2020/01/01/a.jpg');
    });

    it('paginates with numeric offset tokens', async () => {
      const service = makeDescService();
      const page1 = await service.listPage({ max: 2, sort: 'desc' });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextToken).toBe('2');
      expect(page1.items[0]?.key).toBe('2025/12/25/d.jpg');

      const page2 = await service.listPage({ max: 2, token: page1.nextToken, sort: 'desc' });
      expect(page2.items).toHaveLength(2);
      expect(page2.items[0]?.key).toBe('2021/06/15/b.jpg');
      expect(page2.nextToken).toBeUndefined();
    });

    it('filters by prefix', async () => {
      const service = makeDescService();
      const page = await service.listPage({ max: 10, prefix: '2020', sort: 'desc' });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.key).toBe('2020/01/01/a.jpg');
    });

    it('returns empty for invalid token', async () => {
      const service = makeDescService();
      const page = await service.listPage({ max: 10, token: 'not-a-number', sort: 'desc' });
      expect(page.items).toHaveLength(0);
      expect(page.nextToken).toBeUndefined();
    });

    it('caches index across calls', async () => {
      let listCallCount = 0;
      const send = vi.fn(async () => {
        listCallCount++;
        return {
          Contents: [
            { Key: '2025/01/01/a.jpg', Size: 100, LastModified: new Date('2025-01-01') },
          ],
          IsTruncated: false,
        };
      });
      const service = makeService(send);
      await service.listPage({ sort: 'desc' });
      await service.listPage({ sort: 'desc' });
      // Second call should use cache — only 1 S3 list call
      expect(listCallCount).toBe(1);
    });
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

    it('excludes unknown-date items', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
          { Key: 'transfers/unknown-date/b.jpg', Size: 200, LastModified: new Date('2024-01-01') },
          { Key: 'transfers/unknown-date/subdir/c.mp4', Size: 300, LastModified: new Date('2024-01-01') },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const items = await service.listAll();
      expect(items).toHaveLength(1);
      expect(items[0]?.key).toBe('2020/01/01/a.jpg');
    });
  });

  describe('listUndated', () => {
    it('returns only unknown-date items', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: 'transfers/unknown-date/a.jpg', Size: 100, LastModified: new Date('2024-03-01') },
          { Key: 'transfers/unknown-date/sub/b.mp4', Size: 200, LastModified: new Date('2024-03-02') },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const items = await service.listUndated();
      expect(items).toHaveLength(2);
      expect(items[0]?.key).toBe('transfers/unknown-date/sub/b.mp4');
      expect(items[1]?.key).toBe('transfers/unknown-date/a.jpg');
    });

    it('returns empty list when no undated items', async () => {
      const send = vi.fn(async () => ({
        Contents: [],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const items = await service.listUndated();
      expect(items).toHaveLength(0);
    });

    it('filters out non-media files', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: 'transfers/unknown-date/a.jpg', Size: 100, LastModified: new Date('2024-03-01') },
          { Key: 'transfers/unknown-date/notes.txt', Size: 50, LastModified: new Date('2024-03-01') },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const items = await service.listUndated();
      expect(items).toHaveLength(1);
      expect(items[0]?.key).toBe('transfers/unknown-date/a.jpg');
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

    it('invalidates items index cache after deletion', async () => {
      let listCallCount = 0;
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'ListObjectsV2Command') {
          listCallCount++;
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
      // Prime index cache via desc listing
      await service.listPage({ sort: 'desc' });
      const firstCount = listCallCount;
      // Use cache
      await service.listPage({ sort: 'desc' });
      expect(listCallCount).toBe(firstCount);
      // Delete should invalidate index cache
      await service.deleteObjects([encodeKey('2020/01/01/a.jpg')]);
      await service.listPage({ sort: 'desc' });
      expect(listCallCount).toBeGreaterThan(firstCount);
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

    it('invalidates items index cache after move', async () => {
      let listCallCount = 0;
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'ListObjectsV2Command') {
          listCallCount++;
          return {
            Contents: [
              { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
            ],
            IsTruncated: false,
          };
        }
        return {};
      });

      const service = makeService(send);
      // Prime index cache
      await service.listPage({ sort: 'desc' });
      const firstCount = listCallCount;
      await service.listPage({ sort: 'desc' });
      expect(listCallCount).toBe(firstCount);
      // Move should invalidate index cache
      await service.moveObject(encodeKey('2020/01/01/a.jpg'), '2021/05/10');
      await service.listPage({ sort: 'desc' });
      expect(listCallCount).toBeGreaterThan(firstCount);
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
      const send = vi.fn(async (cmd: any) => {
        const prefix = cmd.input?.Prefix ?? '';
        if (prefix.startsWith('transfers/unknown-date')) {
          return { Contents: [], IsTruncated: false };
        }
        return {
          Contents: [
            { Key: '2020/01/01/a.jpg', Size: 1000, LastModified: new Date('2020-01-01') },
            { Key: '2020/01/02/b.mp4', Size: 5000, LastModified: new Date('2020-01-02') },
            { Key: '2021/06/15/c.png', Size: 2000, LastModified: new Date('2021-06-15') },
          ],
          IsTruncated: false,
        };
      });

      const service = makeService(send);
      const stats = await service.getStats();

      expect(stats.totalFiles).toBe(3);
      expect(stats.totalBytes).toBe(8000);
      expect(stats.imageCount).toBe(2);
      expect(stats.videoCount).toBe(1);
      expect(stats.undatedCount).toBe(0);
    });

    it('counts undated items separately', async () => {
      const send = vi.fn(async (cmd: any) => {
        const prefix = cmd.input?.Prefix ?? '';
        if (prefix.startsWith('transfers/unknown-date')) {
          return {
            Contents: [
              { Key: 'transfers/unknown-date/x.jpg', Size: 500, LastModified: new Date('2024-06-01') },
              { Key: 'transfers/unknown-date/y.mp4', Size: 1500, LastModified: new Date('2024-06-02') },
            ],
            IsTruncated: false,
          };
        }
        return {
          Contents: [
            { Key: '2020/01/01/a.jpg', Size: 1000, LastModified: new Date('2020-01-01') },
          ],
          IsTruncated: false,
        };
      });

      const service = makeService(send);
      const stats = await service.getStats();

      expect(stats.totalFiles).toBe(1);
      expect(stats.undatedCount).toBe(2);
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
      const countAfterFirst = callCount;
      await service.getStats();
      // Second call should use cache — no additional S3 requests
      expect(callCount).toBe(countAfterFirst);
    });
  });

  // ── Deduplication tests ──────────────────────────────────────

  describe('scoreKeyForKeep', () => {
    it('scores keys with proper date path higher', () => {
      const datePathScore = scoreKeyForKeep('2020/03/15/photo.jpg');
      const flatScore = scoreKeyForKeep('archive/photo.jpg');
      expect(datePathScore).toBeGreaterThan(flatScore);
    });

    it('penalises deeply nested keys', () => {
      const shallow = scoreKeyForKeep('2020/03/15/photo.jpg');
      const deep = scoreKeyForKeep('backup/archive/old/2020/03/15/subfolder/photo.jpg');
      expect(shallow).toBeGreaterThan(deep);
    });

    it('returns positive score for standard date-path keys', () => {
      expect(scoreKeyForKeep('2020/01/01/img.jpg')).toBeGreaterThan(0);
    });

    it('returns lower score for non-date paths', () => {
      expect(scoreKeyForKeep('random/folder/img.jpg')).toBeLessThan(
        scoreKeyForKeep('2020/01/01/img.jpg'),
      );
    });
  });

  describe('buildDuplicateGroups', () => {
    it('returns empty array when no duplicates', () => {
      const objects = [
        { key: '2020/01/01/a.jpg', size: 100, etag: 'aaa' },
        { key: '2020/01/02/b.jpg', size: 200, etag: 'bbb' },
        { key: '2020/01/03/c.jpg', size: 300, etag: 'ccc' },
      ];
      expect(buildDuplicateGroups(objects)).toEqual([]);
    });

    it('groups duplicates by size + etag', () => {
      const objects = [
        { key: '2020/01/01/a.jpg', size: 100, etag: 'aaa' },
        { key: '2021/06/15/a_copy.jpg', size: 100, etag: 'aaa' },
        { key: '2020/01/02/b.jpg', size: 200, etag: 'bbb' },
      ];
      const groups = buildDuplicateGroups(objects);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.duplicateKeys).toHaveLength(1);
    });

    it('keeps the key with proper date path', () => {
      const objects = [
        { key: 'archive/flat/photo.jpg', size: 500, etag: 'eee' },
        { key: '2020/03/15/photo.jpg', size: 500, etag: 'eee' },
      ];
      const groups = buildDuplicateGroups(objects);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.keepKey).toBe('2020/03/15/photo.jpg');
      expect(groups[0]!.duplicateKeys).toEqual(['archive/flat/photo.jpg']);
    });

    it('handles triple duplicates — keeps one, removes two', () => {
      const objects = [
        { key: 'backup/old/photo.jpg', size: 1000, etag: 'fff' },
        { key: '2020/06/01/photo.jpg', size: 1000, etag: 'fff' },
        { key: 'archive/2020/photo.jpg', size: 1000, etag: 'fff' },
      ];
      const groups = buildDuplicateGroups(objects);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.keepKey).toBe('2020/06/01/photo.jpg');
      expect(groups[0]!.duplicateKeys).toHaveLength(2);
    });

    it('does not group items with same size but different etag', () => {
      const objects = [
        { key: '2020/01/01/a.jpg', size: 100, etag: 'aaa' },
        { key: '2020/01/02/b.jpg', size: 100, etag: 'bbb' },
      ];
      expect(buildDuplicateGroups(objects)).toEqual([]);
    });

    it('does not group items with same etag but different size', () => {
      const objects = [
        { key: '2020/01/01/a.jpg', size: 100, etag: 'aaa' },
        { key: '2020/01/02/b.jpg', size: 200, etag: 'aaa' },
      ];
      expect(buildDuplicateGroups(objects)).toEqual([]);
    });

    it('sorts groups by bytes wasted descending', () => {
      const objects = [
        // group A: 1 dup × 100 = 100 bytes wasted
        { key: '2020/01/01/small.jpg', size: 100, etag: 'aaa' },
        { key: '2020/01/02/small_copy.jpg', size: 100, etag: 'aaa' },
        // group B: 1 dup × 5000 = 5000 bytes wasted
        { key: '2020/01/01/big.mp4', size: 5000, etag: 'bbb' },
        { key: '2020/01/02/big_copy.mp4', size: 5000, etag: 'bbb' },
      ];
      const groups = buildDuplicateGroups(objects);
      expect(groups).toHaveLength(2);
      expect(groups[0]!.size).toBe(5000);
      expect(groups[1]!.size).toBe(100);
    });

    it('uses lexicographic order as tiebreaker when scores are equal', () => {
      const objects = [
        { key: '2020/01/01/z_photo.jpg', size: 100, etag: 'aaa' },
        { key: '2020/01/01/a_photo.jpg', size: 100, etag: 'aaa' },
      ];
      const groups = buildDuplicateGroups(objects);
      expect(groups).toHaveLength(1);
      // Both have same date path score, so lexicographically smaller wins
      expect(groups[0]!.keepKey).toBe('2020/01/01/a_photo.jpg');
      expect(groups[0]!.duplicateKeys).toEqual(['2020/01/01/z_photo.jpg']);
    });

    it('handles multiple independent duplicate groups', () => {
      const objects = [
        { key: '2020/01/01/a.jpg', size: 100, etag: 'aaa' },
        { key: '2020/01/02/a_copy.jpg', size: 100, etag: 'aaa' },
        { key: '2020/03/01/b.mp4', size: 2000, etag: 'bbb' },
        { key: '2020/03/02/b_copy.mp4', size: 2000, etag: 'bbb' },
        { key: '2020/05/01/c.png', size: 500, etag: 'ccc' }, // unique
      ];
      const groups = buildDuplicateGroups(objects);
      expect(groups).toHaveLength(2);
      const allDupKeys = groups.flatMap((g) => g.duplicateKeys);
      expect(allDupKeys).not.toContain('2020/05/01/c.png');
    });

    it('handles empty input', () => {
      expect(buildDuplicateGroups([])).toEqual([]);
    });
  });

  describe('findDuplicates', () => {
    it('returns duplicate groups from S3 listing', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc123"' },
          { Key: '2021/06/15/a_copy.jpg', Size: 100, LastModified: new Date('2021-06-15'), ETag: '"abc123"' },
          { Key: '2020/01/02/b.mp4', Size: 5000, LastModified: new Date('2020-01-02'), ETag: '"def456"' },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const groups = await service.findDuplicates();
      expect(groups).toHaveLength(1);
      expect(groups[0]!.duplicateKeys).toHaveLength(1);
      expect(groups[0]!.size).toBe(100);
    });

    it('returns empty when no duplicates exist', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"aaa"' },
          { Key: '2020/01/02/b.jpg', Size: 200, LastModified: new Date('2020-01-02'), ETag: '"bbb"' },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const groups = await service.findDuplicates();
      expect(groups).toEqual([]);
    });

    it('handles pagination when scanning for duplicates', async () => {
      let callCount = 0;
      const send = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            Contents: [
              { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc"' },
            ],
            IsTruncated: true,
            NextContinuationToken: 'tok1',
          };
        }
        return {
          Contents: [
            { Key: '2021/06/15/a_copy.jpg', Size: 100, LastModified: new Date('2021-06-15'), ETag: '"abc"' },
          ],
          IsTruncated: false,
        };
      });

      const service = makeService(send);
      const groups = await service.findDuplicates();
      expect(groups).toHaveLength(1);
      expect(callCount).toBe(2);
    });

    it('skips objects without ETag', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc"' },
          { Key: '2020/01/02/b.jpg', Size: 100, LastModified: new Date('2020-01-02') }, // no ETag
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const groups = await service.findDuplicates();
      expect(groups).toEqual([]);
    });

    it('normalizes etag quotes for comparison', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc123"' },
          { Key: '2020/01/02/a_dup.jpg', Size: 100, LastModified: new Date('2020-01-02'), ETag: 'abc123' },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const groups = await service.findDuplicates();
      // Should match since ETags are the same after normalization
      expect(groups).toHaveLength(1);
    });

    it('filters non-media files from duplicate detection', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '_albums.json', Size: 50, LastModified: new Date('2024-01-01'), ETag: '"json1"' },
          { Key: 'readme.txt', Size: 50, LastModified: new Date('2024-01-01'), ETag: '"json1"' },
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"img1"' },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const groups = await service.findDuplicates();
      // Non-media files with same size+etag should not be grouped
      expect(groups).toEqual([]);
    });
  });

  describe('deduplicateObjects', () => {
    function makeDedupSend(contentsList: any[]) {
      return vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'ListObjectsV2Command') {
          return {
            Contents: contentsList,
            IsTruncated: false,
          };
        }
        if (name === 'DeleteObjectsCommand') {
          const objects = cmd.input?.Delete?.Objects ?? [];
          return {
            Deleted: objects.map((o: any) => ({ Key: o.Key })),
            Errors: [],
          };
        }
        return {};
      });
    }

    it('dry run returns groups without deleting', async () => {
      const send = makeDedupSend([
        { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc"' },
        { Key: '2021/06/15/a_copy.jpg', Size: 100, LastModified: new Date('2021-06-15'), ETag: '"abc"' },
      ]);

      const service = makeService(send);
      const result = await service.deduplicateObjects({ dryRun: true });

      expect(result.groups).toHaveLength(1);
      expect(result.totalDuplicates).toBe(1);
      expect(result.bytesFreed).toBe(100);
      expect(result.deleteResult).toBeUndefined();
      // Should not have called DeleteObjectsCommand
      const deleteCall = send.mock.calls.find(
        (call: any) => call[0]?.constructor?.name === 'DeleteObjectsCommand',
      );
      expect(deleteCall).toBeUndefined();
    });

    it('actual run deletes duplicates and returns results', async () => {
      const send = makeDedupSend([
        { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc"' },
        { Key: 'archive/a_copy.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc"' },
      ]);

      const service = makeService(send);
      const result = await service.deduplicateObjects({ dryRun: false });

      expect(result.totalDuplicates).toBe(1);
      expect(result.bytesFreed).toBe(100);
      expect(result.deleteResult).toBeDefined();
      expect(result.deleteResult!.deleted).toHaveLength(1);
      expect(result.deleteResult!.failed).toHaveLength(0);
    });

    it('defaults to dry run when no options provided', async () => {
      const send = makeDedupSend([
        { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc"' },
        { Key: '2021/06/15/a_copy.jpg', Size: 100, LastModified: new Date('2021-06-15'), ETag: '"abc"' },
      ]);

      const service = makeService(send);
      const result = await service.deduplicateObjects();

      expect(result.deleteResult).toBeUndefined();
    });

    it('returns zero counts when no duplicates found', async () => {
      const send = makeDedupSend([
        { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"aaa"' },
        { Key: '2020/01/02/b.jpg', Size: 200, LastModified: new Date('2020-01-02'), ETag: '"bbb"' },
      ]);

      const service = makeService(send);
      const result = await service.deduplicateObjects({ dryRun: false });

      expect(result.groups).toHaveLength(0);
      expect(result.totalDuplicates).toBe(0);
      expect(result.bytesFreed).toBe(0);
      // No deleteResult because nothing to delete
      expect(result.deleteResult).toBeUndefined();
    });

    it('handles multiple duplicate groups in one pass', async () => {
      const send = makeDedupSend([
        { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"aaa"' },
        { Key: '2020/02/01/a_dup.jpg', Size: 100, LastModified: new Date('2020-02-01'), ETag: '"aaa"' },
        { Key: '2020/03/01/b.mp4', Size: 5000, LastModified: new Date('2020-03-01'), ETag: '"bbb"' },
        { Key: '2020/04/01/b_dup.mp4', Size: 5000, LastModified: new Date('2020-04-01'), ETag: '"bbb"' },
        { Key: '2020/04/01/b_dup2.mp4', Size: 5000, LastModified: new Date('2020-04-01'), ETag: '"bbb"' },
      ]);

      const service = makeService(send);
      const result = await service.deduplicateObjects({ dryRun: false });

      expect(result.groups).toHaveLength(2);
      expect(result.totalDuplicates).toBe(3); // 1 + 2
      expect(result.bytesFreed).toBe(100 + 5000 * 2);
      expect(result.deleteResult!.deleted).toHaveLength(3);
    });

    it('invalidates stats cache after dedup deletion', async () => {
      let listCallCount = 0;
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'ListObjectsV2Command') {
          listCallCount++;
          return {
            Contents: [
              { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc"' },
              { Key: '2020/02/01/a_dup.jpg', Size: 100, LastModified: new Date('2020-02-01'), ETag: '"abc"' },
            ],
            IsTruncated: false,
          };
        }
        if (name === 'DeleteObjectsCommand') {
          return {
            Deleted: (cmd.input?.Delete?.Objects ?? []).map((o: any) => ({ Key: o.Key })),
            Errors: [],
          };
        }
        return {};
      });

      const service = makeService(send);
      // Prime stats cache
      await service.getStats();
      const countAfterPrime = listCallCount;

      // Dedup should invalidate cache via internal deleteObjects
      await service.deduplicateObjects({ dryRun: false });

      // getStats should re-fetch
      await service.getStats();
      expect(listCallCount).toBeGreaterThan(countAfterPrime + 1); // +1 for findDuplicates, +1 for re-fetch
    });
  });

  // ── _thumbs prefix exclusion ────────────────────────────────────────────

  describe('_thumbs exclusion', () => {
    it('excludes _thumbs items from listPage', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
          { Key: '_thumbs/small/2020/01/01/a.jpg.jpg', Size: 5, LastModified: new Date('2020-01-01') },
          { Key: '_thumbs/large/2020/01/01/a.jpg.jpg', Size: 20, LastModified: new Date('2020-01-01') },
          { Key: '2021/06/15/b.mp4', Size: 300, LastModified: new Date('2021-06-15') },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const page = await service.listPage({ max: 10 });
      expect(page.items).toHaveLength(2);
      expect(page.items.map((i) => i.key)).toEqual(
        expect.arrayContaining(['2020/01/01/a.jpg', '2021/06/15/b.mp4']),
      );
    });

    it('excludes _thumbs items from listAll', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
          { Key: '_thumbs/small/2020/01/01/a.jpg.jpg', Size: 5, LastModified: new Date('2020-01-01') },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const items = await service.listAll();
      expect(items).toHaveLength(1);
      expect(items[0]?.key).toBe('2020/01/01/a.jpg');
    });

    it('excludes _thumbs items from listUndated', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: 'unknown-date/a.jpg', Size: 100, LastModified: new Date('2024-03-01') },
          { Key: '_thumbs/small/unknown-date/a.jpg.jpg', Size: 5, LastModified: new Date('2024-03-01') },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const items = await service.listUndated();
      expect(items).toHaveLength(1);
      expect(items[0]?.key).toBe('unknown-date/a.jpg');
    });

    it('excludes _thumbs items from findDuplicates', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc"' },
          { Key: '_thumbs/small/2020/01/01/a.jpg.jpg', Size: 100, LastModified: new Date('2020-01-01'), ETag: '"abc"' },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const groups = await service.findDuplicates();
      // Only one real media item — no duplicate pair should form with the _thumbs entry
      expect(groups).toHaveLength(0);
    });

    it('excludes _thumbs from getStats counts', async () => {
      const send = vi.fn(async () => ({
        Contents: [
          { Key: '2020/01/01/a.jpg', Size: 100, LastModified: new Date('2020-01-01') },
          { Key: '_thumbs/small/2020/01/01/a.jpg.jpg', Size: 5, LastModified: new Date('2020-01-01') },
          { Key: '2020/01/01/b.mp4', Size: 300, LastModified: new Date('2020-01-01') },
        ],
        IsTruncated: false,
      }));

      const service = makeService(send);
      const stats = await service.getStats();
      expect(stats.totalFiles).toBe(2);
      expect(stats.imageCount).toBe(1);
      expect(stats.videoCount).toBe(1);
      expect(stats.totalBytes).toBe(400); // 100 + 300, not 405
    });
  });

  // ── S3 thumbnail persistence ────────────────────────────────────────────

  describe('S3 thumbnail persistence', () => {
    it('persists generated thumbnail to S3 on first request', async () => {
      const calls: { name: string; key?: string }[] = [];
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        calls.push({ name, key: cmd.input?.Key });
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          // S3 thumb doesn't exist yet
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        if (name === 'GetObjectCommand') {
          // Return original image
          return {
            Body: Readable.from([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])]), // minimal JPEG start
          };
        }
        if (name === 'PutObjectCommand') {
          return {}; // successful persist
        }
        return {};
      });

      const service = makeService(send);
      // This will fail at Sharp processing since we use a fake JPEG,
      // but we can test the S3 interaction pattern
      try {
        await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');
      } catch {
        // Sharp will reject the fake JPEG — that's fine
      }

      // Should have tried: 1) S3 thumb lookup (NoSuchKey), 2) original fetch
      const getCommands = calls.filter((c) => c.name === 'GetObjectCommand');
      expect(getCommands).toHaveLength(2);
      expect(getCommands[0]?.key).toContain('_thumbs/small/');
      expect(getCommands[1]?.key).toBe('2020/01/01/a.jpg');
    });

    it('returns persisted thumbnail from S3 without generating', async () => {
      const thumbJpeg = Buffer.from('fake-persisted-thumbnail');
      const calls: { name: string; key?: string }[] = [];
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        calls.push({ name, key: cmd.input?.Key });
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          // Return persisted thumbnail
          return { Body: Readable.from([thumbJpeg]) };
        }
        // Should NOT reach here — original should not be fetched
        return {};
      });

      const service = makeService(send);
      const result = await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');

      // Only one S3 call — the thumb fetch. No original file fetched.
      expect(calls.filter((c) => c.name === 'GetObjectCommand')).toHaveLength(1);
      expect(calls[0]?.key).toContain('_thumbs/small/');
      expect(result.contentType).toBe('image/jpeg');
      expect(result.buffer).toEqual(thumbJpeg);
    });

    it('uses LRU cache before checking S3', async () => {
      const thumbJpeg = Buffer.from('fake-persisted-thumbnail');
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          return { Body: Readable.from([thumbJpeg]) };
        }
        return {};
      });

      const service = makeService(send);
      // First call — populates LRU from S3
      await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');
      expect(send).toHaveBeenCalledTimes(1);

      // Second call — should come from LRU, no S3 call
      const result = await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');
      expect(send).toHaveBeenCalledTimes(1); // still 1
      expect(result.buffer).toEqual(thumbJpeg);
    });

    it('deleteObjects also deletes persisted thumbnails', async () => {
      const deletedKeys: string[] = [];
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'DeleteObjectsCommand') {
          const objects = cmd.input?.Delete?.Objects ?? [];
          for (const o of objects) {
            deletedKeys.push(o.Key);
          }
          return {
            Deleted: objects.map((o: any) => ({ Key: o.Key })),
            Errors: [],
          };
        }
        return {};
      });

      const service = makeService(send);
      await service.deleteObjects([encodeKey('2020/01/01/a.jpg')]);

      // The first DeleteObjects call is for the media file itself.
      // Then fire-and-forget deletes both thumb sizes.
      // Wait for fire-and-forget to complete.
      await new Promise((r) => setTimeout(r, 50));

      const thumbKeys = deletedKeys.filter((k) => k.includes('_thumbs/'));
      expect(thumbKeys).toHaveLength(2);
      expect(thumbKeys).toEqual(
        expect.arrayContaining([
          expect.stringContaining('_thumbs/small/'),
          expect.stringContaining('_thumbs/large/'),
        ]),
      );
    });

    it('moveObject deletes old persisted thumbnails', async () => {
      const deletedKeys: string[] = [];
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'DeleteObjectsCommand') {
          const objects = cmd.input?.Delete?.Objects ?? [];
          for (const o of objects) deletedKeys.push(o.Key);
          return { Deleted: objects.map((o: any) => ({ Key: o.Key })), Errors: [] };
        }
        return {};
      });

      const service = makeService(send);
      await service.moveObject(encodeKey('2026/02/24/photo.jpg'), '2020/03/15');

      // Wait for fire-and-forget thumbnail cleanup
      await new Promise((r) => setTimeout(r, 50));

      const thumbKeys = deletedKeys.filter((k) => k.includes('_thumbs/'));
      expect(thumbKeys).toHaveLength(2);
      expect(thumbKeys).toEqual(
        expect.arrayContaining([
          expect.stringContaining('_thumbs/small/2026/02/24/photo.jpg'),
          expect.stringContaining('_thumbs/large/2026/02/24/photo.jpg'),
        ]),
      );
    });

    it('bubbles unexpected S3 errors during thumb check', async () => {
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          const err = new Error('InternalError');
          err.name = 'InternalError';
          throw err;
        }
        return {};
      });

      const service = makeService(send);
      await expect(
        service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small'),
      ).rejects.toThrow('InternalError');
    });
  });

  // ── Disk thumbnail cache ────────────────────────────────────────────────

  describe('DiskThumbnailCache', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = path.join(tmpdir(), `thumb-test-${randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns null for cache miss', async () => {
      const cache = new DiskThumbnailCache(tmpDir);
      const result = await cache.get('2020/01/01/photo.jpg', 'small');
      expect(result).toBeNull();
    });

    it('stores and retrieves a thumbnail', async () => {
      const cache = new DiskThumbnailCache(tmpDir);
      const data = Buffer.from('fake-thumbnail-jpeg');
      cache.set('2020/01/01/photo.jpg', 'small', data);
      // Wait for fire-and-forget write
      await new Promise((r) => setTimeout(r, 100));
      const result = await cache.get('2020/01/01/photo.jpg', 'small');
      expect(result).toEqual(data);
    });

    it('stores small and large independently', async () => {
      const cache = new DiskThumbnailCache(tmpDir);
      const small = Buffer.from('small-thumb');
      const large = Buffer.from('large-thumb');
      cache.set('photo.jpg', 'small', small);
      cache.set('photo.jpg', 'large', large);
      await new Promise((r) => setTimeout(r, 100));
      expect(await cache.get('photo.jpg', 'small')).toEqual(small);
      expect(await cache.get('photo.jpg', 'large')).toEqual(large);
    });

    it('deleteForKeys removes both sizes', async () => {
      const cache = new DiskThumbnailCache(tmpDir);
      cache.set('2020/01/01/a.jpg', 'small', Buffer.from('s'));
      cache.set('2020/01/01/a.jpg', 'large', Buffer.from('l'));
      await new Promise((r) => setTimeout(r, 100));

      // Verify they exist
      expect(await cache.get('2020/01/01/a.jpg', 'small')).not.toBeNull();
      expect(await cache.get('2020/01/01/a.jpg', 'large')).not.toBeNull();

      // Delete
      cache.deleteForKeys(['2020/01/01/a.jpg']);
      await new Promise((r) => setTimeout(r, 100));

      // Both should be gone
      expect(await cache.get('2020/01/01/a.jpg', 'small')).toBeNull();
      expect(await cache.get('2020/01/01/a.jpg', 'large')).toBeNull();
    });

    it('deleteForKeys does not affect other keys', async () => {
      const cache = new DiskThumbnailCache(tmpDir);
      cache.set('keep.jpg', 'small', Buffer.from('keep'));
      cache.set('delete.jpg', 'small', Buffer.from('delete'));
      await new Promise((r) => setTimeout(r, 100));

      cache.deleteForKeys(['delete.jpg']);
      await new Promise((r) => setTimeout(r, 100));

      expect(await cache.get('keep.jpg', 'small')).toEqual(Buffer.from('keep'));
      expect(await cache.get('delete.jpg', 'small')).toBeNull();
    });

    it('deleteForKeys is safe for non-existent keys', async () => {
      const cache = new DiskThumbnailCache(tmpDir);
      // Should not throw
      cache.deleteForKeys(['never-existed.jpg']);
      await new Promise((r) => setTimeout(r, 50));
    });

    it('overwrite replaces cached data', async () => {
      const cache = new DiskThumbnailCache(tmpDir);
      cache.set('photo.jpg', 'small', Buffer.from('original'));
      await new Promise((r) => setTimeout(r, 100));
      cache.set('photo.jpg', 'small', Buffer.from('updated'));
      await new Promise((r) => setTimeout(r, 100));
      const result = await cache.get('photo.jpg', 'small');
      expect(result).toEqual(Buffer.from('updated'));
    });

    it('uses different on-disk paths for different S3 keys', async () => {
      const cache = new DiskThumbnailCache(tmpDir);
      cache.set('2020/01/01/a.jpg', 'small', Buffer.from('a'));
      cache.set('2021/06/15/b.jpg', 'small', Buffer.from('b'));
      await new Promise((r) => setTimeout(r, 100));
      expect(await cache.get('2020/01/01/a.jpg', 'small')).toEqual(Buffer.from('a'));
      expect(await cache.get('2021/06/15/b.jpg', 'small')).toEqual(Buffer.from('b'));
    });
  });

  // ── Disk cache integration with getThumbnail ────────────────────────────

  describe('disk cache integration', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = path.join(tmpdir(), `thumb-int-${randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    function makeServiceWithDisk(send: ReturnType<typeof vi.fn>) {
      return new ScalewayCatalogService(
        { region: 'nl-ams', bucket: 'media', accessKey: 'access', secretKey: 'secret', thumbCacheDir: tmpDir },
        { send } as any,
      );
    }

    it('disk cache hit avoids S3 completely', async () => {
      // Pre-populate disk cache
      const diskCache = new DiskThumbnailCache(tmpDir);
      const thumbData = Buffer.from('cached-on-disk');
      diskCache.set('2020/01/01/a.jpg', 'small', thumbData);
      await new Promise((r) => setTimeout(r, 100));

      const send = vi.fn();
      const service = makeServiceWithDisk(send);
      const result = await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');

      expect(result.buffer).toEqual(thumbData);
      expect(result.contentType).toBe('image/jpeg');
      // No S3 calls at all
      expect(send).not.toHaveBeenCalled();
    });

    it('S3 hit backfills disk cache', async () => {
      const thumbJpeg = Buffer.from('s3-persisted-thumbnail');
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          return { Body: Readable.from([thumbJpeg]) };
        }
        return {};
      });

      const service = makeServiceWithDisk(send);
      await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');

      // Wait for fire-and-forget disk write
      await new Promise((r) => setTimeout(r, 150));

      // Verify disk was populated
      const diskCache = new DiskThumbnailCache(tmpDir);
      const diskHit = await diskCache.get('2020/01/01/a.jpg', 'small');
      expect(diskHit).toEqual(thumbJpeg);
    });

    it('second request after LRU eviction hits disk instead of S3', async () => {
      const thumbJpeg = Buffer.from('s3-persisted-thumbnail');
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          return { Body: Readable.from([thumbJpeg]) };
        }
        return {};
      });

      const service = makeServiceWithDisk(send);

      // First request — hits S3, backfills disk
      await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');
      expect(send).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 150));

      // Fill LRU cache with other entries to evict our entry
      for (let i = 0; i < 501; i++) {
        const fakeSend = vi.fn(async (cmd: any) => {
          const name = cmd.constructor?.name ?? '';
          if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
            return { Body: Readable.from([Buffer.from(`thumb-${i}`)]) };
          }
          return {};
        });
        const tempService = makeServiceWithDisk(fakeSend);
        // We can't easily evict from the same service's LRU, so instead
        // create a fresh service that shares the same disk cache dir
        // but has an empty LRU
        break;
      }

      // Create a fresh service (empty LRU) sharing the same disk dir
      const send2 = vi.fn();
      const service2 = makeServiceWithDisk(send2);
      const result2 = await service2.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');

      // Should serve from disk, no S3 calls
      expect(send2).not.toHaveBeenCalled();
      expect(result2.buffer).toEqual(thumbJpeg);
    });

    it('deleteObjects clears disk cache for deleted items', async () => {
      // Pre-populate disk cache
      const diskCache = new DiskThumbnailCache(tmpDir);
      diskCache.set('2020/01/01/a.jpg', 'small', Buffer.from('cached'));
      diskCache.set('2020/01/01/a.jpg', 'large', Buffer.from('cached-large'));
      await new Promise((r) => setTimeout(r, 100));

      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'DeleteObjectsCommand') {
          const objects = cmd.input?.Delete?.Objects ?? [];
          return {
            Deleted: objects.map((o: any) => ({ Key: o.Key })),
            Errors: [],
          };
        }
        return {};
      });

      const service = makeServiceWithDisk(send);
      await service.deleteObjects([encodeKey('2020/01/01/a.jpg')]);

      // Wait for fire-and-forget operations
      await new Promise((r) => setTimeout(r, 150));

      // Disk cache should be empty for both sizes
      expect(await diskCache.get('2020/01/01/a.jpg', 'small')).toBeNull();
      expect(await diskCache.get('2020/01/01/a.jpg', 'large')).toBeNull();
    });

    it('moveObject clears disk cache for old key', async () => {
      // Pre-populate disk cache for old key
      const diskCache = new DiskThumbnailCache(tmpDir);
      diskCache.set('2020/01/01/photo.jpg', 'small', Buffer.from('old-thumb'));
      diskCache.set('2020/01/01/photo.jpg', 'large', Buffer.from('old-thumb-lg'));
      await new Promise((r) => setTimeout(r, 100));

      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'DeleteObjectsCommand') {
          return { Deleted: [], Errors: [] };
        }
        return {};
      });

      const service = makeServiceWithDisk(send);
      await service.moveObject(encodeKey('2020/01/01/photo.jpg'), '2021/06/15');

      await new Promise((r) => setTimeout(r, 150));

      // Old key's disk cache should be cleaned
      expect(await diskCache.get('2020/01/01/photo.jpg', 'small')).toBeNull();
      expect(await diskCache.get('2020/01/01/photo.jpg', 'large')).toBeNull();
    });

    it('delete then re-request does not serve stale disk cache', async () => {
      // Pre-populate disk cache
      const diskCache = new DiskThumbnailCache(tmpDir);
      diskCache.set('2020/01/01/a.jpg', 'small', Buffer.from('will-be-deleted'));
      await new Promise((r) => setTimeout(r, 100));

      // Delete the object
      const deleteSend = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'DeleteObjectsCommand') {
          const objects = cmd.input?.Delete?.Objects ?? [];
          return { Deleted: objects.map((o: any) => ({ Key: o.Key })), Errors: [] };
        }
        return {};
      });

      const service = makeServiceWithDisk(deleteSend);
      await service.deleteObjects([encodeKey('2020/01/01/a.jpg')]);
      await new Promise((r) => setTimeout(r, 150));

      // Now try to get thumbnail — should NOT return the old cached data
      // Instead it should reach S3 (which won't have it either)
      const fetchSend = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        if (name === 'GetObjectCommand') {
          // Return original for re-generation
          return {
            Body: Readable.from([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])]),
          };
        }
        return {};
      });

      const service2 = makeServiceWithDisk(fetchSend);
      try {
        await service2.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');
      } catch {
        // Sharp will reject fake JPEG — that's fine
      }

      // Key point: the disk cache should NOT have served stale data.
      // The service should have gone to S3 (fetchSend should have been called).
      expect(fetchSend).toHaveBeenCalled();
      // Specifically, should try the _thumbs/ S3 lookup since disk was empty
      const s3ThumbCall = fetchSend.mock.calls.find(
        (call: any) => call[0]?.constructor?.name === 'GetObjectCommand' &&
          call[0]?.input?.Key?.includes('_thumbs/'),
      );
      expect(s3ThumbCall).toBeDefined();
    });

    it('deleteObjects also evicts from LRU cache', async () => {
      const thumbJpeg = Buffer.from('lru-cached-thumbnail');
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          return { Body: Readable.from([thumbJpeg]) };
        }
        if (name === 'DeleteObjectsCommand') {
          const objects = cmd.input?.Delete?.Objects ?? [];
          return { Deleted: objects.map((o: any) => ({ Key: o.Key })), Errors: [] };
        }
        return {};
      });

      const service = makeServiceWithDisk(send);

      // Populate LRU + disk
      await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');
      expect(send).toHaveBeenCalledTimes(1);

      // Second call — LRU hit, no S3
      await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');
      expect(send).toHaveBeenCalledTimes(1);

      // Wait for fire-and-forget disk write to complete before deleting,
      // otherwise the async unlink may race with the async write.
      await new Promise((r) => setTimeout(r, 100));

      // Delete
      await service.deleteObjects([encodeKey('2020/01/01/a.jpg')]);
      await new Promise((r) => setTimeout(r, 150));

      // Reset send mock with new behavior
      send.mockClear();
      send.mockImplementation(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        if (name === 'GetObjectCommand') {
          return { Body: Readable.from([Buffer.from([0xFF, 0xD8])]) };
        }
        return {};
      });

      // LRU should be evicted — next call should hit disk/S3
      try {
        await service.getThumbnail(encodeKey('2020/01/01/a.jpg'), 'small');
      } catch {
        // Sharp rejects fake JPEG
      }

      // Should have made S3 calls (LRU was evicted, disk was cleared)
      expect(send).toHaveBeenCalled();
    });
  });

  // ── Video thumbnail Range request ──────────────────────────────────────────

  describe('video thumbnail Range request', () => {
    it('exports VIDEO_THUMB_RANGE_BYTES as 10MB', () => {
      expect(VIDEO_THUMB_RANGE_BYTES).toBe(10 * 1024 * 1024);
    });

    it('sends Range header for video thumbnail fetch', async () => {
      const calls: { name: string; key?: string; range?: string }[] = [];
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        calls.push({ name, key: cmd.input?.Key, range: cmd.input?.Range });
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          // No persisted thumbnail
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        if (name === 'GetObjectCommand' && cmd.input?.Range) {
          // Range request for partial video - return a small chunk
          return {
            Body: Readable.from([Buffer.alloc(100)]),
          };
        }
        if (name === 'GetObjectCommand') {
          // Full fetch fallback
          return {
            Body: Readable.from([Buffer.alloc(100)]),
          };
        }
        return {};
      });

      const service = makeService(send);
      try {
        await service.getThumbnail(encodeKey('2020/01/01/video.mp4'), 'small');
      } catch {
        // ffmpeg not available / fake data — that's expected
      }

      // Should see: 1) S3 _thumbs lookup (404), 2) Range GET for partial video
      const gets = calls.filter((c) => c.name === 'GetObjectCommand');
      expect(gets.length).toBeGreaterThanOrEqual(2);
      // First GET: thumbnail lookup
      expect(gets[0]?.key).toContain('_thumbs/small/');
      // Second GET: Range request for video
      expect(gets[1]?.range).toBe(`bytes=0-${VIDEO_THUMB_RANGE_BYTES - 1}`);
    });

    it('falls back to full video download if Range request fails', async () => {
      const calls: { name: string; key?: string; range?: string }[] = [];
      const send = vi.fn(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        calls.push({ name, key: cmd.input?.Key, range: cmd.input?.Range });
        if (name === 'GetObjectCommand' && cmd.input?.Key?.includes('_thumbs/')) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        if (name === 'GetObjectCommand' && cmd.input?.Range) {
          // Range request fails (e.g., provider doesn't support it)
          throw new Error('Range not supported');
        }
        if (name === 'GetObjectCommand') {
          // Full fetch
          return {
            Body: Readable.from([Buffer.alloc(100)]),
          };
        }
        return {};
      });

      const service = makeService(send);
      try {
        await service.getThumbnail(encodeKey('2020/01/01/video.mov'), 'small');
      } catch {
        // ffmpeg not available — that's expected
      }

      // Should see: 1) thumb lookup (404), 2) Range GET (fail), 3) full GET
      const gets = calls.filter((c) => c.name === 'GetObjectCommand');
      expect(gets.length).toBeGreaterThanOrEqual(3);
      expect(gets[1]?.range).toBe(`bytes=0-${VIDEO_THUMB_RANGE_BYTES - 1}`);
      // Third GET: full file (no Range)
      expect(gets[2]?.range).toBeUndefined();
    });
  });
});
