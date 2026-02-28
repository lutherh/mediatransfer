import path from 'node:path';
import fs from 'node:fs/promises';
import extractZip from 'extract-zip';
import { extract as extractTar } from 'tar';

const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz'] as const;
const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.heic', '.heif', '.avif', '.dng', '.tif', '.tiff',
  '.mp4', '.mov', '.avi', '.m4v', '.3gp', '.mkv', '.webm',
]);

export type ArchiveExtractor = (archivePath: string, destinationDir: string) => Promise<void>;

export type UnpackResult = {
  archives: string[];
  mediaRoot: string;
};

export type ExtractProgressCallback = (current: number, total: number, archiveName: string) => void;

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
export async function normalizeTakeoutMediaRoot(workDir: string): Promise<string> {
  const roots = await findGooglePhotosRoots(workDir);
  if (roots.length === 0) {
    throw new Error(`No Google Photos folders found in work directory: ${workDir}`);
  }

  const normalizedRoot = path.join(workDir, 'normalized', 'Google Photos');
  await fs.mkdir(normalizedRoot, { recursive: true });

  for (const root of roots) {
    await mergeDirectory(root, normalizedRoot);
  }

  return normalizedRoot;
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

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const child = path.join(current, entry.name);
      await onDirectory(child, entry.name);
      stack.push(child);
    }
  }
}

async function mergeDirectory(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(targetPath, { recursive: true });
      await mergeDirectory(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await copyWithCollisionHandling(sourcePath, targetPath);
    }
  }
}

async function copyWithCollisionHandling(sourcePath: string, targetPath: string): Promise<void> {
  let candidate = targetPath;
  let suffix = 1;

  while (await exists(candidate)) {
    const parsed = path.parse(targetPath);
    candidate = path.join(parsed.dir, `${parsed.name}__dup${suffix}${parsed.ext}`);
    suffix += 1;
  }

  await fs.copyFile(sourcePath, candidate);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function containsMediaFiles(rootDir: string): Promise<boolean> {
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = await fs.readdir(current, { withFileTypes: true });
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function getTotalArchiveSize(archivePaths: string[]): Promise<number> {
  let total = 0;
  for (const p of archivePaths) {
    try {
      const stat = await fs.stat(p);
      total += stat.size;
    } catch {
      // skip if inaccessible
    }
  }
  return total;
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
