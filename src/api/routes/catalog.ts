import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService, DuplicateGroup, ThumbnailSize } from '../../catalog/scaleway-catalog.js';
import { decodeKey } from '../../catalog/scaleway-catalog.js';
import { extractExifMetadata } from '../../utils/exif.js';
import { apiError } from '../errors.js';
import { buildCatalogHtml } from './catalog-html.js';

// ── Server-side dedup scan state cache ─────────────────────────────────────
// Keeps the latest scan result in memory so (a) we never run two scans at once,
// (b) a dropped SSE connection can poll for the result, and (c) page navigation
// doesn't lose the data.

type DedupScanState =
  | { status: 'idle' }
  | { status: 'scanning'; listed: number; totalFiles: number | null; startedAt: number }
  | {
      status: 'done';
      groups: DuplicateGroup[];
      totalDuplicates: number;
      bytesFreed: number;
      completedAt: number;
    }
  | { status: 'error'; message: string; completedAt: number };

let dedupScanState: DedupScanState = { status: 'idle' };

/** TTL for cached results — after this the frontend should re-scan. */
const SCAN_RESULT_TTL_MS = 30 * 60_000; // 30 minutes

const listQuerySchema = z.object({
  max: z.coerce.number().int().min(1).max(200).optional(),
  token: z.string().min(1).optional(),
  prefix: z.string().optional(),
  sort: z.enum(['asc', 'desc']).optional(),
});

const mediaParamsSchema = z.object({
  encodedKey: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/, 'encodedKey must be base64url-safe'),
});

const thumbnailParamsSchema = z.object({
  size: z.enum(['small', 'large']),
  encodedKey: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/, 'encodedKey must be base64url-safe'),
});

const deleteBodySchema = z.object({
  encodedKeys: z.array(z.string().min(1).max(1024)).min(1).max(1000),
});

const moveBodySchema = z.object({
  encodedKey: z.string().min(1).max(1024),
  newDatePrefix: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/, 'Must be YYYY/MM/DD'),
});

const bulkMoveBodySchema = z.object({
  moves: z.array(z.object({
    encodedKey: z.string().min(1).max(1024),
    newDatePrefix: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/, 'Must be YYYY/MM/DD'),
  })).min(1).max(100),
});

export async function registerCatalogRoutes(
  app: FastifyInstance,
  catalog: CatalogService | undefined,
  corsAllowedOrigins?: string[],
): Promise<void> {
  app.get('/catalog', async (_req, reply) => {
    if (!catalog) {
      return reply.status(503).type('text/html').send(`<!doctype html>
<html><body style="font-family:system-ui;padding:24px">
<h2>Catalog unavailable</h2>
<p>Scaleway catalog browser is not configured. Set SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_REGION and SCW_BUCKET.</p>
</body></html>`);
    }

    return reply.type('text/html').send(buildCatalogHtml());
  });

  app.get('/catalog/api/items', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    try {
      const query = listQuerySchema.parse(req.query);
      const page = await catalogService.listPage({
        max: query.max,
        token: query.token,
        prefix: query.prefix,
        sort: query.sort,
      });
      return page;
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      const status = isTimeout ? 503 : 500;
      const message = isTimeout ? 'S3 request timed out – please retry' : 'Failed to list catalog items';
      console.error('[catalog] /catalog/api/items error:', err);
      return reply.status(status).send({ error: message });
    }
  });

  app.get('/catalog/api/stats', async (_req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    try {
      const stats = await catalogService.getStats();
      return stats;
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      const status = isTimeout ? 503 : 500;
      const message = isTimeout ? 'S3 request timed out – please retry' : 'Failed to fetch catalog stats';
      console.error('[catalog] /catalog/api/stats error:', err);
      return reply.status(status).send({ error: message });
    }
  });

  app.get('/catalog/api/items/all', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const query = z.object({ prefix: z.string().optional() }).parse(req.query);
    const items = await catalogService.listAll(query.prefix);
    return { items };
  });

  app.get('/catalog/api/undated', async (_req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    try {
      const items = await catalogService.listUndated();
      return { items };
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      const status = isTimeout ? 503 : 500;
      const message = isTimeout ? 'S3 request timed out – please retry' : 'Failed to list undated items';
      console.error('[catalog] /catalog/api/undated error:', err);
      return reply.status(status).send({ error: message });
    }
  });

  app.delete('/catalog/api/items', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const { encodedKeys } = deleteBodySchema.parse(req.body);
    const result = await catalogService.deleteObjects(encodedKeys);
    return result;
  });

  app.patch('/catalog/api/items/move', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const { encodedKey, newDatePrefix } = moveBodySchema.parse(req.body);
    const result = await catalogService.moveObject(encodedKey, newDatePrefix);
    return result;
  });

  app.patch('/catalog/api/items/bulk-move', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const { moves } = bulkMoveBodySchema.parse(req.body);
    const results = { moved: [] as { from: string; to: string }[], failed: [] as { key: string; error: string }[] };

    // Process moves with limited concurrency (5 at a time) instead of serially
    const CONCURRENCY = 5;
    for (let i = 0; i < moves.length; i += CONCURRENCY) {
      const batch = moves.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (move) => {
          const result = await catalogService.moveObject(move.encodedKey, move.newDatePrefix);
          return result;
        }),
      );
      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j]!;
        if (outcome.status === 'fulfilled') {
          results.moved.push(outcome.value);
        } else {
          results.failed.push({ key: batch[j]!.encodedKey, error: String(outcome.reason) });
        }
      }
    }
    return results;
  });

  // ── Polling endpoint — get scan status / cached results ────────────────
  app.get('/catalog/api/duplicates/scan/status', async (_req, reply) => {
    requireCatalog(catalog, reply);
    // Expire stale results
    if (
      (dedupScanState.status === 'done' || dedupScanState.status === 'error') &&
      Date.now() - dedupScanState.completedAt > SCAN_RESULT_TTL_MS
    ) {
      dedupScanState = { status: 'idle' };
    }
    return dedupScanState;
  });

  // ── SSE endpoint for duplicate scanning with progress ─────────────────
  app.get('/catalog/api/duplicates/scan', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    // If a scan is already running, reject to prevent double-scanning.
    if (dedupScanState.status === 'scanning') {
      return reply.code(409).send(
        apiError('SCAN_ALREADY_RUNNING', 'A duplicate scan is already in progress'),
      );
    }

    // Get total count from stats for progress percentage
    let totalFiles: number | undefined;
    try {
      const stats = await catalogService.getStats();
      totalFiles = stats.totalFiles;
    } catch {
      // Stats failed; progress will show count only (no percentage)
    }

    dedupScanState = { status: 'scanning', listed: 0, totalFiles: totalFiles ?? null, startedAt: Date.now() };

    // SSE uses reply.raw directly, so we must set CORS headers manually.
    // Validate the origin against the configured allowlist (same as @fastify/cors).
    const reqOrigin = req.headers.origin;
    const allowedSet = new Set((corsAllowedOrigins ?? []).map(o => o.trim()).filter(Boolean));
    const origin = reqOrigin && allowedSet.has(reqOrigin) ? reqOrigin : undefined;
    const corsHeaders: Record<string, string> = origin
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
      : {};
    void reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    });

    // Track whether the client is still connected
    let clientConnected = true;
    req.raw.on('close', () => { clientConnected = false; });

    const sendEvent = (data: Record<string, unknown>) => {
      if (!clientConnected) return;
      try {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        clientConnected = false;
      }
    };

    // SSE keepalive every 15 s so proxies don't kill the connection
    const keepalive = setInterval(() => {
      if (!clientConnected) { clearInterval(keepalive); return; }
      try { reply.raw.write(': keepalive\n\n'); } catch { clientConnected = false; }
    }, 15_000);

    // Send initial event with total
    sendEvent({ phase: 'started', totalFiles: totalFiles ?? null });

    try {
      const groups = await catalogService.findDuplicates((listed) => {
        if (dedupScanState.status === 'scanning') {
          dedupScanState.listed = listed;
        }
        sendEvent({ phase: 'listing', listed, totalFiles: totalFiles ?? null });
      });

      const totalDuplicates = groups.reduce((sum, g) => sum + g.duplicateKeys.length, 0);
      const bytesFreed = groups.reduce((sum, g) => sum + g.duplicateKeys.length * g.size, 0);

      dedupScanState = { status: 'done', groups, totalDuplicates, bytesFreed, completedAt: Date.now() };

      sendEvent({
        phase: 'done',
        groups,
        totalDuplicates,
        bytesFreed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scan failed';
      dedupScanState = { status: 'error', message, completedAt: Date.now() };
      sendEvent({ phase: 'error', message });
    }

    clearInterval(keepalive);
    reply.raw.end();
  });

  app.get('/catalog/api/duplicates', async (_req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const groups = await catalogService.findDuplicates();
    const totalDuplicates = groups.reduce((sum, group) => sum + group.duplicateKeys.length, 0);
    const bytesFreed = groups.reduce((sum, group) => sum + group.duplicateKeys.length * group.size, 0);
    return { groups, totalDuplicates, bytesFreed };
  });

  app.post('/catalog/api/deduplicate', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const body = z.object({ dryRun: z.boolean().optional() }).parse(req.body);
    const result = await catalogService.deduplicateObjects({ dryRun: body.dryRun });
    return result;
  });

  // ── Thumbnail endpoint ─────────────────────────────────────────────────
  // Serves on-demand resized JPEG thumbnails for grid tiles (small=256px)
  // and lightbox preview (large=1920px). Cached in-memory + aggressive
  // browser caching (7 days) to minimize S3 GETs on scroll.
  app.get('/catalog/thumb/:size/:encodedKey', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    let params: { size: ThumbnailSize; encodedKey: string };
    try {
      params = thumbnailParamsSchema.parse(req.params);
    } catch {
      return reply.status(400).send(apiError('INVALID_PARAMS', 'size must be "small" or "large", encodedKey must be base64url'));
    }

    try {
      const { buffer, contentType } = await catalogService.getThumbnail(params.encodedKey, params.size);
      reply.type(contentType);
      reply.header('Cache-Control', 'private, max-age=604800, stale-while-revalidate=2592000'); // 7d + 30d stale
      reply.header('Content-Length', String(buffer.length));
      return reply.send(buffer);
    } catch (error) {
      if (isCatalogObjectNotFound(error)) {
        return reply.status(404).send({
          ...apiError('CATALOG_MEDIA_NOT_FOUND', 'Catalog media not found'),
          requestId: req.id,
        });
      }
      // Detect sharp image processing failures (unsupported format, corrupt data, etc.)
      if (isImageProcessingError(error)) {
        return reply.status(415).send(apiError('UNSUPPORTED_FORMAT', 'Cannot generate thumbnail for this format'));
      }
      throw error;
    }
  });

  app.get('/catalog/media/:encodedKey', { config: { rateLimit: { max: 2000, timeWindow: '1 minute' } } }, async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const { encodedKey } = mediaParamsSchema.parse(req.params);
    const rangeHeader = req.headers['range'];

    let media;
    try {
      media = await catalogService.getObject(encodedKey, rangeHeader);
    } catch (error) {
      if (isCatalogObjectNotFound(error)) {
        return reply.status(404).send({
          ...apiError('CATALOG_MEDIA_NOT_FOUND', 'Catalog media not found'),
          requestId: req.id,
        });
      }
      throw error;
    }

    const normalizedEtag = formatEtagHeader(media.etag);

    // Only honour conditional-request shortcuts for full (non-range) requests
    if (!rangeHeader) {
      const ifNoneMatch = req.headers['if-none-match'];
      if (normalizedEtag && ifNoneMatch && formatEtagHeader(ifNoneMatch) === normalizedEtag) {
        reply.header('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
        reply.header('ETag', normalizedEtag);
        return reply.code(304).send();
      }

      const ifModifiedSinceHeader = req.headers['if-modified-since'];
      if (ifModifiedSinceHeader && media.lastModified) {
        const modifiedAt = Date.parse(media.lastModified);
        const requestedAt = Date.parse(ifModifiedSinceHeader);
        if (!Number.isNaN(modifiedAt) && !Number.isNaN(requestedAt) && modifiedAt <= requestedAt) {
          reply.header('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
          if (normalizedEtag) {
            reply.header('ETag', normalizedEtag);
          }
          reply.header('Last-Modified', new Date(modifiedAt).toUTCString());
          return reply.code(304).send();
        }
      }
    }

    if (media.contentType) {
      reply.type(media.contentType);
    }
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
    if (normalizedEtag) {
      reply.header('ETag', normalizedEtag);
    }
    if (media.lastModified) {
      const lastModified = Date.parse(media.lastModified);
      if (!Number.isNaN(lastModified)) {
        reply.header('Last-Modified', new Date(lastModified).toUTCString());
      }
    }
    if (typeof media.contentLength === 'number' && Number.isFinite(media.contentLength) && media.contentLength >= 0) {
      reply.header('Content-Length', String(media.contentLength));
    }
    // Suggest a filename for download — extract from the decoded S3 key
    const decodedKey = decodeKey(encodedKey);
    const filename = decodedKey.split('/').pop() ?? decodedKey;
    reply.header('Content-Disposition', `inline; filename="${filename.replace(/"/g, '_')}"`);

    if (rangeHeader && media.contentRange) {
      reply.header('Content-Range', media.contentRange);
      return reply.code(206).send(media.stream);
    }

    return reply.send(media.stream);
  });

  app.get('/catalog/api/exif/:encodedKey', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const { encodedKey } = mediaParamsSchema.parse(req.params);

    try {
      const { buffer, contentType, contentLength } = await catalogService.getObjectBuffer(encodedKey, 65536);
      const exif = await extractExifMetadata(buffer);

      let rawExif: Record<string, unknown> | undefined;
      try {
        const exifr = await import('exifr');
        const raw = await exifr.default.parse(buffer, { translateValues: true, mergeOutput: true });
        if (raw && typeof raw === 'object') {
          rawExif = {};
          for (const [key, value] of Object.entries(raw)) {
            if (value instanceof Uint8Array || Buffer.isBuffer(value)) continue;
            rawExif[key] = value instanceof Date ? value.toISOString() : value;
          }
        }
      } catch (err) {
        app.log.debug({ err, encodedKey }, 'Raw EXIF extraction unavailable');
      }

      return {
        capturedAt: exif.capturedAt?.toISOString() ?? null,
        width: exif.width ?? null,
        height: exif.height ?? null,
        make: exif.make ?? null,
        model: exif.model ?? null,
        latitude: exif.latitude ?? null,
        longitude: exif.longitude ?? null,
        contentType: contentType ?? null,
        fileSize: contentLength ?? null,
        raw: rawExif ?? null,
      };
    } catch (error) {
      if (error instanceof Error && (error.name === 'NoSuchKey' || (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)) {
        return reply.status(404).send(apiError('CATALOG_MEDIA_NOT_FOUND', 'Catalog media not found'));
      }
      throw error;
    }
  });
}

function requireCatalog(catalog: CatalogService | undefined, reply: { status: (code: number) => { send: (payload: unknown) => unknown } }): CatalogService | null {
  if (!catalog) {
    reply.status(503).send(apiError('CATALOG_UNAVAILABLE', 'Scaleway catalog is not configured'));
    return null;
  }

  return catalog;
}

/** Format an ETag value as a properly quoted HTTP header value. */
function formatEtagHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.startsWith('"') ? trimmed : `"${trimmed}"`;
}

function isCatalogObjectNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const maybeMetadata = error as Error & { $metadata?: { httpStatusCode?: number } };
  return error.name === 'NoSuchKey' || maybeMetadata.$metadata?.httpStatusCode === 404;
}

/** Detect sharp / libvips image processing errors (corrupt data, unsupported format, etc.). */
const IMAGE_PROCESSING_ERROR_PATTERNS = [
  'Input buffer',        // "Input buffer contains unsupported image format"
  'Input file',          // "Input file is missing"
  'unsupported image',   // "unsupported image format"
  'Corrupt JPEG',        // "VipsJpeg: Corrupt JPEG data"
  'Vips',                // General libvips error prefix
  'heif:',               // HEIF decoding errors
  'Invalid SOS',         // Corrupt JPEG marker
  'not supported',       // "Video thumbnails not supported"
];

function isImageProcessingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return IMAGE_PROCESSING_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}
