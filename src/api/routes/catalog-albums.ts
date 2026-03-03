import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from '../../catalog/scaleway-catalog.js';
import { apiError } from '../errors.js';

const albumCreateSchema = z.object({
  name: z.string().min(1).max(200).trim(),
});

const albumUpdateSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  addKeys: z.array(z.string()).optional(),
  removeKeys: z.array(z.string()).optional(),
  coverKey: z.string().optional(),
});

const albumIdSchema = z.object({
  albumId: z.string().min(1).max(100),
});

export async function registerCatalogAlbumRoutes(
  app: FastifyInstance,
  catalog: CatalogService | undefined,
): Promise<void> {
  app.get('/catalog/api/albums', async (_req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const manifest = await catalogService.getAlbums();
    return manifest;
  });

  app.post('/catalog/api/albums', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const { name } = albumCreateSchema.parse(req.body);
    const manifest = await catalogService.getAlbums();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    manifest.albums.push({ id, name, keys: [], createdAt: now, updatedAt: now });
    await catalogService.saveAlbums(manifest);
    return { id, name };
  });

  app.patch('/catalog/api/albums/:albumId', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const { albumId } = albumIdSchema.parse(req.params);
    const updates = albumUpdateSchema.parse(req.body);
    const manifest = await catalogService.getAlbums();
    const album = manifest.albums.find((a) => a.id === albumId);
    if (!album) {
      return reply.status(404).send(apiError('ALBUM_NOT_FOUND', 'Album not found'));
    }

    if (updates.name) album.name = updates.name;
    if (updates.coverKey !== undefined) album.coverKey = updates.coverKey;
    if (updates.addKeys) {
      const existing = new Set(album.keys);
      for (const key of updates.addKeys) existing.add(key);
      album.keys = [...existing];
    }
    if (updates.removeKeys) {
      const toRemove = new Set(updates.removeKeys);
      album.keys = album.keys.filter((key) => !toRemove.has(key));
    }

    album.updatedAt = new Date().toISOString();
    await catalogService.saveAlbums(manifest);
    return album;
  });

  app.delete('/catalog/api/albums/:albumId', async (req, reply) => {
    const catalogService = requireCatalog(catalog, reply);
    if (!catalogService) {
      return;
    }

    const { albumId } = albumIdSchema.parse(req.params);
    const manifest = await catalogService.getAlbums();
    const idx = manifest.albums.findIndex((a) => a.id === albumId);
    if (idx === -1) {
      return reply.status(404).send(apiError('ALBUM_NOT_FOUND', 'Album not found'));
    }

    manifest.albums.splice(idx, 1);
    await catalogService.saveAlbums(manifest);
    return { deleted: albumId };
  });
}

function requireCatalog(catalog: CatalogService | undefined, reply: { status: (code: number) => { send: (payload: unknown) => unknown } }): CatalogService | null {
  if (!catalog) {
    reply.status(503).send(apiError('CATALOG_UNAVAILABLE', 'Scaleway catalog is not configured'));
    return null;
  }

  return catalog;
}
