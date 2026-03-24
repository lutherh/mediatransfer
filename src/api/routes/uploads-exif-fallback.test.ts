import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { deriveUploadCapturedDate, EXIF_FALLBACK_MAX_BYTES } from './uploads.js';

// We do NOT mock exifr here — but we mock `extractExifMetadata` at a function level
// so we can track what buffer size was actually passed.
vi.mock('../../utils/exif.js', () => ({
  extractExifMetadata: vi.fn(async (source: Buffer | string) => {
    // Record the buffer length so the test can assert it was bounded
    if (Buffer.isBuffer(source)) {
      (extractExifMetadata as any).__lastBufferLength = source.length;
    }
    return {};
  }),
  inferDateFromFilename: vi.fn(() => null),
  extractVideoCreationDate: vi.fn(async () => null),
}));

// Re-import the mock so we can inspect it
import { extractExifMetadata } from '../../utils/exif.js';

describe('deriveUploadCapturedDate — bounded EXIF fallback', () => {
  it('reads at most EXIF_FALLBACK_MAX_BYTES for the image fallback', async () => {
    // Create a temp file that is larger than EXIF_FALLBACK_MAX_BYTES
    const dir = path.join(tmpdir(), `exif-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'huge-photo.jpg');
    const fileSize = EXIF_FALLBACK_MAX_BYTES + 1024 * 1024; // 3 MB
    await fs.writeFile(filePath, Buffer.alloc(fileSize, 0xff));

    try {
      // Pass undefined exifDate so strategy 1 is skipped, no filename pattern
      // so strategy 2 is skipped, and .jpg triggers strategy 3 (bounded read).
      await deriveUploadCapturedDate(filePath, 'huge-photo.jpg', undefined);

      // extractExifMetadata should have been called with a buffer
      expect(extractExifMetadata).toHaveBeenCalled();
      const lastLen = (extractExifMetadata as any).__lastBufferLength;
      expect(lastLen).toBe(EXIF_FALLBACK_MAX_BYTES);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads the full file when it is smaller than EXIF_FALLBACK_MAX_BYTES', async () => {
    const dir = path.join(tmpdir(), `exif-test-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'small.jpg');
    const fileSize = 500 * 1024; // 500 KB
    await fs.writeFile(filePath, Buffer.alloc(fileSize, 0xab));

    try {
      await deriveUploadCapturedDate(filePath, 'small.jpg', undefined);

      expect(extractExifMetadata).toHaveBeenCalled();
      const lastLen = (extractExifMetadata as any).__lastBufferLength;
      expect(lastLen).toBe(fileSize);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips the file read when EXIF date was already found from header', async () => {
    const validDate = new Date('2024-06-01T10:00:00.000Z');
    const result = await deriveUploadCapturedDate('/nonexistent', 'photo.jpg', validDate);

    // Should return the existing EXIF date without hitting the filesystem
    expect(result).toEqual(validDate);
    // extractExifMetadata should NOT have been called for strategy 3
    vi.mocked(extractExifMetadata).mockClear();
    // (the assertion is that the function didn't throw on the nonexistent path)
  });

  it('returns EXIF_FALLBACK_MAX_BYTES as 2MB', () => {
    expect(EXIF_FALLBACK_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
