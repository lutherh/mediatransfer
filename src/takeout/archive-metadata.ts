import path from 'node:path';
import fs from 'node:fs/promises';
import type { ManifestEntry } from './manifest.js';
import { partialFileHash } from './manifest.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SidecarMetadata = {
  title?: string;
  description?: string;
  photoTakenTime?: string;
  creationTime?: string;
  geoData?: { latitude: number; longitude: number; altitude?: number };
  people?: string[];
  url?: string;
};

export type MediaItemMetadata = {
  destinationKey: string;
  relativePath: string;
  album?: string;
  sizeBytes: number;
  capturedAt: string;
  sidecar?: SidecarMetadata;
};

export type DuplicateGroup = {
  /** Content fingerprint: `${sizeBytes}:${partialHash}` */
  contentFingerprint: string;
  sizeBytes: number;
  /** All destination keys sharing this fingerprint */
  items: string[];
  /** The destination key we kept (highest dedup score) */
  kept: string;
};

export type ArchiveMetadata = {
  version: 1;
  archiveName: string;
  extractedAt: string;
  /** Album name → list of destination keys that belong to it */
  albums: Record<string, string[]>;
  /** Per-item metadata including sidecar data */
  items: MediaItemMetadata[];
  /** Groups of duplicate items found within this archive */
  duplicates: DuplicateGroup[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const IO_CONCURRENCY = 32;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract album, sidecar, and duplicate metadata from an extracted archive
 * and persist it as JSON. This data survives after the extracted files are
 * cleaned up, preserving album assignments and duplicate relationships.
 *
 * @param extractDir - Directory where the archive was extracted
 * @param entries - Manifest entries built from this archive
 * @param archiveName - Original archive filename (e.g. "takeout-001.tgz")
 * @param metadataDir - Directory to write metadata JSON files
 * @returns The metadata object (also persisted to disk)
 */
export async function extractAndPersistArchiveMetadata(
  _extractDir: string,
  entries: ManifestEntry[],
  archiveName: string,
  metadataDir: string,
): Promise<ArchiveMetadata> {
  const items = await buildItemMetadata(entries);
  const albums = buildAlbumIndex(entries);
  const duplicates = await findDuplicateGroups(entries);

  const metadata: ArchiveMetadata = {
    version: 1,
    archiveName,
    extractedAt: new Date().toISOString(),
    albums,
    items,
    duplicates,
  };

  await persistArchiveMetadata(metadata, metadataDir);
  return metadata;
}

/**
 * Load previously persisted metadata for a specific archive.
 */
export async function loadArchiveMetadata(
  metadataDir: string,
  archiveName: string,
): Promise<ArchiveMetadata | undefined> {
  const filePath = getMetadataFilePath(metadataDir, archiveName);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || typeof parsed.archiveName !== 'string') {
      console.warn(`[archive-metadata] Invalid shape in ${filePath}, ignoring`);
      return undefined;
    }
    return parsed as ArchiveMetadata;
  } catch {
    return undefined;
  }
}

/**
 * Load all persisted archive metadata files from the metadata directory.
 */
export async function loadAllArchiveMetadata(
  metadataDir: string,
): Promise<ArchiveMetadata[]> {
  try {
    const files = await fs.readdir(metadataDir);
    const jsonFiles = files.filter((f) => f.endsWith('.metadata.json'));
    const results: ArchiveMetadata[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await fs.readFile(path.join(metadataDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.version !== 1 || typeof parsed.archiveName !== 'string') {
          console.warn(`[archive-metadata] Invalid shape in ${file}, skipping`);
          continue;
        }
        results.push(parsed as ArchiveMetadata);
      } catch {
        // skip malformed files
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Build a merged album index across all processed archives.
 * Returns albumName → destinationKey[] across every archive.
 */
export async function buildMergedAlbumIndex(
  metadataDir: string,
): Promise<Record<string, string[]>> {
  const allMetadata = await loadAllArchiveMetadata(metadataDir);
  const merged: Record<string, string[]> = {};
  for (const meta of allMetadata) {
    for (const [album, keys] of Object.entries(meta.albums)) {
      if (!merged[album]) merged[album] = [];
      merged[album].push(...keys);
    }
  }
  return merged;
}

/**
 * Build a merged duplicate index across all processed archives.
 * Returns all duplicate groups found so far.
 */
export async function buildMergedDuplicateIndex(
  metadataDir: string,
): Promise<DuplicateGroup[]> {
  const allMetadata = await loadAllArchiveMetadata(metadataDir);
  // Merge by fingerprint across archives
  const byFingerprint = new Map<string, DuplicateGroup>();
  for (const meta of allMetadata) {
    for (const group of meta.duplicates) {
      const existing = byFingerprint.get(group.contentFingerprint);
      if (existing) {
        // Merge items, deduplicate
        const itemSet = new Set([...existing.items, ...group.items]);
        existing.items = [...itemSet];
      } else {
        byFingerprint.set(group.contentFingerprint, { ...group });
      }
    }
  }
  return [...byFingerprint.values()].filter((g) => g.items.length > 1);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getMetadataFilePath(metadataDir: string, archiveName: string): string {
  // Sanitize archive name for safe filesystem use
  const safeName = archiveName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(metadataDir, `${safeName}.metadata.json`);
}

async function persistArchiveMetadata(
  metadata: ArchiveMetadata,
  metadataDir: string,
): Promise<void> {
  await fs.mkdir(metadataDir, { recursive: true });
  const filePath = getMetadataFilePath(metadataDir, metadata.archiveName);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(metadata, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Derive the album name from a manifest entry's source path.
 * In Google Takeout, the album is the immediate parent folder under
 * "Google Photos/", e.g. "Google Photos/Trip to Paris/img.jpg" → "Trip to Paris"
 */
function deriveAlbumName(entry: ManifestEntry): string | undefined {
  // The relativePath from manifest is relative to the Google Photos root
  // Album is the first path segment (the folder name)
  const parts = entry.relativePath.split('/');
  if (parts.length >= 2) {
    const albumCandidate = parts[0];
    // Skip date-based folders like "Photos from 2023" — those aren't real albums
    if (!/^Photos from \d{4}$/i.test(albumCandidate)) {
      return albumCandidate;
    }
  }
  return undefined;
}

/**
 * Build album name → destinationKey[] mapping from entries.
 */
function buildAlbumIndex(
  entries: ManifestEntry[],
): Record<string, string[]> {
  const albums: Record<string, string[]> = {};
  for (const entry of entries) {
    const album = deriveAlbumName(entry);
    if (album) {
      if (!albums[album]) albums[album] = [];
      albums[album].push(entry.destinationKey);
    }
  }
  return albums;
}

/**
 * Build per-item metadata including parsed sidecar data.
 */
async function buildItemMetadata(
  entries: ManifestEntry[],
): Promise<MediaItemMetadata[]> {
  const items: MediaItemMetadata[] = [];

  for (let i = 0; i < entries.length; i += IO_CONCURRENCY) {
    const batch = entries.slice(i, i + IO_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const album = deriveAlbumName(entry);
        const sidecar = entry.sidecarPath
          ? await parseSidecarJson(entry.sidecarPath)
          : undefined;

        return {
          destinationKey: entry.destinationKey,
          relativePath: entry.relativePath,
          album,
          sizeBytes: entry.size,
          capturedAt: entry.capturedAt,
          sidecar,
        } satisfies MediaItemMetadata;
      }),
    );
    items.push(...batchResults);
  }

  return items;
}

/**
 * Parse a Google Takeout sidecar JSON file, extracting the relevant metadata.
 */
async function parseSidecarJson(sidecarPath: string): Promise<SidecarMetadata | undefined> {
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const result: SidecarMetadata = {};

    if (typeof parsed.title === 'string') result.title = parsed.title;
    if (typeof parsed.description === 'string' && parsed.description.length > 0) {
      result.description = parsed.description;
    }

    // photoTakenTime
    const photoTakenTime = getNestedString(parsed, ['photoTakenTime', 'formatted'])
      ?? getNestedTimestamp(parsed, ['photoTakenTime', 'timestamp']);
    if (photoTakenTime) result.photoTakenTime = photoTakenTime;

    // creationTime
    const creationTime = getNestedString(parsed, ['creationTime', 'formatted'])
      ?? getNestedTimestamp(parsed, ['creationTime', 'timestamp']);
    if (creationTime) result.creationTime = creationTime;

    // geoData
    const geo = parsed.geoData as Record<string, unknown> | undefined;
    if (geo && typeof geo.latitude === 'number' && typeof geo.longitude === 'number') {
      // Google Takeout uses 0/0 for "no geo data"
      if (geo.latitude !== 0 || geo.longitude !== 0) {
        result.geoData = {
          latitude: geo.latitude,
          longitude: geo.longitude,
          altitude: typeof geo.altitude === 'number' ? geo.altitude : undefined,
        };
      }
    }

    // people
    const people = parsed.people as Array<{ name?: string }> | undefined;
    if (Array.isArray(people) && people.length > 0) {
      const names = people.map((p) => p.name).filter((n): n is string => typeof n === 'string');
      if (names.length > 0) result.people = names;
    }

    // url
    if (typeof parsed.url === 'string') result.url = parsed.url;

    // Only return if we extracted anything useful
    if (Object.keys(result).length === 0) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

/**
 * Find groups of duplicate files within the manifest entries (same size + partial hash).
 */
async function findDuplicateGroups(entries: ManifestEntry[]): Promise<DuplicateGroup[]> {
  if (entries.length === 0) return [];

  // Group by size first (free — no I/O)
  const sizeGroups = new Map<number, ManifestEntry[]>();
  for (const entry of entries) {
    const group = sizeGroups.get(entry.size);
    if (group) group.push(entry);
    else sizeGroups.set(entry.size, [entry]);
  }

  const duplicates: DuplicateGroup[] = [];

  // Only hash entries that share a size with another entry
  for (const [size, group] of sizeGroups) {
    if (group.length < 2) continue;

    // Hash in batches
    const hashMap = new Map<string, ManifestEntry[]>();
    for (let i = 0; i < group.length; i += IO_CONCURRENCY) {
      const batch = group.slice(i, i + IO_CONCURRENCY);
      const hashes = await Promise.all(
        batch.map(async (entry) => {
          try {
            const hash = await partialFileHash(entry.sourcePath);
            return { entry, hash };
          } catch {
            return { entry, hash: `err_${entry.sourcePath}` };
          }
        }),
      );

      for (const { entry, hash } of hashes) {
        const fingerprint = `${size}:${hash}`;
        const existing = hashMap.get(fingerprint);
        if (existing) existing.push(entry);
        else hashMap.set(fingerprint, [entry]);
      }
    }

    // Collect actual duplicates
    for (const [fingerprint, items] of hashMap) {
      if (items.length < 2) continue;

      // Pick the "best" entry to keep (non-dup, shortest path)
      const sorted = [...items].sort((a, b) => {
        const aDup = /__dup\d+/.test(a.relativePath) ? 1 : 0;
        const bDup = /__dup\d+/.test(b.relativePath) ? 1 : 0;
        if (aDup !== bDup) return aDup - bDup;
        return a.destinationKey.length - b.destinationKey.length;
      });

      duplicates.push({
        contentFingerprint: fingerprint,
        sizeBytes: size,
        items: items.map((e) => e.destinationKey),
        kept: sorted[0].destinationKey,
      });
    }
  }

  return duplicates;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function getNestedString(obj: Record<string, unknown>, parts: string[]): string | undefined {
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function getNestedTimestamp(obj: Record<string, unknown>, parts: string[]): string | undefined {
  const value = getNestedString(obj, parts);
  if (!value) return undefined;
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return new Date(num * 1000).toISOString();
  }
  return undefined;
}
