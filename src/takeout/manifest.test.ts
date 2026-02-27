import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { buildManifest, persistManifestJsonl } from './manifest.js';

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
      expect(entry.destinationKey).toContain('2025/12/13/');
      expect(entry.sidecarPath).toBe(`${mediaPath}.json`);
    });
  });

  it('falls back to file mtime when sidecar is missing', async () => {
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
