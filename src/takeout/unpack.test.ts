import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import {
  discoverTakeoutArchives,
  extractTakeoutArchives,
  findGooglePhotosRoots,
  normalizeTakeoutMediaRoot,
  unpackAndNormalizeTakeout,
  detectArchiveParts,
} from './unpack.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mediatransfer-unpack-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('takeout/unpack', () => {
  it('creates missing input directory during archive discovery', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'missing-input');

      const found = await discoverTakeoutArchives(inputDir);

      expect(found).toEqual([]);
      await expect(fs.access(inputDir)).resolves.toBeUndefined();
    });
  });

  it('discovers supported archive formats in sorted order', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'takeout-2.zip'), 'x');
      await fs.writeFile(path.join(dir, 'takeout-10.tgz'), 'x');
      await fs.writeFile(path.join(dir, 'takeout-1.tar.gz'), 'x');
      await fs.writeFile(path.join(dir, 'readme.txt'), 'x');

      const found = await discoverTakeoutArchives(dir);
      expect(found.map((file) => path.basename(file))).toEqual([
        'takeout-1.tar.gz',
        'takeout-2.zip',
        'takeout-10.tgz',
      ]);
    });
  });

  it('extracts all archives using provided extractor', async () => {
    await withTempDir(async (dir) => {
      const archivePaths = [path.join(dir, 'a.zip'), path.join(dir, 'b.zip')];
      const calls: Array<[string, string]> = [];

      await extractTakeoutArchives(archivePaths, path.join(dir, 'work'), async (archive, dest) => {
        calls.push([archive, dest]);
      });

      expect(calls).toHaveLength(2);
      expect(calls[0][0]).toBe(archivePaths[0]);
      expect(calls[1][0]).toBe(archivePaths[1]);
    });
  });

  it('finds Google Photos roots recursively', async () => {
    await withTempDir(async (dir) => {
      const rootA = path.join(dir, 'part1', 'Takeout', 'Google Photos');
      const rootB = path.join(dir, 'part2', 'Google Photos');
      await fs.mkdir(rootA, { recursive: true });
      await fs.mkdir(rootB, { recursive: true });

      const roots = await findGooglePhotosRoots(dir);
      expect(roots).toEqual([rootA, rootB].sort((a, b) => a.localeCompare(b)));
    });
  });

  it('normalizes multiple roots and handles duplicate names', async () => {
    await withTempDir(async (dir) => {
      const rootA = path.join(dir, 'part1', 'Takeout', 'Google Photos', 'AlbumA');
      const rootB = path.join(dir, 'part2', 'Google Photos', 'AlbumA');
      await fs.mkdir(rootA, { recursive: true });
      await fs.mkdir(rootB, { recursive: true });

      await fs.writeFile(path.join(rootA, 'IMG_0001.jpg'), 'one');
      await fs.writeFile(path.join(rootB, 'IMG_0001.jpg'), 'two');

      const normalized = await normalizeTakeoutMediaRoot(dir);
      const albumFiles = await fs.readdir(path.join(normalized, 'AlbumA'));

      expect(albumFiles).toContain('IMG_0001.jpg');
      expect(albumFiles.some((name) => name.startsWith('IMG_0001__dup'))).toBe(true);
    });
  });

  it('runs discover + extract + normalize in one call', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'takeout-1.zip'), 'archive');

      const result = await unpackAndNormalizeTakeout(
        inputDir,
        workDir,
        async (_archivePath, destinationDir) => {
          const root = path.join(destinationDir, 'Takeout', 'Google Photos', 'AlbumX');
          await fs.mkdir(root, { recursive: true });
          await fs.writeFile(path.join(root, 'file.jpg'), 'content');
        },
      );

      expect(result.archives).toHaveLength(1);
      expect(path.basename(result.archives[0])).toBe('takeout-1.zip');
      expect(result.mediaRoot).toBe(path.join(workDir, 'normalized', 'Google Photos'));
      await expect(fs.access(path.join(result.mediaRoot, 'AlbumX', 'file.jpg'))).resolves.toBeUndefined();
    });
  });

  it('falls back to extracted workDir when media exists but Google Photos folder name is different', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'takeout-1.zip'), 'archive');

      const result = await unpackAndNormalizeTakeout(
        inputDir,
        workDir,
        async (_archivePath, destinationDir) => {
          const mediaDir = path.join(destinationDir, 'Takeout', 'Fotos', 'AlbumX');
          await fs.mkdir(mediaDir, { recursive: true });
          await fs.writeFile(path.join(mediaDir, 'file.jpg'), 'content');
        },
      );

      expect(result.archives).toHaveLength(1);
      expect(result.mediaRoot).toBe(workDir);
    });
  });

  it('throws actionable error when no archives are found', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');

      await expect(unpackAndNormalizeTakeout(inputDir, workDir)).rejects.toThrow(
        'Place one or more Google Takeout .zip/.tar/.tgz archives there and run takeout:scan again.',
      );
    });
  });

  it('throws actionable error when extraction only contains archive_browser metadata', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'takeout-1.tgz'), 'archive');

      await expect(unpackAndNormalizeTakeout(
        inputDir,
        workDir,
        async (_archivePath, destinationDir) => {
          const reportPath = path.join(destinationDir, 'Takeout', 'archive_browser.html');
          await fs.mkdir(path.dirname(reportPath), { recursive: true });
          await fs.writeFile(reportPath, '<html></html>');
        },
      )).rejects.toThrow('only contain Takeout metadata (archive_browser.html)');
    });
  });

  it('detects multi-part archive naming and includes part numbers in error', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'takeout-20260224T151101Z-001.tgz'), 'archive');

      const err = await unpackAndNormalizeTakeout(
        inputDir,
        workDir,
        async (_archivePath, destinationDir) => {
          const reportPath = path.join(destinationDir, 'Takeout', 'archive_browser.html');
          await fs.mkdir(path.dirname(reportPath), { recursive: true });
          await fs.writeFile(reportPath, '<html></html>');
        },
      ).catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('You have part(s): 1');
      expect(err.message).toContain('Download ALL parts');
      expect(err.message).toContain('takeout.google.com');
    });
  });

  it('detectArchiveParts identifies multi-part archives', () => {
    const result = detectArchiveParts([
      '/input/takeout-20260224T151101Z-001.tgz',
      '/input/takeout-20260224T151101Z-003.tgz',
    ]);
    expect(result.isMultiPart).toBe(true);
    expect(result.partNumbers).toEqual([1, 3]);
  });

  it('detectArchiveParts returns false for non-numbered archives', () => {
    const result = detectArchiveParts(['/input/photos-backup.zip']);
    expect(result.isMultiPart).toBe(false);
    expect(result.partNumbers).toEqual([]);
  });

  it('supports direct media folders when no archives are present', async () => {
    await withTempDir(async (dir) => {
      const inputDir = path.join(dir, 'input');
      const workDir = path.join(dir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'Screenshot 2026-02-19 101010.png'), 'pngdata');

      const result = await unpackAndNormalizeTakeout(inputDir, workDir);

      expect(result.archives).toEqual([]);
      expect(result.mediaRoot).toBe(inputDir);
    });
  });

  it('skips duplicate files with same content during normalization', async () => {
    await withTempDir(async (dir) => {
      const rootA = path.join(dir, 'part1', 'Takeout', 'Google Photos', 'AlbumA');
      const rootB = path.join(dir, 'part2', 'Google Photos', 'AlbumA');
      await fs.mkdir(rootA, { recursive: true });
      await fs.mkdir(rootB, { recursive: true });

      // Same filename, same content — should be deduplicated (no __dup copy)
      await fs.writeFile(path.join(rootA, 'IMG_0099.jpg'), 'identical-content');
      await fs.writeFile(path.join(rootB, 'IMG_0099.jpg'), 'identical-content');

      const normalized = await normalizeTakeoutMediaRoot(dir);
      const albumFiles = await fs.readdir(path.join(normalized, 'AlbumA'));

      expect(albumFiles).toContain('IMG_0099.jpg');
      expect(albumFiles.filter((name) => name.includes('IMG_0099'))).toHaveLength(1);
    });
  });

  it('still creates __dup when same-name files have different content', async () => {
    await withTempDir(async (dir) => {
      const rootA = path.join(dir, 'part1', 'Takeout', 'Google Photos', 'AlbumB');
      const rootB = path.join(dir, 'part2', 'Google Photos', 'AlbumB');
      await fs.mkdir(rootA, { recursive: true });
      await fs.mkdir(rootB, { recursive: true });

      // Same filename, different content — should create __dup
      await fs.writeFile(path.join(rootA, 'IMG_0100.jpg'), 'version-one');
      await fs.writeFile(path.join(rootB, 'IMG_0100.jpg'), 'version-two-longer');

      const normalized = await normalizeTakeoutMediaRoot(dir);
      const albumFiles = await fs.readdir(path.join(normalized, 'AlbumB'));

      expect(albumFiles).toContain('IMG_0100.jpg');
      expect(albumFiles.some((name) => name.startsWith('IMG_0100__dup'))).toBe(true);
    });
  });

  it('skips duplicate even when same-size files have matching partial hash', async () => {
    await withTempDir(async (dir) => {
      const rootA = path.join(dir, 'part1', 'Takeout', 'Google Photos', 'AlbumC');
      const rootB = path.join(dir, 'part2', 'Google Photos', 'AlbumC');
      const rootC = path.join(dir, 'part3', 'Google Photos', 'AlbumC');
      await fs.mkdir(rootA, { recursive: true });
      await fs.mkdir(rootB, { recursive: true });
      await fs.mkdir(rootC, { recursive: true });

      // Three copies of the same file from three archive parts
      const content = 'a'.repeat(1024);
      await fs.writeFile(path.join(rootA, 'photo.png'), content);
      await fs.writeFile(path.join(rootB, 'photo.png'), content);
      await fs.writeFile(path.join(rootC, 'photo.png'), content);

      const normalized = await normalizeTakeoutMediaRoot(dir);
      const albumFiles = await fs.readdir(path.join(normalized, 'AlbumC'));

      expect(albumFiles.filter((name) => name.includes('photo'))).toHaveLength(1);
      expect(albumFiles).toContain('photo.png');
    });
  });
});
