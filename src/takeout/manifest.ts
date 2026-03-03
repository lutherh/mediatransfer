import path from 'node:path';
import fs from 'node:fs/promises';
import { inferDateFromFilename } from '../utils/exif.js';

const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.heic', '.heif', '.avif', '.dng', '.tif', '.tiff',
  '.mp4', '.mov', '.avi', '.m4v', '.3gp', '.mkv', '.webm',
]);

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
        const capturedAtDate = await deriveCapturedDate(sourcePath, sidecarPath, stat.mtime);
        const capturedAt = capturedAtDate.toISOString();
        const datePath = toDatePath(capturedAtDate);
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
  const content = await fs.readFile(manifestPath, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ManifestEntry);
}

async function listMediaFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
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

async function deriveCapturedDate(
  sourcePath: string,
  sidecarPath: string | undefined,
  fallbackDate: Date,
): Promise<Date> {
  // 1. Prefer the Google Takeout sidecar JSON (photoTakenTime / creationTime)
  if (sidecarPath) {
    const fromSidecar = await readSidecarDate(sidecarPath);
    if (fromSidecar) return fromSidecar;
  }

  // 2. Try to infer capture date from the filename (e.g. 20201217_155747.mp4, IMG_20231215_143022.MOV)
  const filename = path.basename(sourcePath);
  const fromFilename = inferDateFromFilename(filename);
  if (fromFilename) return fromFilename;

  // 3. Last resort: file modification time
  return fallbackDate;
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
  } catch {
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
  } catch {
    return false;
  }
}
