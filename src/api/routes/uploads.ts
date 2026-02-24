import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import { sha256Buffer } from '../../utils/hash.js';
import { extractExifMetadata, inferDateFromFilename } from '../../utils/exif.js';
import type { UploadService } from '../types.js';

/**
 * Max file size: 100 MB per file.
 * iPhone photos are typically 2-10 MB, videos up to ~100 MB.
 */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

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
  app.post('/uploads', async (req, reply) => {
    if (!uploads) {
      return reply.code(503).send({
        error: 'Upload service unavailable. Configure Scaleway storage credentials.',
      });
    }
    const parts = req.files();
    const results: UploadResult[] = [];

    for await (const part of parts) {
      try {
        // Buffer the entire file for hashing + EXIF extraction
        const buffer = await part.toBuffer();
        const hash = sha256Buffer(buffer);
        const filename = part.filename;
        const contentType = part.mimetype || 'application/octet-stream';
        const size = buffer.length;

        // Check for duplicate by hash
        const existing = await uploads.findByHash(hash);
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
        const exif = await extractExifMetadata(buffer);

        // Determine capture date: EXIF > filename inference > null
        const capturedAt = exif.capturedAt ?? inferDateFromFilename(filename) ?? undefined;

        // Build S3 key with date path
        const datePath = capturedAt
          ? `${capturedAt.getUTCFullYear()}/${String(capturedAt.getUTCMonth() + 1).padStart(2, '0')}/${String(capturedAt.getUTCDate()).padStart(2, '0')}`
          : 'unknown-date';
        const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const uniquePrefix = hash.slice(0, 8);
        const s3Key = `${datePath}/${uniquePrefix}-${sanitized}`;

        // Upload to storage
        const stream = Readable.from(buffer);
        await uploads.uploadToStorage(s3Key, stream, contentType);

        // Save media item record
        const mediaItem = await uploads.createMediaItem({
          filename,
          s3Key,
          sha256: hash,
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
      }
    }

    if (results.length === 0) {
      return reply.code(400).send({
        error: 'No files provided. Send files as multipart/form-data.',
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
    if (!uploads) {
      return reply.code(503).send({
        error: 'Upload service unavailable. Configure Scaleway storage credentials.',
      });
    }

    const query = req.query as {
      limit?: string;
      offset?: string;
      source?: string;
    };

    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const [items, total] = await Promise.all([
      uploads.listMediaItems({ source: query.source }, limit, offset),
      uploads.countMediaItems(),
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
    if (!uploads) {
      return reply.code(503).send({
        error: 'Upload service unavailable. Configure Scaleway storage credentials.',
      });
    }

    const total = await uploads.countMediaItems();
    return { totalItems: total };
  });
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
