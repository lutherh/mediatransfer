import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from '../../catalog/scaleway-catalog.js';
import { extractExifMetadata } from '../../utils/exif.js';
import { apiError } from '../errors.js';
import { buildCatalogHtml } from './catalog-html.js';

const listQuerySchema = z.object({
  max: z.coerce.number().int().min(1).max(200).optional(),
  token: z.string().min(1).optional(),
  prefix: z.string().optional(),
});

const mediaParamsSchema = z.object({
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

    const query = listQuerySchema.parse(req.query);
    const page = await catalogService.listPage({
      max: query.max,
      token: query.token,
      prefix: query.prefix,
    });
    return page;
  });

  app.get('/catalog/api/stats', async (_req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const stats = await catalogService.getStats();
    return stats;
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
    for (const move of moves) {
      try {
        const result = await catalogService.moveObject(move.encodedKey, move.newDatePrefix);
        results.moved.push(result);
      } catch (err) {
        results.failed.push({ key: move.encodedKey, error: String(err) });
      }
    }
    return results;
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

  app.get('/catalog/media/:encodedKey', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const { encodedKey } = mediaParamsSchema.parse(req.params);

    let media;
    try {
      media = await catalogService.getObject(encodedKey);
    } catch (error) {
      if (isCatalogObjectNotFound(error)) {
        return reply.status(404).send({
          ...apiError('CATALOG_MEDIA_NOT_FOUND', 'Catalog media not found'),
          requestId: req.id,
        });
      }
      throw error;
    }

    const normalizedEtag = normalizeEtag(media.etag);
    const ifNoneMatch = req.headers['if-none-match'];
    if (normalizedEtag && ifNoneMatch && normalizeEtag(ifNoneMatch) === normalizedEtag) {
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

    if (media.contentType) {
      reply.type(media.contentType);
    }
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

function normalizeEtag(value: string | undefined): string | undefined {
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
