import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { inferDateFromFilename, extractExifMetadata, extractVideoCreationDate } from '../utils/exif.js';
import { MEDIA_EXTENSIONS } from '../utils/media-extensions.js';

export type ManifestEntry = {
  sourcePath: string;
  relativePath: string;
  sidecarPath?: string;
  size: number;
  mtimeMs: number;
  capturedAt: string;
  datePath: string;
  destinationKey: string;
};

/**
 * Concurrency limit for parallel filesystem operations.
 * Prevents overwhelming the OS with too many open file handles.
 */
const IO_CONCURRENCY = 32;

export type ManifestProgressCallback = (processed: number, total: number) => void;

export async function buildManifest(
  mediaRoot: string,
  onProgress?: ManifestProgressCallback,
): Promise<ManifestEntry[]> {
  const files = await listMediaFiles(mediaRoot);
  const entries: ManifestEntry[] = [];

  onProgress?.(0, files.length);

  // Process files in parallel batches for much faster manifest building
  for (let i = 0; i < files.length; i += IO_CONCURRENCY) {
    const batch = files.slice(i, i + IO_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (sourcePath) => {
        const stat = await fs.stat(sourcePath);
        const relativePath = toPosix(path.relative(mediaRoot, sourcePath));
        const sidecarPath = await findSidecarPath(sourcePath);
        const capturedAtDate = await deriveCapturedDate(sourcePath, sidecarPath);
        const capturedAt = capturedAtDate
          ? capturedAtDate.toISOString()
          : stat.mtime.toISOString();
        const datePath = capturedAtDate
          ? toDatePath(capturedAtDate)
          : 'unknown-date';
        const destinationKey = `transfers/${datePath}/${sanitizeRelativePath(relativePath)}`;

        return {
          sourcePath,
          relativePath,
          sidecarPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          capturedAt,
          datePath,
          destinationKey,
        };
      }),
    );
    entries.push(...batchResults);
    onProgress?.(Math.min(i + batch.length, files.length), files.length);
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

export async function persistManifestJsonl(
  entries: ManifestEntry[],
  manifestPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const lines = entries.map((entry) => JSON.stringify(entry));
  await fs.writeFile(manifestPath, `${lines.join('\n')}\n`, 'utf8');
}

export async function loadManifestJsonl(manifestPath: string): Promise<ManifestEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const entries: ManifestEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      entries.push(JSON.parse(line) as ManifestEntry);
    } catch {
      console.warn(`[manifest] Skipping malformed line in ${manifestPath}: ${line.slice(0, 120)}`);
    }
  }
  return entries;
}

async function listMediaFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      console.warn(`[manifest] Skipping unreadable directory: ${current}`, (err as Error).message);
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (isMediaFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function isMediaFile(fileName: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function findSidecarPath(sourcePath: string): Promise<string | undefined> {
  const parsed = path.parse(sourcePath);
  const candidates = [
    `${sourcePath}.json`,
    path.join(parsed.dir, `${parsed.name}.json`),
    `${sourcePath}.supplemental-metadata.json`,
  ];

  // For __dupN files, also try sidecar paths matching the original filename.
  // e.g. IMG_0057__dup1.MOV → look for IMG_0057.MOV.json / IMG_0057.MOV.supplemental-metadata.json
  const dupMatch = parsed.name.match(/^(.+?)__dup\d+$/);
  if (dupMatch) {
    const originalBase = dupMatch[1];
    const originalFull = path.join(parsed.dir, `${originalBase}${parsed.ext}`);
    const originalParsed = path.parse(originalFull);
    candidates.push(
      `${originalFull}.json`,
      path.join(originalParsed.dir, `${originalParsed.name}.json`),
      `${originalFull}.supplemental-metadata.json`,
    );
  }

  // Check all candidates in parallel — return the first that exists
  const results = await Promise.all(candidates.map((c) => exists(c).then((ok) => ok ? c : null)));
  return results.find((r) => r !== null) ?? undefined;
}

/** Max bytes to read for EXIF parsing — headers are always at the start of the file */
const EXIF_READ_BYTES = 256 * 1024;

async function deriveCapturedDate(
  sourcePath: string,
  sidecarPath: string | undefined,
): Promise<Date | undefined> {
  // 1. Prefer the Google Takeout sidecar JSON (photoTakenTime / creationTime)
  if (sidecarPath) {
    const fromSidecar = await readSidecarDate(sidecarPath);
    if (fromSidecar) return fromSidecar;
  }

  // 2. Try to infer capture date from the filename (e.g. 20201217_155747.mp4, IMG_20231215_143022.MOV)
  const filename = path.basename(sourcePath);
  const fromFilename = inferDateFromFilename(filename);
  if (fromFilename) return fromFilename;

  // 3. Try EXIF metadata embedded in the file (DateTimeOriginal / CreateDate)
  try {
    const fd = await fs.open(sourcePath, 'r');
    try {
      const buf = Buffer.alloc(EXIF_READ_BYTES);
      const { bytesRead } = await fd.read(buf, 0, EXIF_READ_BYTES, 0);
      const exif = await extractExifMetadata(buf.subarray(0, bytesRead));
      if (exif.capturedAt) return exif.capturedAt;
    } finally {
      await fd.close();
    }
  } catch {
    // EXIF extraction failed — continue to fallback
  }

  // 4. Try video container metadata (MP4/MOV moov/mvhd creation_time)
  const fromVideo = await extractVideoCreationDate(sourcePath);
  if (fromVideo) return fromVideo;

  // 5. No reliable date found — return undefined so the caller can use
  //    an 'unknown-date' path rather than silently filing under today's date.
  return undefined;
}

async function readSidecarDate(sidecarPath: string): Promise<Date | undefined> {
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const timestampCandidates = [
      getNestedString(parsed, ['photoTakenTime', 'timestamp']),
      getNestedString(parsed, ['creationTime', 'timestamp']),
      getNestedString(parsed, ['image', 'creationTime', 'timestamp']),
    ];

    for (const candidate of timestampCandidates) {
      if (!candidate) continue;
      const asNumber = Number(candidate);
      if (Number.isFinite(asNumber) && asNumber > 0) {
        return new Date(asNumber * 1000);
      }
    }

    const isoCandidates = [
      getNestedString(parsed, ['photoTakenTime', 'formatted']),
      getNestedString(parsed, ['creationTime', 'formatted']),
      getNestedString(parsed, ['creationTime']),
    ];

    for (const candidate of isoCandidates) {
      if (!candidate) continue;
      const date = new Date(candidate);
      if (!Number.isNaN(date.getTime())) return date;
    }
  } catch (err) {
    console.debug('[manifest] Failed to parse sidecar metadata', err);
    // ignore malformed sidecar and fall back to file metadata
  }

  return undefined;
}

function getNestedString(obj: Record<string, unknown>, pathParts: string[]): string | undefined {
  let current: unknown = obj;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return typeof current === 'string' ? current : undefined;
}

function toDatePath(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function sanitizeRelativePath(relativePath: string): string {
  return toPosix(relativePath)
    .split('/')
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('/');
}

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    // ENOENT is the expected/normal case — sidecar file simply doesn't exist.
    // Only log genuinely unexpected errors (permission denied, etc.).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[manifest] Path not accessible', { filePath, err });
    }
    return false;
  }
}

// ── Content-based manifest deduplication ─────────────────────────────────────

/**
 * How many bytes of each file to hash for the fast fingerprint.
 * 64 KB is enough to identify media files with virtually zero false positives
 * while staying fast even for multi-GB video files.
 */
const PARTIAL_HASH_BYTES = 64 * 1024;

export type DeduplicateManifestResult = {
  /** Entries that survived dedup — one per unique content. */
  entries: ManifestEntry[];
  /** Number of duplicate entries that were removed. */
  removedCount: number;
  /** Total bytes of duplicate entries that were removed. */
  removedBytes: number;
};

/**
 * Score a manifest entry for "keep" priority when deduplicating.
 * Higher score = more desirable to keep.
 *
 * Prefers:
 * - Entries whose destination key has a clean date path (2020/03/15/)
 * - Shorter destination keys (less nesting / cleaner path)
 * - Non-__dup filenames
 */
export function scoreEntryForKeep(entry: ManifestEntry): number {
  let score = 0;

  // Proper date path at the start of the key (after optional transfers/ prefix)
  if (/^(?:transfers\/)?(?:19|20)\d{2}\/\d{2}\/\d{2}\//.test(entry.destinationKey)) {
    score += 10;
  }

  // Penalise deep nesting
  const depth = (entry.destinationKey.match(/\//g) ?? []).length;
  score -= depth;

  // Penalise __dup files — they're Takeout artefacts for filename collisions
  if (/__dup\d+/.test(entry.relativePath)) {
    score -= 20;
  }

  return score;
}

/**
 * Compute a fast 64 KB partial-content hash for a local file.
 * For files smaller than 64 KB the entire content is hashed.
 * Returns a hex-encoded SHA-256 digest.
 */
export function partialFileHash(filePath: string, bytes = PARTIAL_HASH_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, { start: 0, end: bytes - 1 });
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Remove duplicate entries from a manifest by content fingerprint (file size + partial hash).
 *
 * Google Takeout exports the same photo/video into multiple album folders.
 * Because each folder produces a different relative path (and thus a different S3 destination key),
 * the uploader's key-based existence check cannot catch these cross-path duplicates.
 *
 * This function:
 * 1. Groups entries by file size (zero-cost — no I/O).
 * 2. For same-size groups, hashes the first 64 KB of each file to build a content fingerprint.
 * 3. For each set of content-identical entries, keeps the highest-scored entry
 *    (cleanest date path, shortest key, non-__dup filename).
 *
 * @returns The deduplicated manifest plus removal stats.
 */
export async function deduplicateManifest(
  entries: ManifestEntry[],
  onProgress?: ManifestProgressCallback,
): Promise<DeduplicateManifestResult> {
  if (entries.length === 0) {
    return { entries: [], removedCount: 0, removedBytes: 0 };
  }

  // Phase 1 — group by file size (instant, no I/O)
  const sizeGroups = new Map<number, ManifestEntry[]>();
  for (const entry of entries) {
    const list = sizeGroups.get(entry.size);
    if (list) {
      list.push(entry);
    } else {
      sizeGroups.set(entry.size, [entry]);
    }
  }

  // Entries whose size is unique cannot be duplicates — keep them immediately
  const kept: ManifestEntry[] = [];
  const needsHash: ManifestEntry[] = [];

  for (const group of sizeGroups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
    } else {
      needsHash.push(...group);
    }
  }

  // Phase 2 — for same-size entries, compute partial hash and fingerprint
  let hashed = 0;
  const total = needsHash.length;
  const fingerprintGroups = new Map<string, ManifestEntry[]>();

  for (let i = 0; i < needsHash.length; i += IO_CONCURRENCY) {
    const batch = needsHash.slice(i, i + IO_CONCURRENCY);
    const hashes = await Promise.all(
      batch.map(async (entry) => {
        try {
          return await partialFileHash(entry.sourcePath);
        } catch {
          // If we can't read the file, give it a unique fingerprint so it's never wrongly deduped
          return `unhashable:${entry.sourcePath}`;
        }
      }),
    );

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const fp = `${entry.size}:${hashes[j]}`;
      const list = fingerprintGroups.get(fp);
      if (list) {
        list.push(entry);
      } else {
        fingerprintGroups.set(fp, [entry]);
      }
    }

    hashed += batch.length;
    onProgress?.(hashed, total);
  }

  // Phase 3 — pick the best entry from each fingerprint group
  let removedCount = 0;
  let removedBytes = 0;

  for (const group of fingerprintGroups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }

    // Sort by score descending, then by destinationKey for determinism
    group.sort((a, b) => {
      const scoreDiff = scoreEntryForKeep(b) - scoreEntryForKeep(a);
      if (scoreDiff !== 0) return scoreDiff;
      return a.destinationKey.localeCompare(b.destinationKey);
    });

    kept.push(group[0]); // keep the best one
    for (let i = 1; i < group.length; i++) {
      removedCount += 1;
      removedBytes += group[i].size;
    }
  }

  // Restore deterministic ordering
  kept.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return { entries: kept, removedCount, removedBytes };
}
