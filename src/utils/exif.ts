import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import exifr from 'exifr';
import { VIDEO_EXTENSIONS } from './media-extensions.js';
const CAPTURED_AT_TAGS = [
  'DateTimeOriginal',
  'SubSecDateTimeOriginal',
  'CreateDate',
  'DateTimeDigitized',
  'DateCreated',
  'CreationDate',
  'CreationTime',
  'ContentCreateDate',
  'MediaCreateDate',
  'TrackCreateDate',
] as const;

export type ExifMetadata = {
  /** Original capture date from EXIF DateTimeOriginal / CreateDate / DateTimeDigitized */
  capturedAt?: Date;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
  /** Camera make */
  make?: string;
  /** Camera model */
  model?: string;
  /** GPS latitude */
  latitude?: number;
  /** GPS longitude */
  longitude?: number;
};

/**
 * Extract EXIF metadata from an image buffer.
 * Returns whatever metadata is available; never throws.
 */
export async function extractExifMetadata(source: Buffer | string): Promise<ExifMetadata> {
  try {
    const exif = await exifr.parse(source, {
      pick: [
        ...CAPTURED_AT_TAGS,
        'ImageWidth',
        'ImageHeight',
        'ExifImageWidth',
        'ExifImageHeight',
        'Make',
        'Model',
        'GPSLatitude',
        'GPSLongitude',
      ],
      exif: true,
      iptc: true,
      tiff: true,
      xmp: true,
      // Enable GPS parsing
      gps: true,
    });

    if (!exif) {
      return {};
    }

    const capturedAt = pickCapturedAt(exif);
    const width = exif.ExifImageWidth ?? exif.ImageWidth;
    const height = exif.ExifImageHeight ?? exif.ImageHeight;

    return {
      capturedAt: capturedAt ?? undefined,
      width: typeof width === 'number' ? width : undefined,
      height: typeof height === 'number' ? height : undefined,
      make: typeof exif.Make === 'string' ? exif.Make : undefined,
      model: typeof exif.Model === 'string' ? exif.Model : undefined,
      latitude: typeof exif.latitude === 'number' ? exif.latitude : undefined,
      longitude: typeof exif.longitude === 'number' ? exif.longitude : undefined,
    };
  } catch {
    // Non-image files or corrupted EXIF — return empty
    return {};
  }
}

/**
 * Single-parse extraction that returns both structured metadata AND the full
 * raw EXIF dump. Used by the EXIF detail endpoint to avoid parsing twice.
 */
export async function extractExifMetadataFull(source: Buffer | string): Promise<{
  metadata: ExifMetadata;
  raw: Record<string, unknown> | undefined;
}> {
  try {
    const raw = await exifr.parse(source, {
      translateValues: true,
      mergeOutput: true,
      exif: true,
      iptc: true,
      tiff: true,
      xmp: true,
      gps: true,
    });

    if (!raw || typeof raw !== 'object') {
      return { metadata: {}, raw: undefined };
    }

    const capturedAt = pickCapturedAt(raw as Record<string, unknown>);
    const width = raw.ExifImageWidth ?? raw.ImageWidth;
    const height = raw.ExifImageHeight ?? raw.ImageHeight;

    const metadata: ExifMetadata = {
      capturedAt: capturedAt ?? undefined,
      width: typeof width === 'number' ? width : undefined,
      height: typeof height === 'number' ? height : undefined,
      make: typeof raw.Make === 'string' ? raw.Make : undefined,
      model: typeof raw.Model === 'string' ? raw.Model : undefined,
      latitude: typeof raw.latitude === 'number' ? raw.latitude : undefined,
      longitude: typeof raw.longitude === 'number' ? raw.longitude : undefined,
    };

    // Sanitize the raw dump: remove binary blobs, convert Dates to ISO strings
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) continue;
      sanitized[key] = value instanceof Date ? value.toISOString() : value;
    }

    return { metadata, raw: sanitized };
  } catch {
    return { metadata: {}, raw: undefined };
  }
}

function pickCapturedAt(exif: Record<string, unknown>): Date | undefined {
  for (const tag of CAPTURED_AT_TAGS) {
    const parsed = toDate(exif[tag]);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

/**
 * Try to infer a capture date from the filename using common patterns.
 * Returns null if no date pattern is found.
 *
 * Supported patterns:
 *   IMG_20231215_143022.jpg
 *   20231215_143022.jpg
 *   PXL_20231215_143022.jpg
 *   2023-12-15 14.30.22.jpg
 *   Screenshot_2023-12-15-14-30-22.png
 */
export function inferDateFromFilename(filename: string): Date | null {
  // Pattern: YYYYMMDD in various positions
  const ymdMatch = filename.match(/(\d{4})([-_]?)(\d{2})\2(\d{2})/);
  if (ymdMatch) {
    const year = Number.parseInt(ymdMatch[1], 10);
    const month = Number.parseInt(ymdMatch[3], 10);
    const day = Number.parseInt(ymdMatch[4], 10);

    if (year >= 1970 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }

  return null;
}

// ── Video container date extraction (MP4/MOV moov/mvhd) ──────────────────────

/** Seconds between 1904-01-01 and 1970-01-01 (Mac epoch used by ISO BMFF containers) */
const MAC_EPOCH_OFFSET = 2082844800;

/** How many bytes to scan for the atom layout — top-level atoms have their size in the first 8 bytes */
const ATOM_SCAN_BYTES = 32768;

/** Maximum moov atom size we'll read (2 MB) */
const MAX_MOOV_SIZE = 2 * 1024 * 1024;

function scanAtoms(buf: Buffer): Array<{ type: string; offset: number; size: number }> {
  const atoms: Array<{ type: string; offset: number; size: number }> = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);

    if (size === 0) break;
    if (size === 1 && pos + 16 <= buf.length) {
      const hi = buf.readUInt32BE(pos + 8);
      const lo = buf.readUInt32BE(pos + 12);
      size = hi * 0x100000000 + lo;
    }

    atoms.push({ type, offset: pos, size });
    pos += size;
  }
  return atoms;
}

function parseMvhdCreationTime(moovBuf: Buffer): Date | null {
  let pos = 8; // skip moov header
  while (pos + 8 <= moovBuf.length) {
    let atomSize = moovBuf.readUInt32BE(pos);
    const atomType = moovBuf.toString('ascii', pos + 4, pos + 8);

    if (atomSize === 0) break;
    if (atomSize === 1 && pos + 16 <= moovBuf.length) {
      const hi = moovBuf.readUInt32BE(pos + 8);
      const lo = moovBuf.readUInt32BE(pos + 12);
      atomSize = hi * 0x100000000 + lo;
    }

    if (atomType === 'mvhd') {
      const dataStart = pos + 8;
      if (dataStart + 4 > moovBuf.length) return null;
      const version = moovBuf.readUInt8(dataStart);

      let creationTime: number;
      if (version === 0) {
        if (dataStart + 8 > moovBuf.length) return null;
        creationTime = moovBuf.readUInt32BE(dataStart + 4);
      } else {
        if (dataStart + 12 > moovBuf.length) return null;
        const hi = moovBuf.readUInt32BE(dataStart + 4);
        const lo = moovBuf.readUInt32BE(dataStart + 8);
        creationTime = hi * 0x100000000 + lo;
      }

      if (creationTime === 0) return null;
      const unixSeconds = creationTime - MAC_EPOCH_OFFSET;
      if (unixSeconds < 0 || unixSeconds > 4102444800) return null;
      return new Date(unixSeconds * 1000);
    }

    pos += atomSize;
  }
  return null;
}

/**
 * Extract creation date from a video buffer (MP4/MOV/M4V/3GP) by parsing
 * the moov/mvhd atom. Works with partial buffers (e.g. first 256 KB from S3).
 *
 * If the moov atom is beyond the buffer (common when it's after mdat),
 * returns `{ date: null, moovOffset }` so the caller can fetch the moov
 * range from S3 and retry with `extractVideoCreationDateFromMoov`.
 */
export function extractVideoCreationDateFromBuffer(buf: Buffer): {
  date: Date | null;
  /** Set when moov wasn't in the buffer but its offset could be computed from mdat size. */
  moovOffset?: number;
} {
  if (buf.length < 8) return { date: null };

  const atoms = scanAtoms(buf);

  // moov in the scanned range
  const moovAtom = atoms.find(a => a.type === 'moov');
  if (moovAtom) {
    const moovEnd = moovAtom.offset + moovAtom.size;
    if (moovEnd <= buf.length) {
      const moovBuf = buf.subarray(moovAtom.offset, moovEnd);
      return { date: parseMvhdCreationTime(moovBuf) };
    }
    // moov starts in buffer but extends beyond — can't parse fully
    return { date: null, moovOffset: moovAtom.offset };
  }

  // moov not found — calculate its offset from mdat size
  const mdatAtom = atoms.find(a => a.type === 'mdat');
  if (mdatAtom && mdatAtom.size > 0) {
    const moovOffset = mdatAtom.offset + mdatAtom.size;
    return { date: null, moovOffset };
  }

  return { date: null };
}

/**
 * Parse creation date from a buffer that starts at the moov atom.
 * Use after fetching the range indicated by `extractVideoCreationDateFromBuffer().moovOffset`.
 */
export function extractVideoCreationDateFromMoov(moovBuf: Buffer): Date | null {
  if (moovBuf.length >= 8 && moovBuf.toString('ascii', 4, 8) === 'moov') {
    return parseMvhdCreationTime(moovBuf);
  }
  return null;
}

/**
 * Extract creation date from a video container (MP4/MOV/M4V/3GP) by parsing
 * the moov/mvhd atom directly from disk.
 *
 * Uses efficient partial reads: scans the first 32 KB for the atom layout,
 * then reads only the moov atom (which is typically small).
 * Returns null for non-video files or if no valid creation date is found.
 */
export async function extractVideoCreationDate(filePath: string): Promise<Date | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return null;

  let fd: fs.FileHandle | undefined;
  try {
    fd = await fs.open(filePath, 'r');
    const stat = await fd.stat();
    const fileSize = stat.size;
    if (fileSize < 8) return null;

    // Step 1: Read first 32 KB to find atom layout
    const scanSize = Math.min(ATOM_SCAN_BYTES, fileSize);
    const headerBuf = Buffer.alloc(scanSize);
    const { bytesRead } = await fd.read(headerBuf, 0, scanSize, 0);
    const header = headerBuf.subarray(0, bytesRead);
    const atoms = scanAtoms(header);

    // Step 2: Look for moov in the scanned atoms
    const moovAtom = atoms.find(a => a.type === 'moov');
    if (moovAtom) {
      const moovEnd = Math.min(moovAtom.offset + moovAtom.size, fileSize);
      const moovSize = moovEnd - moovAtom.offset;
      if (moovSize > MAX_MOOV_SIZE) return null;

      let moovBuf: Buffer;
      if (moovEnd <= bytesRead) {
        moovBuf = header.subarray(moovAtom.offset, moovEnd);
      } else {
        moovBuf = Buffer.alloc(moovSize);
        await fd.read(moovBuf, 0, moovSize, moovAtom.offset);
      }
      return parseMvhdCreationTime(moovBuf);
    }

    // Step 3: moov not in the scanned range — calculate its offset from mdat
    const mdatAtom = atoms.find(a => a.type === 'mdat');
    if (mdatAtom && mdatAtom.size > 0) {
      const moovOffset = mdatAtom.offset + mdatAtom.size;
      if (moovOffset >= fileSize) return null;
      const moovMaxSize = Math.min(MAX_MOOV_SIZE, fileSize - moovOffset);
      const moovBuf = Buffer.alloc(moovMaxSize);
      await fd.read(moovBuf, 0, moovMaxSize, moovOffset);
      if (moovBuf.length >= 8 && moovBuf.toString('ascii', 4, 8) === 'moov') {
        return parseMvhdCreationTime(moovBuf);
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}
