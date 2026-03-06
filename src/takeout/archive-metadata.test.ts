import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import {
  extractAndPersistArchiveMetadata,
  loadArchiveMetadata,
  loadAllArchiveMetadata,
  buildMergedAlbumIndex,
  buildMergedDuplicateIndex,
} from './archive-metadata.js';
import { buildManifest } from './manifest.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mediatransfer-archmeta-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('takeout/archive-metadata', () => {
  it('extracts album and item metadata from an extracted archive', async () => {
    await withTempDir(async (dir) => {
      const extractDir = path.join(dir, 'extract');
      const metadataDir = path.join(dir, 'metadata');

      // Create a Google Photos-like structure with two albums
      const album1 = path.join(extractDir, 'Google Photos', 'Trip to Paris');
      const album2 = path.join(extractDir, 'Google Photos', 'Family');
      await fs.mkdir(album1, { recursive: true });
      await fs.mkdir(album2, { recursive: true });

      // Photos in album1 with sidecar
      const img1 = path.join(album1, 'IMG_001.jpg');
      await fs.writeFile(img1, 'photo1-content');
      await fs.writeFile(
        `${img1}.json`,
        JSON.stringify({
          title: 'Eiffel Tower',
          description: 'Beautiful day in Paris',
          photoTakenTime: { timestamp: '1765584000' },
          geoData: { latitude: 48.8584, longitude: 2.2945 },
          people: [{ name: 'Alice' }, { name: 'Bob' }],
        }),
      );

      // Photo in album2 (no sidecar)
      const img2 = path.join(album2, 'IMG_002.jpg');
      await fs.writeFile(img2, 'photo2-content');

      // Build manifest entries
      const mediaRoot = path.join(extractDir, 'Google Photos');
      const entries = await buildManifest(mediaRoot);

      // Extract and persist metadata
      const metadata = await extractAndPersistArchiveMetadata(
        extractDir,
        entries,
        'takeout-001.tgz',
        metadataDir,
      );

      // Verify albums
      expect(Object.keys(metadata.albums)).toContain('Trip to Paris');
      expect(Object.keys(metadata.albums)).toContain('Family');
      expect(metadata.albums['Trip to Paris']).toHaveLength(1);
      expect(metadata.albums['Family']).toHaveLength(1);

      // Verify items have sidecar data
      const parisItem = metadata.items.find((i) => i.album === 'Trip to Paris');
      expect(parisItem).toBeDefined();
      expect(parisItem!.sidecar).toBeDefined();
      expect(parisItem!.sidecar!.title).toBe('Eiffel Tower');
      expect(parisItem!.sidecar!.description).toBe('Beautiful day in Paris');
      expect(parisItem!.sidecar!.geoData?.latitude).toBeCloseTo(48.8584);
      expect(parisItem!.sidecar!.people).toEqual(['Alice', 'Bob']);

      // Verify the item without sidecar
      const familyItem = metadata.items.find((i) => i.album === 'Family');
      expect(familyItem).toBeDefined();
      expect(familyItem!.sidecar).toBeUndefined();

      // Verify persistence
      expect(metadata.version).toBe(1);
      expect(metadata.archiveName).toBe('takeout-001.tgz');
    });
  });

  it('detects duplicates within an archive', async () => {
    await withTempDir(async (dir) => {
      const extractDir = path.join(dir, 'extract');
      const metadataDir = path.join(dir, 'metadata');

      const album1 = path.join(extractDir, 'Google Photos', 'Album A');
      const album2 = path.join(extractDir, 'Google Photos', 'Album B');
      await fs.mkdir(album1, { recursive: true });
      await fs.mkdir(album2, { recursive: true });

      // Same content in two different albums (Google Takeout duplicates)
      const content = 'identical-photo-content-for-dedup-test';
      await fs.writeFile(path.join(album1, 'photo.jpg'), content);
      await fs.writeFile(path.join(album2, 'photo.jpg'), content);

      const mediaRoot = path.join(extractDir, 'Google Photos');
      const entries = await buildManifest(mediaRoot);

      const metadata = await extractAndPersistArchiveMetadata(
        extractDir,
        entries,
        'takeout-test.tgz',
        metadataDir,
      );

      // Should find one duplicate group
      expect(metadata.duplicates.length).toBe(1);
      expect(metadata.duplicates[0].items).toHaveLength(2);
      expect(metadata.duplicates[0].kept).toBeDefined();
    });
  });

  it('loads persisted metadata back from disk', async () => {
    await withTempDir(async (dir) => {
      const extractDir = path.join(dir, 'extract');
      const metadataDir = path.join(dir, 'metadata');

      const album = path.join(extractDir, 'Google Photos', 'Vacation');
      await fs.mkdir(album, { recursive: true });
      await fs.writeFile(path.join(album, 'beach.jpg'), 'waves');

      const mediaRoot = path.join(extractDir, 'Google Photos');
      const entries = await buildManifest(mediaRoot);

      await extractAndPersistArchiveMetadata(extractDir, entries, 'test.tgz', metadataDir);

      // Load it back
      const loaded = await loadArchiveMetadata(metadataDir, 'test.tgz');
      expect(loaded).toBeDefined();
      expect(loaded!.archiveName).toBe('test.tgz');
      expect(loaded!.albums['Vacation']).toHaveLength(1);
    });
  });

  it('returns undefined for non-existent archive metadata', async () => {
    await withTempDir(async (dir) => {
      const loaded = await loadArchiveMetadata(dir, 'nonexistent.tgz');
      expect(loaded).toBeUndefined();
    });
  });

  it('loads all metadata files from a directory', async () => {
    await withTempDir(async (dir) => {
      const extractDir = path.join(dir, 'extract');
      const metadataDir = path.join(dir, 'metadata');

      // Create two separate archive extractions
      for (const archiveName of ['archive1.tgz', 'archive2.tgz']) {
        const album = path.join(extractDir, 'Google Photos', `Album-${archiveName}`);
        await fs.mkdir(album, { recursive: true });
        await fs.writeFile(path.join(album, 'pic.jpg'), `data-${archiveName}`);

        const entries = await buildManifest(path.join(extractDir, 'Google Photos'));
        await extractAndPersistArchiveMetadata(extractDir, entries, archiveName, metadataDir);

        // Clean up for next archive (simulating real workflow)
        await fs.rm(extractDir, { recursive: true, force: true });
      }

      const all = await loadAllArchiveMetadata(metadataDir);
      expect(all).toHaveLength(2);
    });
  });

  it('builds merged album index across archives', async () => {
    await withTempDir(async (dir) => {
      const extractDir = path.join(dir, 'extract');
      const metadataDir = path.join(dir, 'metadata');

      // Archive 1: album "Vacation"
      const album1 = path.join(extractDir, 'Google Photos', 'Vacation');
      await fs.mkdir(album1, { recursive: true });
      await fs.writeFile(path.join(album1, 'beach.jpg'), 'beach');
      let entries = await buildManifest(path.join(extractDir, 'Google Photos'));
      await extractAndPersistArchiveMetadata(extractDir, entries, 'part1.tgz', metadataDir);
      await fs.rm(extractDir, { recursive: true, force: true });

      // Archive 2: more "Vacation" + "Work"
      const album2a = path.join(extractDir, 'Google Photos', 'Vacation');
      const album2b = path.join(extractDir, 'Google Photos', 'Work');
      await fs.mkdir(album2a, { recursive: true });
      await fs.mkdir(album2b, { recursive: true });
      await fs.writeFile(path.join(album2a, 'sunset.jpg'), 'sunset');
      await fs.writeFile(path.join(album2b, 'meeting.jpg'), 'meeting');
      entries = await buildManifest(path.join(extractDir, 'Google Photos'));
      await extractAndPersistArchiveMetadata(extractDir, entries, 'part2.tgz', metadataDir);

      const merged = await buildMergedAlbumIndex(metadataDir);
      expect(Object.keys(merged)).toContain('Vacation');
      expect(Object.keys(merged)).toContain('Work');
      // Vacation should have items from both archives
      expect(merged['Vacation'].length).toBe(2);
      expect(merged['Work'].length).toBe(1);
    });
  });

  it('skips "Photos from YYYY" folders as non-album', async () => {
    await withTempDir(async (dir) => {
      const extractDir = path.join(dir, 'extract');
      const metadataDir = path.join(dir, 'metadata');

      const dateFolder = path.join(extractDir, 'Google Photos', 'Photos from 2023');
      const album = path.join(extractDir, 'Google Photos', 'My Album');
      await fs.mkdir(dateFolder, { recursive: true });
      await fs.mkdir(album, { recursive: true });

      await fs.writeFile(path.join(dateFolder, 'auto.jpg'), 'auto');
      await fs.writeFile(path.join(album, 'manual.jpg'), 'manual');

      const entries = await buildManifest(path.join(extractDir, 'Google Photos'));
      const metadata = await extractAndPersistArchiveMetadata(
        extractDir,
        entries,
        'test.tgz',
        metadataDir,
      );

      // "Photos from 2023" should NOT appear as an album
      expect(Object.keys(metadata.albums)).not.toContain('Photos from 2023');
      expect(Object.keys(metadata.albums)).toContain('My Album');
    });
  });

  it('builds merged duplicate index across archives', async () => {
    await withTempDir(async (dir) => {
      const metadataDir = path.join(dir, 'metadata');

      for (const archiveName of ['part1.tgz', 'part2.tgz']) {
        const extractDir = path.join(dir, `extract-${archiveName}`);
        const album1 = path.join(extractDir, 'Google Photos', 'Album A');
        const album2 = path.join(extractDir, 'Google Photos', 'Album B');
        await fs.mkdir(album1, { recursive: true });
        await fs.mkdir(album2, { recursive: true });

        // Same content in both albums -> one duplicate group per archive.
        await fs.writeFile(path.join(album1, 'photo.jpg'), 'duplicate-content');
        await fs.writeFile(path.join(album2, 'photo.jpg'), 'duplicate-content');

        const entries = await buildManifest(path.join(extractDir, 'Google Photos'));
        await extractAndPersistArchiveMetadata(extractDir, entries, archiveName, metadataDir);
      }

      const merged = await buildMergedDuplicateIndex(metadataDir);
      expect(merged.length).toBe(1);
      // Same relative paths across archives collapse to two unique destination keys.
      expect(merged[0].items.length).toBe(2);
      expect(merged[0].kept).toBeDefined();
    });
  });
});
