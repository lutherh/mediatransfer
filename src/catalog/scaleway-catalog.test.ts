import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  ScalewayCatalogService,
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
});
