import exifr from 'exifr';

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
