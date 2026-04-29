import path from 'node:path';
import fs from 'node:fs/promises';
import extractZip from 'extract-zip';
import { extract as extractTar } from 'tar';
import { partialFileHash } from './manifest.js';
import { MEDIA_EXTENSIONS } from '../utils/media-extensions.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger().child({ module: 'unpack' });

const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz'] as const;

export type ArchiveExtractor = (archivePath: string, destinationDir: string) => Promise<void>;

export type UnpackResult = {
  archives: string[];
  mediaRoot: string;
};

export type ExtractProgressCallback = (current: number, total: number, archiveName: string) => void;
export type NormalizeProgressCallback = (processed: number, total: number, fileName: string) => void;

/**
 * Discover Google Takeout archive files in input directory.
 */
export async function discoverTakeoutArchives(inputDir: string): Promise<string[]> {
  await fs.mkdir(inputDir, { recursive: true });
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => hasArchiveExtension(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(inputDir, name));
}

/**
 * Extract all discovered archives into the work directory.
 */
export async function extractTakeoutArchives(
  archivePaths: string[],
  workDir: string,
  extractor: ArchiveExtractor = extractArchive,
  onProgress?: ExtractProgressCallback,
): Promise<void> {
  await fs.mkdir(workDir, { recursive: true });

  for (let i = 0; i < archivePaths.length; i++) {
    const archivePath = archivePaths[i];
    onProgress?.(i + 1, archivePaths.length, path.basename(archivePath));
    await extractor(archivePath, workDir);
  }
}

/**
 * Default archive extractor for zip/tar/tgz files.
 */
export async function extractArchive(
  archivePath: string,
  destinationDir: string,
): Promise<void> {
  const normalized = archivePath.toLowerCase();

  if (normalized.endsWith('.zip')) {
    await extractZip(archivePath, { dir: destinationDir });
    return;
  }

  if (normalized.endsWith('.tar') || normalized.endsWith('.tgz') || normalized.endsWith('.tar.gz')) {
    await extractTar({
      file: archivePath,
      cwd: destinationDir,
    });
    return;
  }

  throw new Error(`Unsupported archive format: ${archivePath}`);
}

/**
 * Normalize extracted Takeout folders into one canonical media root.
 *
 * Returns `${workDir}/normalized/Google Photos`.
 */
export async function normalizeTakeoutMediaRoot(
  workDir: string,
  onProgress?: NormalizeProgressCallback,
): Promise<string> {
  const normalizedRoot = path.join(workDir, 'normalized', 'Google Photos');
  const normalizedPrefix = path.join(workDir, 'normalized') + path.sep;

  // Exclude the normalized/ directory itself so re-runs don't merge it into itself
  const allRoots = await findGooglePhotosRoots(workDir);
  const roots = allRoots.filter((r) => !r.startsWith(normalizedPrefix));
  if (roots.length === 0) {
    throw new Error(`No Google Photos folders found in work directory: ${workDir}`);
  }

  await fs.mkdir(normalizedRoot, { recursive: true });

  // Count total files across all roots for progress reporting
  let totalFiles = 0;
  if (onProgress) {
    for (const root of roots) {
      totalFiles += await countFilesRecursive(root);
    }
  }

  let processed = 0;
  const progressWrapper = onProgress
    ? (fileName: string) => { processed++; onProgress(processed, totalFiles, fileName); }
    : undefined;

  for (const root of roots) {
    await mergeDirectory(root, normalizedRoot, progressWrapper);
  }

  return normalizedRoot;
}

/**
 * Merge one extracted archive into persistent normalized storage.
 *
 * Standard Takeout archives are merged into `${normalizedDir}/Google Photos`.
 * Archives with media but without a `Google Photos` root are merged into
 * `normalizedDir` preserving their relative structure.
 */
export async function mergeExtractedArchiveIntoNormalized(
  extractDir: string,
  normalizedDir: string,
  onProgress?: NormalizeProgressCallback,
): Promise<{ mediaRoot: string; movedMedia: boolean }> {
  const normalizedPhotosRoot = path.join(normalizedDir, 'Google Photos');
  const roots = await findGooglePhotosRoots(extractDir);

  if (roots.length > 0) {
    await fs.mkdir(normalizedPhotosRoot, { recursive: true });

    let totalFiles = 0;
    if (onProgress) {
      for (const root of roots) {
        totalFiles += await countFilesRecursive(root);
      }
    }

    let processed = 0;
    const progressWrapper = onProgress
      ? (fileName: string) => { processed++; onProgress(processed, totalFiles, fileName); }
      : undefined;

    for (const root of roots) {
      await mergeDirectory(root, normalizedPhotosRoot, progressWrapper);
    }

    return {
      mediaRoot: normalizedPhotosRoot,
      movedMedia: true,
    };
  }

  const hasMediaInExtractDir = await containsMediaFiles(extractDir);
  if (!hasMediaInExtractDir) {
    return {
      mediaRoot: normalizedPhotosRoot,
      movedMedia: false,
    };
  }

  await fs.mkdir(normalizedDir, { recursive: true });

  const totalFiles = onProgress ? await countFilesRecursive(extractDir) : 0;
  let processed = 0;
  const progressWrapper = onProgress
    ? (fileName: string) => { processed++; onProgress(processed, totalFiles, fileName); }
    : undefined;

  await mergeDirectory(extractDir, normalizedDir, progressWrapper);

  return {
    mediaRoot: normalizedDir,
    movedMedia: true,
  };
}

/**
 * One-shot helper for Step 12: discover, extract, and normalize.
 */
export async function unpackAndNormalizeTakeout(
  inputDir: string,
  workDir: string,
  extractor: ArchiveExtractor = extractArchive,
  onExtractProgress?: ExtractProgressCallback,
): Promise<UnpackResult> {
  const archives = await discoverTakeoutArchives(inputDir);
  if (archives.length === 0) {
    const hasDirectMedia = await containsMediaFiles(inputDir);
    if (hasDirectMedia) {
      return {
        archives: [],
        mediaRoot: inputDir,
      };
    }

    throw new Error(
      `No Takeout archives found in input directory: ${inputDir}. ` +
        'Place one or more Google Takeout .zip/.tar/.tgz archives there and run takeout:scan again.',
    );
  }

  await extractTakeoutArchives(archives, workDir, extractor, onExtractProgress);

  const roots = await findGooglePhotosRoots(workDir);
  if (roots.length > 0) {
    const mediaRoot = await normalizeTakeoutMediaRoot(workDir);
    return { archives, mediaRoot };
  }

  const hasMediaInWorkDir = await containsMediaFiles(workDir);
  if (hasMediaInWorkDir) {
    return {
      archives,
      mediaRoot: workDir,
    };
  }

  const hasArchiveBrowser = await exists(path.join(workDir, 'Takeout', 'archive_browser.html'));
  if (hasArchiveBrowser) {
    throw new Error(buildMetadataOnlyError(archives, inputDir));
  }

  throw new Error(buildNoMediaError(archives, inputDir));
}

/**
 * Find extracted Google Photos roots recursively.
 */
export async function findGooglePhotosRoots(workDir: string): Promise<string[]> {
  const roots: string[] = [];
  await walkDirectories(workDir, async (dirPath, name) => {
    if (name.toLowerCase() === 'google photos') {
      roots.push(dirPath);
    }
  });

  roots.sort((a, b) => a.localeCompare(b));
  return roots;
}

function hasArchiveExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function walkDirectories(
  baseDir: string,
  onDirectory: (dirPath: string, name: string) => Promise<void>,
): Promise<void> {
  const stack = [baseDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      log.warn({ current, err: (err as Error).message }, '[unpack] Skipping unreadable directory');
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const child = path.join(current, entry.name);
      await onDirectory(child, entry.name);
      stack.push(child);
    }
  }
}

async function mergeDirectory(
  sourceDir: string,
  targetDir: string,
  onFile?: (fileName: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    log.warn({ sourceDir, err: (err as Error).message }, '[unpack] Skipping unreadable directory');
    return;
  }

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    try {
      if (entry.isDirectory()) {
        await fs.mkdir(targetPath, { recursive: true });
        await mergeDirectory(sourcePath, targetPath, onFile);
        continue;
      }

      if (entry.isFile()) {
        await moveWithCollisionHandling(sourcePath, targetPath);
        onFile?.(entry.name);
      }
    } catch (err) {
      log.warn({ sourcePath, err: (err as Error).message }, '[unpack] Skipping file due to error');
    }
  }
}

/**
 * Move a file to targetPath, handling collisions by deduplication.
 * Uses fs.rename for same-device moves (instant, no extra disk space).
 * Falls back to copy+delete for cross-device moves.
 */
async function moveWithCollisionHandling(sourcePath: string, targetPath: string): Promise<void> {
  if (!(await exists(targetPath))) {
    await moveFile(sourcePath, targetPath);
    return;
  }

  // Target exists — check if it's the same content (fast: size then partial hash)
  if (await isSameContent(sourcePath, targetPath)) {
    // Duplicate — remove source instead of copying
    await fs.unlink(sourcePath);
    return;
  }

  // Different content with same name — find a free __dup slot
  let candidate: string;
  let suffix = 1;
  do {
    const parsed = path.parse(targetPath);
    candidate = path.join(parsed.dir, `${parsed.name}__dup${suffix}${parsed.ext}`);
    suffix += 1;
  } while (await exists(candidate));

  await moveFile(sourcePath, candidate);
}

/**
 * Move a file using rename (instant on same device), falling back to copy+delete.
 */
async function moveFile(sourcePath: string, destPath: string): Promise<void> {
  try {
    await fs.rename(sourcePath, destPath);
  } catch (err) {
    // EXDEV = cross-device link; fall back to copy + delete
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.copyFile(sourcePath, destPath);
      await fs.unlink(sourcePath);
    } else {
      throw err;
    }
  }
}

/** Compare two files by size then partial hash (first 64 KB). */
async function isSameContent(fileA: string, fileB: string): Promise<boolean> {
  const [statA, statB] = await Promise.all([fs.stat(fileA), fs.stat(fileB)]);
  if (statA.size !== statB.size) return false;
  const [hashA, hashB] = await Promise.all([partialFileHash(fileA), partialFileHash(fileB)]);
  return hashA === hashB;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    // ENOENT is the expected case — file simply doesn't exist yet.
    // Only log genuinely unexpected access errors (permissions etc.).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ filePath, err }, '[unpack] Path not accessible');
    }
    return false;
  }
}

async function countFilesRecursive(dir: string): Promise<number> {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      log.warn({ current, err: (err as Error).message }, '[unpack] Skipping unreadable directory');
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else if (entry.isFile()) count++;
    }
  }
  return count;
}

async function containsMediaFiles(rootDir: string): Promise<boolean> {
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      log.warn({ current, err: (err as Error).message }, '[unpack] Skipping unreadable directory');
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

export { containsMediaFiles };

/**
 * Detect multi-part archive naming patterns like `-001.tgz`, `-002.zip`, etc.
 * Returns the part numbers found, or empty if no pattern detected.
 */
export function detectArchiveParts(archivePaths: string[]): { partNumbers: number[]; isMultiPart: boolean } {
  const partPattern = /-(\d{3})\.(zip|tar|tgz|tar\.gz)$/i;
  const partNumbers: number[] = [];

  for (const archivePath of archivePaths) {
    const match = path.basename(archivePath).match(partPattern);
    if (match) {
      partNumbers.push(parseInt(match[1], 10));
    }
  }

  return {
    partNumbers: partNumbers.sort((a, b) => a - b),
    isMultiPart: partNumbers.length > 0,
  };
}

function buildMetadataOnlyError(archives: string[], inputDir: string): string {
  const { partNumbers, isMultiPart } = detectArchiveParts(archives);
  const lines: string[] = [];

  lines.push('The extracted archive(s) only contain Takeout metadata (archive_browser.html), not actual photos or videos.');
  lines.push('');

  if (isMultiPart) {
    const partsStr = partNumbers.join(', ');
    lines.push(`You have part(s): ${partsStr}`);
    lines.push('Google Takeout splits large exports into multiple numbered archives (e.g. -001.tgz, -002.tgz, -003.tgz).');
    lines.push('Part 1 typically contains only metadata. The actual photos are in the remaining parts.');
    lines.push('');
    lines.push('To fix this:');
    lines.push('  1. Go back to https://takeout.google.com and check your export');
    lines.push('  2. Download ALL parts (not just part 1)');
    lines.push(`  3. Place every .tgz/.zip file into: ${inputDir}`);
    lines.push('  4. Run takeout:scan again');
  } else {
    lines.push('This usually means the Google Takeout export is incomplete or only a partial download.');
    lines.push('');
    lines.push('To fix this:');
    lines.push('  1. Go to https://takeout.google.com and create a new export of Google Photos');
    lines.push('  2. Download ALL archive parts (exports are often split into multiple files)');
    lines.push(`  3. Place every .tgz/.zip file into: ${inputDir}`);
    lines.push('  4. Run takeout:scan again');
  }

  return lines.join('\n');
}

function buildNoMediaError(archives: string[], inputDir: string): string {
  const archiveNames = archives.map((a) => path.basename(a)).join(', ');
  const lines: string[] = [];

  lines.push(`No Google Photos folders or media files found after extracting: ${archiveNames}`);
  lines.push('');
  lines.push('This can happen if:');
  lines.push('  - The archive does not contain Google Photos data');
  lines.push('  - The Takeout export did not include Google Photos');
  lines.push('  - The archive is corrupted or incomplete');
  lines.push('');
  lines.push('To fix this:');
  lines.push('  1. Go to https://takeout.google.com');
  lines.push('  2. Make sure "Google Photos" is selected in the export options');
  lines.push('  3. Download all archive parts');
  lines.push(`  4. Place them in: ${inputDir}`);
  lines.push('  5. Run takeout:scan again');

  return lines.join('\n');
}
