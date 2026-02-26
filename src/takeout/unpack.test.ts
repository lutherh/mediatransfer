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
      )).rejects.toThrow('Only Takeout metadata (archive_browser.html) was detected.');
    });
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
});
