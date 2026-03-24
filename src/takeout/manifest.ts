import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { inferDateFromFilename, extractExifMetadata, extractVideoCreationDate } from '../utils/exif.js';
import { isWrongDate, parseSidecarDate } from '../utils/date-repair.js';
import { MEDIA_EXTENSIONS } from '../utils/media-extensions.js';
import type { ArchiveMetadata, MediaItemMetadata } from './archive-metadata.js';

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
  let skippedCount = 0;
  for (let i = 0; i < files.length; i += IO_CONCURRENCY) {
    const batch = files.slice(i, i + IO_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (sourcePath): Promise<ManifestEntry | null> => {
        let stat;
        try {
          stat = await fs.stat(sourcePath);
        } catch (err) {
          // File was listed by readdir but can't be accessed — broken symlink,
          // encoding mismatch, antivirus quarantine, etc.  Skip it instead of
          // killing the entire scan.
          skippedCount++;
          console.warn(`[manifest] Skipping inaccessible file: ${sourcePath}`, (err as Error).message);
          return null;
        }
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
    for (const r of batchResults) {
      if (r) entries.push(r);
    }
    onProgress?.(Math.min(i + batch.length, files.length), files.length);
  }

  if (skippedCount > 0) {
    console.warn(`[manifest] ${skippedCount} file(s) skipped due to access errors`);
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
  const exactMatch = results.find((r) => r !== null);
  if (exactMatch) return exactMatch;

  // Fallback: Google Takeout truncates long paths, so
  // "IMG.jpg.supplemental-metadata.json" may become "IMG.jpg.suppl.json" etc.
  const mediaBasenames = [parsed.base];
  if (dupMatch) mediaBasenames.push(`${dupMatch[1]}${parsed.ext}`);

  for (const basename of mediaBasenames) {
    const truncated = await findTruncatedSidecar(parsed.dir, basename);
    if (truncated) return truncated;
  }

  // Fallback: encoding-variant sibling directories.
  // Google Takeout tar archives sometimes encode special characters differently
  // for media files vs sidecar JSON files, resulting in two directories for the
  // same album (e.g. "børnehaven" vs "b©rnehaven").
  const siblingDirs = await findEncodingVariantDirs(parsed.dir);
  for (const sibDir of siblingDirs) {
    // Try exact candidates in sibling dir
    const sibCandidates = [
      path.join(sibDir, `${parsed.base}.json`),
      path.join(sibDir, `${parsed.name}.json`),
      path.join(sibDir, `${parsed.base}.supplemental-metadata.json`),
    ];
    const sibResults = await Promise.all(
      sibCandidates.map((c) => exists(c).then((ok) => ok ? c : null)),
    );
    const sibMatch = sibResults.find((r) => r !== null);
    if (sibMatch) return sibMatch;

    // Try truncated variants in sibling dir
    for (const basename of mediaBasenames) {
      const sibTruncated = await findTruncatedSidecar(sibDir, basename);
      if (sibTruncated) return sibTruncated;
    }
  }

  return undefined;
}

/**
 * Search a directory for a truncated sidecar JSON file.
 * Google Takeout truncates long filenames in archives, so
 * "photo.jpg.supplemental-metadata.json" may become "photo.jpg.suppl.json",
 * "photo.jpg.supplemental-me.json", "photo.jpg.s.json", etc.
 */
async function findTruncatedSidecar(
  dir: string,
  mediaBasename: string,
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }

  const prefix = mediaBasename + '.';
  const exactFull = `${mediaBasename}.supplemental-metadata.json`;
  const exactShort = `${mediaBasename}.json`;

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (!entry.startsWith(prefix)) continue;
    // Skip candidates already tried as exact matches
    if (entry === exactFull || entry === exactShort) continue;
    return path.join(dir, entry);
  }
  return undefined;
}

/**
 * Find sibling directories whose names are encoding variants of the target.
 * Strips non-ASCII characters from both names and compares; directories that
 * differ only in their encoding of special characters will match.
 */
async function findEncodingVariantDirs(targetDir: string): Promise<string[]> {
  const parentDir = path.dirname(targetDir);
  const targetName = path.basename(targetDir);
  const normalized = normalizeForEncoding(targetName);

  // Skip if the name is pure ASCII — no encoding variants possible
  if (targetName === normalized) return [];

  try {
    const siblings = await fs.readdir(parentDir, { withFileTypes: true });
    const variants: string[] = [];
    for (const entry of siblings) {
      if (!entry.isDirectory()) continue;
      if (entry.name === targetName) continue;
      if (normalizeForEncoding(entry.name) === normalized) {
        variants.push(path.join(parentDir, entry.name));
      }
    }
    return variants;
  } catch {
    return [];
  }
}

/**
 * Strip non-ASCII characters and collapse whitespace for encoding-variant comparison.
 */
function normalizeForEncoding(name: string): string {
  return name
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Max bytes to read for EXIF parsing — headers are always at the start of the file */
const EXIF_READ_BYTES = 256 * 1024;
const IMAGE_EXTENSIONS_WITH_EMBEDDED_METADATA = new Set([
  '.jpg', '.jpeg', '.heic', '.heif', '.avif', '.png', '.tif', '.tiff', '.webp',
]);

async function deriveCapturedDate(
  sourcePath: string,
  sidecarPath: string | undefined,
): Promise<Date | undefined> {
  // Read sidecar dates once — used at two priority levels below
  let sidecarDates: SidecarDates | undefined;
  if (sidecarPath) {
    sidecarDates = await readSidecarDates(sidecarPath);
  }

  // 1. Prefer photoTakenTime from Google Takeout sidecar (actual capture timestamp)
  if (sidecarDates?.photoTakenDate && !isWrongDate(sidecarDates.photoTakenDate)) {
    return sidecarDates.photoTakenDate;
  }

  // 2. Try to infer capture date from the filename (e.g. 20201217_155747.mp4, IMG_20231215_143022.MOV)
  const filename = path.basename(sourcePath);
  const fromFilename = inferDateFromFilename(filename);
  if (fromFilename && !isWrongDate(fromFilename)) return fromFilename;

  // 3. Try EXIF metadata embedded in the file (DateTimeOriginal / CreateDate)
  try {
    const fd = await fs.open(sourcePath, 'r');
    try {
      const buf = Buffer.alloc(EXIF_READ_BYTES);
      const { bytesRead } = await fd.read(buf, 0, EXIF_READ_BYTES, 0);
      const exif = await extractExifMetadata(buf.subarray(0, bytesRead));
      if (exif.capturedAt && !isWrongDate(exif.capturedAt)) return exif.capturedAt;
    } finally {
      await fd.close();
    }
  } catch {
    // EXIF extraction failed — continue to fallback
  }

  // Some formats store metadata beyond the first chunk. Re-read from disk only
  // for image types when the fast header parse didn't find a usable timestamp.
  if (IMAGE_EXTENSIONS_WITH_EMBEDDED_METADATA.has(path.extname(sourcePath).toLowerCase())) {
    try {
      const fullBuffer = await fs.readFile(sourcePath);
      const exif = await extractExifMetadata(fullBuffer);
      if (exif.capturedAt && !isWrongDate(exif.capturedAt)) return exif.capturedAt;
    } catch {
      // Full-file metadata extraction failed — continue to fallback
    }
  }

  // 4. Try video container metadata (MP4/MOV moov/mvhd creation_time)
  const fromVideo = await extractVideoCreationDate(sourcePath);
  if (fromVideo && !isWrongDate(fromVideo)) return fromVideo;

  // 5. Sidecar creationTime as last resort — only when photoTakenTime was absent.
  //    creationTime is "when added to Google Photos", not capture date, so it's
  //    less reliable but better than nothing when all other sources fail.
  if (sidecarDates && !sidecarDates.hasPhotoTakenTime &&
      sidecarDates.creationDate && !isWrongDate(sidecarDates.creationDate)) {
    return sidecarDates.creationDate;
  }

  // 6. No reliable date found — return undefined so the caller can use
  //    an 'unknown-date' path rather than silently filing under today's date.
  return undefined;
}

type SidecarDates = {
  photoTakenDate?: Date;
  creationDate?: Date;
  /** Whether the photoTakenTime field existed in the sidecar JSON at all */
  hasPhotoTakenTime: boolean;
};

async function readSidecarDates(sidecarPath: string): Promise<SidecarDates> {
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const hasPhotoTakenTime = 'photoTakenTime' in parsed;
    const photoTakenDate = parseSidecarField(parsed, ['photoTakenTime']);
    const creationDate = parseSidecarField(parsed, ['creationTime'])
      ?? parseSidecarField(parsed, ['image', 'creationTime']);

    return { photoTakenDate, creationDate, hasPhotoTakenTime };
  } catch (err) {
    console.debug('[manifest] Failed to parse sidecar metadata', err);
    return { hasPhotoTakenTime: false };
  }
}

function parseSidecarField(obj: Record<string, unknown>, fieldPath: string[]): Date | undefined {
  // Try numeric timestamp (seconds since epoch)
  const timestamp = getNestedString(obj, [...fieldPath, 'timestamp']);
  if (timestamp) {
    const asNumber = Number(timestamp);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return new Date(asNumber * 1000);
    }
  }

  // Try formatted date string
  const formatted = getNestedString(obj, [...fieldPath, 'formatted']);
  if (formatted) {
    const d = new Date(formatted);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Try direct string value (some sidecars store dates as plain strings)
  const direct = getNestedString(obj, fieldPath);
  if (direct) {
    const d = new Date(direct);
    if (!Number.isNaN(d.getTime())) return d;
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

// ── Post-build date refinement using archive metadata ────────────────────────

export type RefineDateResult = {
  /** Updated entries (mutated in place for performance). */
  entries: ManifestEntry[];
  /** How many entries had their date improved. */
  refinedCount: number;
  /** Breakdown by resolution strategy. */
  breakdown: {
    editedToOriginal: number;
    basenameMatch: number;
    stemCrossExtension: number;
    albumMedian: number;
  };
};

type DatedMetadataItem = Pick<MediaItemMetadata, 'destinationKey' | 'relativePath' | 'album' | 'sizeBytes' | 'sidecar'>;

type DateRefinementIndexes = {
  itemsByBasename: Map<string, DatedMetadataItem[]>;
  itemsByStem: Map<string, DatedMetadataItem[]>;
  albumMedian: Map<string, Date>;
};

function buildDateRefinementIndexes(metadataSources: ArchiveMetadata[]): DateRefinementIndexes {
  const itemsByBasename = new Map<string, DatedMetadataItem[]>();
  const itemsByStem = new Map<string, DatedMetadataItem[]>();
  const albumDates = new Map<string, Date[]>();

  for (const metadata of metadataSources) {
    for (const item of metadata.items) {
      if (!item.sidecar) continue;

      const parsedDate = parseSidecarDate(item.sidecar);
      if (!parsedDate || isWrongDate(parsedDate)) continue;

      const basename = item.destinationKey.split('/').pop()!;
      const stem = basename.replace(/\.[^.]+$/, '');
      const datedItem: DatedMetadataItem = item;

      if (!itemsByBasename.has(basename)) itemsByBasename.set(basename, []);
      itemsByBasename.get(basename)!.push(datedItem);

      if (!itemsByStem.has(stem)) itemsByStem.set(stem, []);
      itemsByStem.get(stem)!.push(datedItem);

      if (item.album) {
        if (!albumDates.has(item.album)) albumDates.set(item.album, []);
        albumDates.get(item.album)!.push(parsedDate);
      }
    }
  }

  const albumMedian = new Map<string, Date>();
  for (const [album, dates] of albumDates) {
    if (dates.length < 2) continue;
    dates.sort((a, b) => a.getTime() - b.getTime());
    albumMedian.set(album, dates[Math.floor(dates.length / 2)]);
  }

  return { itemsByBasename, itemsByStem, albumMedian };
}

function resolveConsistentMetadataDate(
  candidates: DatedMetadataItem[] | undefined,
  expectedSize?: number,
): Date | undefined {
  if (!candidates || candidates.length === 0) return undefined;

  let pool = candidates;
  if (expectedSize !== undefined) {
    const sizeMatched = candidates.filter((candidate) => candidate.sizeBytes === expectedSize);
    if (sizeMatched.length > 0) {
      pool = sizeMatched;
    }
  }

  const uniqueDates = new Map<number, Date>();
  for (const candidate of pool) {
    if (!candidate.sidecar) continue;
    const parsed = parseSidecarDate(candidate.sidecar);
    if (parsed && !isWrongDate(parsed)) {
      uniqueDates.set(parsed.getTime(), parsed);
    }
  }

  if (uniqueDates.size !== 1) return undefined;
  return [...uniqueDates.values()][0];
}

function deriveAlbumFromRelativePath(relativePath: string): string | undefined {
  const parts = relativePath.split('/');
  if (parts.length < 2) return undefined;
  const album = parts[0];
  if (/^Photos from \d{4}$/i.test(album)) return undefined;
  return album;
}

function applyResolvedDate(
  entry: ManifestEntry,
  resolvedDate: Date,
  source: keyof RefineDateResult['breakdown'],
  breakdown: RefineDateResult['breakdown'],
): void {
  const newDatePath = toDatePath(resolvedDate);
  const albumFile = entry.destinationKey.split('/').slice(4).join('/');
  entry.capturedAt = resolvedDate.toISOString();
  entry.datePath = newDatePath;
  entry.destinationKey = `transfers/${newDatePath}/${albumFile || sanitizeRelativePath(entry.relativePath)}`;
  breakdown[source] += 1;
}

export function refineDatesFromAllMetadata(
  entries: ManifestEntry[],
  metadataSources: ArchiveMetadata[],
): RefineDateResult {
  const breakdown = { editedToOriginal: 0, basenameMatch: 0, stemCrossExtension: 0, albumMedian: 0 };
  let refinedCount = 0;

  const indexes = buildDateRefinementIndexes(metadataSources);

  for (const entry of entries) {
    const entryDate = new Date(entry.capturedAt);
    if (!isWrongDate(entryDate) && entry.datePath !== 'unknown-date') continue;

    const filename = entry.destinationKey.split('/').pop() ?? '';
    const stem = filename.replace(/\.[^.]+$/, '');
    let resolvedDate: Date | undefined;
    let source: keyof RefineDateResult['breakdown'] | undefined;

    if (filename.includes('-edited')) {
      const nonEditedName = filename.replace('-edited', '');
      resolvedDate = resolveConsistentMetadataDate(indexes.itemsByBasename.get(nonEditedName));
      if (!resolvedDate) {
        const nonEditedStem = nonEditedName.replace(/\.[^.]+$/, '');
        resolvedDate = resolveConsistentMetadataDate(indexes.itemsByStem.get(nonEditedStem));
      }
      if (resolvedDate) {
        source = 'editedToOriginal';
      }
    }

    if (!resolvedDate) {
      resolvedDate = resolveConsistentMetadataDate(indexes.itemsByBasename.get(filename), entry.size);
      if (resolvedDate) {
        source = 'basenameMatch';
      }
    }

    if (!resolvedDate) {
      resolvedDate = resolveConsistentMetadataDate(indexes.itemsByStem.get(stem));
      if (resolvedDate) {
        source = 'stemCrossExtension';
      }
    }

    if (!resolvedDate) {
      const album = deriveAlbumFromRelativePath(entry.relativePath);
      const median = album ? indexes.albumMedian.get(album) : undefined;
      if (median) {
        resolvedDate = median;
        source = 'albumMedian';
      }
    }

    if (resolvedDate && source) {
      applyResolvedDate(entry, resolvedDate, source, breakdown);
      refinedCount += 1;
    }
  }

  return { entries, refinedCount, breakdown };
}

/**
 * Second-pass date resolution using archive metadata sidecars.
 *
 * Runs after `buildManifest()` + `extractAndPersistArchiveMetadata()` to fix
 * entries that ended up with wrong dates (mtime / extraction date) because
 * their sidecar couldn't be found via local file path matching.
 *
 * Additional strategies (not available during first-pass `deriveCapturedDate`):
 *
 *   1. **Edited → non-edited sidecar** — `IMG_1234-edited.jpg` gets date from
 *      `IMG_1234.jpg`'s sidecar.
 *   2. **Stem cross-extension** — `IMG_0917.MP4` gets date from `IMG_0917.JPG`'s
 *      sidecar when the same photo/video pair exists.
 *   3. **Album median** — Files in an album with many dated items get the
 *      album's median capture date as a fallback.
 */
export function refineDatesFromMetadata(
  entries: ManifestEntry[],
  metadata: ArchiveMetadata,
): RefineDateResult {
  return refineDatesFromAllMetadata(entries, [metadata]);
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
