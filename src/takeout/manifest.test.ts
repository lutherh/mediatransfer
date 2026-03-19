import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  buildManifest,
  deduplicateManifest,
  partialFileHash,
  persistManifestJsonl,
  scoreEntryForKeep,
  type ManifestEntry,
} from './manifest.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mediatransfer-manifest-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('takeout/manifest', () => {
  it('builds deterministic manifest entries sorted by relative path', async () => {
    await withTempDir(async (dir) => {
      const mediaRoot = path.join(dir, 'Google Photos');
      await fs.mkdir(path.join(mediaRoot, 'B'), { recursive: true });
      await fs.mkdir(path.join(mediaRoot, 'A'), { recursive: true });

      await fs.writeFile(path.join(mediaRoot, 'B', 'IMG_2.jpg'), 'b');
      await fs.writeFile(path.join(mediaRoot, 'A', 'IMG_1.jpg'), 'a');

      const manifest = await buildManifest(mediaRoot);
      expect(manifest.map((entry) => entry.relativePath)).toEqual([
        'A/IMG_1.jpg',
        'B/IMG_2.jpg',
      ]);
    });
  });

  it('prefers sidecar timestamp for date path', async () => {
    await withTempDir(async (dir) => {
      const mediaRoot = path.join(dir, 'Google Photos', 'Album1');
      await fs.mkdir(mediaRoot, { recursive: true });

      const mediaPath = path.join(mediaRoot, 'IMG_6163.HEIC');
      await fs.writeFile(mediaPath, 'img');
      await fs.writeFile(
        `${mediaPath}.json`,
        JSON.stringify({
          photoTakenTime: {
            timestamp: '1765584000', // 2025-12-13T00:00:00Z
          },
        }),
      );

      const [entry] = await buildManifest(path.join(dir, 'Google Photos'));
      expect(entry.datePath).toBe('2025/12/13');
      expect(entry.destinationKey).toContain('transfers/2025/12/13/');
      expect(entry.sidecarPath).toBe(`${mediaPath}.json`);
    });
  });

  it('uses EXIF date when sidecar and filename date are unavailable', async () => {
    await withTempDir(async (dir) => {
      const mediaRoot = path.join(dir, 'Google Photos', 'Album2');
      await fs.mkdir(mediaRoot, { recursive: true });

      // Minimal JPEG with EXIF DateTimeOriginal = "2019:07:15 14:30:00"
      // Filename has no date pattern, no sidecar — should fall through to EXIF
      const jpeg = Buffer.from([
        0xFF, 0xD8,                                           // SOI
        0xFF, 0xE1, 0x00, 0x48,                               // APP1 marker + length
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00,                   // "Exif\0\0"
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,       // TIFF LE header, IFD0 at 8
        0x01, 0x00,                                           // IFD0: 1 entry
        0x69, 0x87, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00,       //   ExifIFD tag, LONG, count=1
        0x1A, 0x00, 0x00, 0x00,                               //   value: offset 26
        0x00, 0x00, 0x00, 0x00,                               // next IFD: none
        0x01, 0x00,                                           // ExifIFD: 1 entry
        0x03, 0x90, 0x02, 0x00, 0x14, 0x00, 0x00, 0x00,       //   DateTimeOriginal, ASCII, 20 chars
        0x2C, 0x00, 0x00, 0x00,                               //   value: offset 44
        0x00, 0x00, 0x00, 0x00,                               // next IFD: none
        ...Buffer.from('2019:07:15 14:30:00\0'),               // DateTimeOriginal value
        0xFF, 0xD9,                                           // EOI
      ]);

      const mediaPath = path.join(mediaRoot, 'random.jpg');
      await fs.writeFile(mediaPath, jpeg);

      // Set mtime to a wrong date to confirm EXIF wins
      const wrongDate = new Date('2026-02-01T00:00:00Z');
      await fs.utimes(mediaPath, wrongDate, wrongDate);

      const [entry] = await buildManifest(path.join(dir, 'Google Photos'));
      expect(entry.datePath).toBe('2019/07/15');
    });
  });

  it('falls back to file mtime when sidecar, filename, and EXIF are all unavailable', async () => {
    await withTempDir(async (dir) => {
      const mediaRoot = path.join(dir, 'Google Photos', 'Album2');
      await fs.mkdir(mediaRoot, { recursive: true });

      const mediaPath = path.join(mediaRoot, 'VID_0001.mp4');
      await fs.writeFile(mediaPath, 'vid');

      const fallback = new Date('2024-03-09T10:20:30Z');
      await fs.utimes(mediaPath, fallback, fallback);

      const [entry] = await buildManifest(path.join(dir, 'Google Photos'));
      expect(entry.datePath).toBe('2024/03/09');
    });
  });

  it('sanitizes destination key segments', async () => {
    await withTempDir(async (dir) => {
      const albumDir = path.join(dir, 'Google Photos', 'Trip 2025');
      await fs.mkdir(albumDir, { recursive: true });
      const mediaPath = path.join(albumDir, 'My File (1).jpg');
      await fs.writeFile(mediaPath, 'x');

      const [entry] = await buildManifest(path.join(dir, 'Google Photos'));
      expect(entry.destinationKey).toMatch(/Trip_2025\/My_File__1_.jpg$/);
    });
  });

  it('persists manifest as JSONL', async () => {
    await withTempDir(async (dir) => {
      const mediaRoot = path.join(dir, 'Google Photos', 'Album');
      await fs.mkdir(mediaRoot, { recursive: true });
      await fs.writeFile(path.join(mediaRoot, 'IMG.jpg'), 'x');

      const manifest = await buildManifest(path.join(dir, 'Google Photos'));
      const outputPath = path.join(dir, 'manifest', 'items.jsonl');
      await persistManifestJsonl(manifest, outputPath);

      const content = await fs.readFile(outputPath, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]) as { relativePath: string };
      expect(parsed.relativePath).toBe('Album/IMG.jpg');
    });
  });

  it('resolves sidecar for __dup files using original filename', async () => {
    await withTempDir(async (dir) => {
      const albumDir = path.join(dir, 'Google Photos', 'Album');
      await fs.mkdir(albumDir, { recursive: true });

      // Original file with sidecar
      await fs.writeFile(path.join(albumDir, 'IMG_0057.MOV'), 'video');
      await fs.writeFile(
        path.join(albumDir, 'IMG_0057.MOV.json'),
        JSON.stringify({
          photoTakenTime: { timestamp: '1595587200' }, // 2020-07-24T12:00:00Z
        }),
      );

      // Dup file — no dedicated sidecar, should use original's sidecar
      await fs.writeFile(path.join(albumDir, 'IMG_0057__dup1.MOV'), 'video-dup');

      const manifest = await buildManifest(path.join(dir, 'Google Photos'));
      const original = manifest.find((e) => e.relativePath.includes('IMG_0057.MOV') && !e.relativePath.includes('dup'));
      const dup = manifest.find((e) => e.relativePath.includes('IMG_0057__dup1.MOV'));

      expect(original).toBeDefined();
      expect(dup).toBeDefined();
      // Both should have the same date from the sidecar
      expect(original!.datePath).toBe('2020/07/24');
      expect(dup!.datePath).toBe('2020/07/24');
      expect(dup!.sidecarPath).toBeDefined();
    });
  });

  it('infers date from filename when no sidecar exists', async () => {
    await withTempDir(async (dir) => {
      const albumDir = path.join(dir, 'Google Photos', 'Album');
      await fs.mkdir(albumDir, { recursive: true });

      // File with date in name but no sidecar
      const mediaPath = path.join(albumDir, '20201217_155747.mp4');
      await fs.writeFile(mediaPath, 'vid');

      const [entry] = await buildManifest(path.join(dir, 'Google Photos'));
      expect(entry.datePath).toBe('2020/12/17');
    });
  });
});

// ── Deduplication tests ───────────────────────────────────────────────────────

describe('scoreEntryForKeep', () => {
  const base: ManifestEntry = {
    sourcePath: '/tmp/a.jpg',
    relativePath: 'a.jpg',
    size: 100,
    mtimeMs: 0,
    capturedAt: '2024-01-01T00:00:00.000Z',
    datePath: '2024/01/01',
    destinationKey: 'transfers/2024/01/01/a.jpg',
  };

  it('prefers entries with a clean date path', () => {
    const withDate = { ...base, destinationKey: 'transfers/2024/01/01/a.jpg' };
    const withoutDate = { ...base, destinationKey: 'transfers/Album_Vacation/a.jpg' };
    expect(scoreEntryForKeep(withDate)).toBeGreaterThan(scoreEntryForKeep(withoutDate));
  });

  it('penalises deep nesting', () => {
    const shallow = { ...base, destinationKey: 'transfers/2024/01/01/a.jpg' };
    const deep = { ...base, destinationKey: 'transfers/2024/01/01/sub/deep/a.jpg' };
    expect(scoreEntryForKeep(shallow)).toBeGreaterThan(scoreEntryForKeep(deep));
  });

  it('penalises __dup files', () => {
    const normal = { ...base, relativePath: 'Album/IMG_0057.MOV' };
    const dup = { ...base, relativePath: 'Album/IMG_0057__dup1.MOV' };
    expect(scoreEntryForKeep(normal)).toBeGreaterThan(scoreEntryForKeep(dup));
  });
});

describe('partialFileHash', () => {
  it('returns consistent hash for same content', async () => {
    await withTempDir(async (dir) => {
      const fileA = path.join(dir, 'a.jpg');
      const fileB = path.join(dir, 'b.jpg');
      const content = Buffer.alloc(128 * 1024, 'x'); // 128 KB
      await fs.writeFile(fileA, content);
      await fs.writeFile(fileB, content);

      const hashA = await partialFileHash(fileA);
      const hashB = await partialFileHash(fileB);
      expect(hashA).toBe(hashB);
      expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('returns different hashes for different content', async () => {
    await withTempDir(async (dir) => {
      const fileA = path.join(dir, 'a.jpg');
      const fileB = path.join(dir, 'b.jpg');
      await fs.writeFile(fileA, 'content-a');
      await fs.writeFile(fileB, 'content-b');

      const hashA = await partialFileHash(fileA);
      const hashB = await partialFileHash(fileB);
      expect(hashA).not.toBe(hashB);
    });
  });

  it('hashes only the first 64KB for large files', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'big.mp4');
      const buf = Buffer.alloc(256 * 1024, 0);
      await fs.writeFile(file, buf);

      // Same first 64KB means same hash even with different tail
      const file2 = path.join(dir, 'big2.mp4');
      const buf2 = Buffer.alloc(256 * 1024, 0);
      buf2[128 * 1024] = 0xff; // differ past 64KB
      await fs.writeFile(file2, buf2);

      expect(await partialFileHash(file)).toBe(await partialFileHash(file2));
    });
  });
});

describe('deduplicateManifest', () => {
  function entry(overrides: Partial<ManifestEntry> & { sourcePath: string }): ManifestEntry {
    return {
      relativePath: path.basename(overrides.sourcePath),
      size: 100,
      mtimeMs: 0,
      capturedAt: '2024-01-01T00:00:00.000Z',
      datePath: '2024/01/01',
      destinationKey: `transfers/2024/01/01/${path.basename(overrides.sourcePath)}`,
      ...overrides,
    };
  }

  it('returns empty for empty input', async () => {
    const result = await deduplicateManifest([]);
    expect(result).toEqual({ entries: [], removedCount: 0, removedBytes: 0 });
  });

  it('keeps all entries when no duplicates exist', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'a.jpg'), 'content-a');
      await fs.writeFile(path.join(dir, 'b.jpg'), 'different-content');

      const entries = [
        entry({ sourcePath: path.join(dir, 'a.jpg'), size: 9 }),
        entry({ sourcePath: path.join(dir, 'b.jpg'), size: 17 }),
      ];

      const result = await deduplicateManifest(entries);
      expect(result.entries).toHaveLength(2);
      expect(result.removedCount).toBe(0);
      expect(result.removedBytes).toBe(0);
    });
  });

  it('removes duplicate entries with same content', async () => {
    await withTempDir(async (dir) => {
      const content = 'identical-photo-content';
      // Simulate Google Takeout: same file in two album folders
      const dir1 = path.join(dir, 'Photos from 2020');
      const dir2 = path.join(dir, 'Vacation');
      await fs.mkdir(dir1, { recursive: true });
      await fs.mkdir(dir2, { recursive: true });
      await fs.writeFile(path.join(dir1, 'IMG_001.jpg'), content);
      await fs.writeFile(path.join(dir2, 'IMG_001.jpg'), content);

      const entries = [
        entry({
          sourcePath: path.join(dir1, 'IMG_001.jpg'),
          relativePath: 'Photos from 2020/IMG_001.jpg',
          destinationKey: 'transfers/2020/05/15/Photos_from_2020/IMG_001.jpg',
          size: content.length,
        }),
        entry({
          sourcePath: path.join(dir2, 'IMG_001.jpg'),
          relativePath: 'Vacation/IMG_001.jpg',
          destinationKey: 'transfers/2020/05/15/Vacation/IMG_001.jpg',
          size: content.length,
        }),
      ];

      const result = await deduplicateManifest(entries);
      expect(result.entries).toHaveLength(1);
      expect(result.removedCount).toBe(1);
      expect(result.removedBytes).toBe(content.length);
    });
  });

  it('keeps entries with same size but different content', async () => {
    await withTempDir(async (dir) => {
      // Exactly same size but different content → different hash
      await fs.writeFile(path.join(dir, 'a.jpg'), 'AAAAAAAAAA');
      await fs.writeFile(path.join(dir, 'b.jpg'), 'BBBBBBBBBB');

      const entries = [
        entry({ sourcePath: path.join(dir, 'a.jpg'), size: 10 }),
        entry({ sourcePath: path.join(dir, 'b.jpg'), size: 10 }),
      ];

      const result = await deduplicateManifest(entries);
      expect(result.entries).toHaveLength(2);
      expect(result.removedCount).toBe(0);
    });
  });

  it('prefers the best-scored entry when deduplicating', async () => {
    await withTempDir(async (dir) => {
      const content = 'photo-data';
      await fs.writeFile(path.join(dir, 'a.jpg'), content);
      await fs.writeFile(path.join(dir, 'b.jpg'), content);

      const goodEntry = entry({
        sourcePath: path.join(dir, 'a.jpg'),
        relativePath: 'IMG_001.jpg',
        destinationKey: 'transfers/2024/01/01/IMG_001.jpg',
        size: content.length,
      });
      const badEntry = entry({
        sourcePath: path.join(dir, 'b.jpg'),
        relativePath: 'Album/Sub/Deep/IMG_001__dup1.jpg',
        destinationKey: 'transfers/2024/01/01/Album/Sub/Deep/IMG_001__dup1.jpg',
        size: content.length,
      });

      const result = await deduplicateManifest([badEntry, goodEntry]);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].destinationKey).toBe('transfers/2024/01/01/IMG_001.jpg');
    });
  });

  it('handles large groups of duplicates', async () => {
    await withTempDir(async (dir) => {
      const content = 'same-video-data';
      const entries: ManifestEntry[] = [];

      for (let i = 0; i < 5; i++) {
        const filePath = path.join(dir, `copy${i}.mov`);
        await fs.writeFile(filePath, content);
        entries.push(
          entry({
            sourcePath: filePath,
            relativePath: `Album${i}/video.mov`,
            destinationKey: `transfers/2024/01/01/Album${i}/video.mov`,
            size: content.length,
          }),
        );
      }

      const result = await deduplicateManifest(entries);
      expect(result.entries).toHaveLength(1);
      expect(result.removedCount).toBe(4);
      expect(result.removedBytes).toBe(4 * content.length);
    });
  });

  it('reports progress during hashing', async () => {
    await withTempDir(async (dir) => {
      const content = 'data';
      await fs.writeFile(path.join(dir, 'a.jpg'), content);
      await fs.writeFile(path.join(dir, 'b.jpg'), content);

      const entries = [
        entry({ sourcePath: path.join(dir, 'a.jpg'), size: content.length }),
        entry({ sourcePath: path.join(dir, 'b.jpg'), size: content.length }),
      ];

      const progressCalls: Array<[number, number]> = [];
      await deduplicateManifest(entries, (processed, total) => {
        progressCalls.push([processed, total]);
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      // Final call should have processed === total
      const last = progressCalls[progressCalls.length - 1];
      expect(last[0]).toBe(last[1]);
    });
  });
});

/**
 * Create a directory that causes fs.readdir to throw.
 * On Windows: create a junction pointing to a non-existent target.
 * On POSIX: chmod 0o000 removes read permission.
 */
async function makeUnreadableDir(parentDir: string, name: string): Promise<string> {
  const dirPath = path.join(parentDir, name);
  if (process.platform === 'win32') {
    const target = path.join(parentDir, '__nonexistent_target__');
    execSync(`mklink /J "${dirPath}" "${target}"`, { stdio: 'ignore' });
  } else {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.chmod(dirPath, 0o000);
  }
  return dirPath;
}

async function cleanupUnreadableDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') {
    try { execSync(`rmdir "${dirPath}"`, { stdio: 'ignore' }); } catch { /* ok */ }
  } else {
    try {
      await fs.chmod(dirPath, 0o755);
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch { /* ok */ }
  }
}

describe('buildManifest – corrupted directory resilience', () => {
  it('skips unreadable subdirectories and returns files from readable ones', async () => {
    await withTempDir(async (dir) => {
      const mediaRoot = path.join(dir, 'Google Photos');
      const goodAlbum = path.join(mediaRoot, 'GoodAlbum');
      await fs.mkdir(goodAlbum, { recursive: true });
      await fs.writeFile(path.join(goodAlbum, 'photo.jpg'), 'img-data');

      const unreadable = await makeUnreadableDir(mediaRoot, 'CorruptedAlbum');
      try {
        const manifest = await buildManifest(mediaRoot);

        expect(manifest).toHaveLength(1);
        expect(manifest[0].relativePath).toBe('GoodAlbum/photo.jpg');
      } finally {
        await cleanupUnreadableDir(unreadable);
      }
    });
  });

  it('returns empty manifest when all subdirectories are unreadable', async () => {
    await withTempDir(async (dir) => {
      const mediaRoot = path.join(dir, 'Google Photos');
      await fs.mkdir(mediaRoot, { recursive: true });

      const unreadable = await makeUnreadableDir(mediaRoot, 'OnlyAlbum');
      try {
        const manifest = await buildManifest(mediaRoot);
        expect(manifest).toHaveLength(0);
      } finally {
        await cleanupUnreadableDir(unreadable);
      }
    });
  });
});