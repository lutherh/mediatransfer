import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import exifr from 'exifr';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.3g2']);

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
export async function extractExifMetadata(buffer: Buffer): Promise<ExifMetadata> {
  try {
    const exif = await exifr.parse(buffer, {
      pick: [
        'DateTimeOriginal',
        'CreateDate',
        'DateTimeDigitized',
        'ImageWidth',
        'ImageHeight',
        'ExifImageWidth',
        'ExifImageHeight',
        'Make',
        'Model',
        'GPSLatitude',
        'GPSLongitude',
      ],
      // Enable GPS parsing
      gps: true,
    });

    if (!exif) {
      return {};
    }

    const capturedAt = toDate(exif.DateTimeOriginal ?? exif.CreateDate ?? exif.DateTimeDigitized);
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
