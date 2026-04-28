import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extractExifMetadata, extractVideoCreationDate, inferDateFromFilename } from '../../utils/exif.js';
import { isWrongDate } from '../../utils/date-repair.js';
import { UNDATED_PREFIX, S3TRANSFERS_PREFIX } from '../../utils/storage-paths.js';
import { VIDEO_EXTENSIONS } from '../../utils/media-extensions.js';
import type { UploadService } from '../types.js';
import { apiError } from '../errors.js';

/**
 * Max file size: 500 MB per file.
 * iPhone photos are typically 2-10 MB, videos can be 200+ MB for 4K recordings.
 */
const MAX_FILE_SIZE = 500 * 1024 * 1024;

export async function registerUploadRoutes(
  app: FastifyInstance,
  uploads: UploadService | undefined,
): Promise<void> {
  // Register multipart plugin with file size limit
  await app.register(multipart, {
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 20, // max files per request
    },
  });

  /**
   * POST /uploads
   *
   * Accept one or more files via multipart/form-data.
   * For each file:
   *   1. Buffer the file content
   *   2. Compute SHA-256 hash
   *   3. Check for duplicates
   *   4. Extract EXIF metadata (capture date, dimensions)
   *   5. Upload to Scaleway storage
   *   6. Save MediaItem record
   *
   * Returns an array of upload results.
   */
  app.post('/uploads', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    bodyLimit: MAX_FILE_SIZE * 20 + 1024 * 1024, // allow up to 20 files × 500 MB + 1 MB multipart overhead
  }, async (req, reply) => {
    const uploadService = requireUploads(uploads, reply);
    if (!uploadService) {
      return;
    }
    const parts = req.files();
    const results: UploadResult[] = [];

    for await (const part of parts) {
      let tempFilePath: string | null = null;
      try {
        tempFilePath = path.join(tmpdir(), `mediatransfer-upload-${Date.now()}-${randomUUID()}`);
        const hash = createHash('sha256');
        let size = 0;

        part.file.on('data', (chunk: Buffer) => {
          hash.update(chunk);
          size += chunk.length;
        });
        await pipeline(part.file, createWriteStream(tempFilePath));

        const digest = hash.digest('hex');
        const filename = part.filename;
        const contentType = part.mimetype || 'application/octet-stream';

        // Check for duplicate by hash
        const existing = await uploadService.findByHash(digest);
        if (existing) {
          results.push({
            filename,
            status: 'duplicate',
            mediaItemId: existing.id,
            s3Key: existing.s3Key,
            message: 'File already exists in library',
          });
          continue;
        }

        // Extract EXIF metadata from first 256 KB (matches takeout pipeline)
        const fileHandle = await fs.open(tempFilePath, 'r');
        const exifBuffer = Buffer.allocUnsafe(256 * 1024);
        const { bytesRead } = await fileHandle.read(exifBuffer, 0, exifBuffer.length, 0);
        await fileHandle.close();
        const exif = await extractExifMetadata(exifBuffer.subarray(0, bytesRead));

        // Determine capture date using multi-strategy pipeline
        const capturedAt = await deriveUploadCapturedDate(
          tempFilePath, filename, exif.capturedAt,
        );

        // Build S3 key with date path
        const datePath = capturedAt
          ? `${capturedAt.getUTCFullYear()}/${String(capturedAt.getUTCMonth() + 1).padStart(2, '0')}/${String(capturedAt.getUTCDate()).padStart(2, '0')}`
          : UNDATED_PREFIX;
        const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const uniquePrefix = digest.slice(0, 8);
        const s3Key = `${S3TRANSFERS_PREFIX}/${datePath}/${uniquePrefix}-${sanitized}`;

        // Upload to storage
        const stream = createReadStream(tempFilePath);
        await uploadService.uploadToStorage(s3Key, stream, contentType);

        // Save media item record
        const mediaItem = await uploadService.createMediaItem({
          filename,
          s3Key,
          sha256: digest,
          size,
          contentType,
          width: exif.width,
          height: exif.height,
          capturedAt,
          source: 'upload',
        });

        results.push({
          filename,
          status: 'uploaded',
          mediaItemId: mediaItem.id,
          s3Key: mediaItem.s3Key,
          size,
          capturedAt: capturedAt?.toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          filename: part.filename,
          status: 'error',
          message,
        });
      } finally {
        if (tempFilePath) {
          try {
            await fs.unlink(tempFilePath);
          } catch (err) {
            app.log.debug({ err, tempFilePath }, 'Failed to cleanup upload temp file');
          }
        }
      }
    }

    if (results.length === 0) {
      return reply.code(400).send({
        ...apiError('NO_UPLOAD_FILES', 'No files provided. Send files as multipart/form-data.'),
      });
    }

    const uploaded = results.filter((r) => r.status === 'uploaded').length;
    const duplicates = results.filter((r) => r.status === 'duplicate').length;
    const errors = results.filter((r) => r.status === 'error').length;

    return reply.code(uploaded > 0 || duplicates > 0 ? 200 : 400).send({
      summary: {
        total: results.length,
        uploaded,
        duplicates,
        errors,
      },
      results,
    });
  });

  /**
   * GET /uploads
   *
   * List uploaded media items with pagination.
   */
  app.get('/uploads', async (req, reply) => {
    const uploadService = requireUploads(uploads, reply);
    if (!uploadService) {
      return;
    }

    const query = req.query as {
      limit?: string;
      offset?: string;
      source?: string;
    };

    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const [items, total] = await Promise.all([
      uploadService.listMediaItems({ source: query.source }, limit, offset),
      uploadService.countMediaItems(),
    ]);

    return {
      items,
      total,
      limit,
      offset,
    };
  });

  /**
   * GET /uploads/stats
   *
   * Quick stats about the media library.
   */
  app.get('/uploads/stats', async (_req, reply) => {
    const uploadService = requireUploads(uploads, reply);
    if (!uploadService) {
      return;
    }

    const total = await uploadService.countMediaItems();
    return { totalItems: total };
  });
}

function requireUploads(uploads: UploadService | undefined, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }): UploadService | null {
  if (!uploads) {
    reply.code(503).send({
      ...apiError('UPLOAD_SERVICE_UNAVAILABLE', 'Upload service unavailable. Configure Scaleway storage credentials.'),
    });
    return null;
  }

  return uploads;
}

type UploadResult = {
  filename: string;
  status: 'uploaded' | 'duplicate' | 'error';
  mediaItemId?: string;
  s3Key?: string;
  size?: number;
  capturedAt?: string;
  message?: string;
};

/** Image formats known to embed EXIF / XMP / IPTC metadata. */
const IMAGE_EXTS_WITH_METADATA = new Set([
  '.jpg', '.jpeg', '.heic', '.heif', '.avif', '.png', '.tif', '.tiff', '.webp',
]);

/**
 * Maximum bytes to read for the EXIF fallback pass. 2 MB covers EXIF/XMP
 * in all practical image formats without loading multi-hundred-MB files.
 */
/** @internal Exported for testing. */
export const EXIF_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Multi-strategy date extraction for direct uploads.
 *
 * Priority (mirrors the takeout pipeline in manifest.ts):
 *   1. EXIF from first 256 KB header
 *   2. Filename date inference (e.g. IMG_20231215_143022.jpg)
 *   3. Bounded EXIF re-read for images (first 2 MB, not the entire file)
 *   4. Video container metadata (MP4/MOV moov/mvhd creation_time)
 */
/** @internal Exported for testing. */
export async function deriveUploadCapturedDate(
  filePath: string,
  filename: string,
  exifDate: Date | undefined,
): Promise<Date | undefined> {
  // 1. EXIF from header buffer (already extracted by caller)
  if (exifDate && !isWrongDate(exifDate)) return exifDate;

  // 2. Filename date inference
  const fromFilename = inferDateFromFilename(filename);
  if (fromFilename && !isWrongDate(fromFilename)) return fromFilename;

  const ext = path.extname(filename).toLowerCase();

  // 3. Bounded EXIF re-read for image types when header parse didn't find a date.
  //    Read at most 2 MB instead of the entire file to avoid huge memory spikes.
  if (IMAGE_EXTS_WITH_METADATA.has(ext)) {
    try {
      const fh = await fs.open(filePath, 'r');
      try {
        const stat = await fh.stat();
        const readBytes = Math.min(stat.size, EXIF_FALLBACK_MAX_BYTES);
        const buffer = Buffer.alloc(readBytes);
        await fh.read(buffer, 0, readBytes, 0);
        const exif = await extractExifMetadata(buffer);
        if (exif.capturedAt && !isWrongDate(exif.capturedAt)) return exif.capturedAt;
      } finally {
        await fh.close();
      }
    } catch {
      // Bounded metadata extraction failed — continue to next strategy
    }
  }

  // 4. Video container metadata (MP4/MOV/M4V/3GP moov/mvhd creation_time)
  if (VIDEO_EXTENSIONS.has(ext)) {
    try {
      const fromVideo = await extractVideoCreationDate(filePath);
      if (fromVideo && !isWrongDate(fromVideo)) return fromVideo;
    } catch {
      // Video metadata extraction failed — give up
    }
  }

  return undefined;
}
