import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extractExifMetadata, inferDateFromFilename } from '../../utils/exif.js';
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
    bodyLimit: MAX_FILE_SIZE * 20 + 1024 * 1024, // allow up to 20 files × 100 MB + 1 MB multipart overhead
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

        // Extract EXIF metadata
        const fileHandle = await fs.open(tempFilePath, 'r');
        const exifBuffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await fileHandle.read(exifBuffer, 0, exifBuffer.length, 0);
        await fileHandle.close();
        const exif = await extractExifMetadata(exifBuffer.subarray(0, bytesRead));

        // Determine capture date: EXIF > filename inference > null
        const capturedAt = exif.capturedAt ?? inferDateFromFilename(filename) ?? undefined;

        // Build S3 key with date path
        const datePath = capturedAt
          ? `${capturedAt.getUTCFullYear()}/${String(capturedAt.getUTCMonth() + 1).padStart(2, '0')}/${String(capturedAt.getUTCDate()).padStart(2, '0')}`
          : 'unknown-date';
        const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const uniquePrefix = digest.slice(0, 8);
        const s3Key = `${datePath}/${uniquePrefix}-${sanitized}`;

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
