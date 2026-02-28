import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from '../../catalog/scaleway-catalog.js';

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

export async function registerCatalogRoutes(
  app: FastifyInstance,
  catalog: CatalogService | undefined,
): Promise<void> {
  app.get('/catalog', async (req, reply) => {
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
    if (!catalog) {
      return reply.status(503).send({
        error: 'CATALOG_UNAVAILABLE',
        message: 'Scaleway catalog is not configured',
      });
    }

    const query = listQuerySchema.parse(req.query);
    const page = await catalog.listPage({
      max: query.max,
      token: query.token,
      prefix: query.prefix,
    });
    return page;
  });

  app.get('/catalog/api/stats', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({
        error: 'CATALOG_UNAVAILABLE',
        message: 'Scaleway catalog is not configured',
      });
    }

    const stats = await catalog.getStats();
    return stats;
  });

  // ── List all items (for full catalog operations) ──
  app.get('/catalog/api/items/all', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({ error: 'CATALOG_UNAVAILABLE', message: 'Scaleway catalog is not configured' });
    }
    const query = z.object({ prefix: z.string().optional() }).parse(req.query);
    const items = await catalog.listAll(query.prefix);
    return { items };
  });

  // ── Delete items ──
  app.delete('/catalog/api/items', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({ error: 'CATALOG_UNAVAILABLE', message: 'Scaleway catalog is not configured' });
    }
    const { encodedKeys } = deleteBodySchema.parse(req.body);
    const result = await catalog.deleteObjects(encodedKeys);
    return result;
  });

  // ── Move single item (date repair) ──
  app.patch('/catalog/api/items/move', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({ error: 'CATALOG_UNAVAILABLE', message: 'Scaleway catalog is not configured' });
    }
    const { encodedKey, newDatePrefix } = moveBodySchema.parse(req.body);
    const result = await catalog.moveObject(encodedKey, newDatePrefix);
    return result;
  });

  // ── Bulk move items (date repair) ──
  app.patch('/catalog/api/items/bulk-move', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({ error: 'CATALOG_UNAVAILABLE', message: 'Scaleway catalog is not configured' });
    }
    const { moves } = bulkMoveBodySchema.parse(req.body);
    const results = { moved: [] as { from: string; to: string }[], failed: [] as { key: string; error: string }[] };
    for (const m of moves) {
      try {
        const r = await catalog.moveObject(m.encodedKey, m.newDatePrefix);
        results.moved.push(r);
      } catch (err) {
        results.failed.push({ key: m.encodedKey, error: String(err) });
      }
    }
    return results;
  });

  // ── Albums CRUD ──
  app.get('/catalog/api/albums', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({ error: 'CATALOG_UNAVAILABLE', message: 'Scaleway catalog is not configured' });
    }
    const manifest = await catalog.getAlbums();
    return manifest;
  });

  app.post('/catalog/api/albums', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({ error: 'CATALOG_UNAVAILABLE', message: 'Scaleway catalog is not configured' });
    }
    const { name } = albumCreateSchema.parse(req.body);
    const manifest = await catalog.getAlbums();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    manifest.albums.push({ id, name, keys: [], createdAt: now, updatedAt: now });
    await catalog.saveAlbums(manifest);
    return { id, name };
  });

  app.patch('/catalog/api/albums/:albumId', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({ error: 'CATALOG_UNAVAILABLE', message: 'Scaleway catalog is not configured' });
    }
    const { albumId } = albumIdSchema.parse(req.params);
    const updates = albumUpdateSchema.parse(req.body);
    const manifest = await catalog.getAlbums();
    const album = manifest.albums.find((a) => a.id === albumId);
    if (!album) {
      return reply.status(404).send({ error: 'ALBUM_NOT_FOUND', message: 'Album not found' });
    }
    if (updates.name) album.name = updates.name;
    if (updates.coverKey !== undefined) album.coverKey = updates.coverKey;
    if (updates.addKeys) {
      const existing = new Set(album.keys);
      for (const k of updates.addKeys) existing.add(k);
      album.keys = [...existing];
    }
    if (updates.removeKeys) {
      const toRemove = new Set(updates.removeKeys);
      album.keys = album.keys.filter((k) => !toRemove.has(k));
    }
    album.updatedAt = new Date().toISOString();
    await catalog.saveAlbums(manifest);
    return album;
  });

  app.delete('/catalog/api/albums/:albumId', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({ error: 'CATALOG_UNAVAILABLE', message: 'Scaleway catalog is not configured' });
    }
    const { albumId } = albumIdSchema.parse(req.params);
    const manifest = await catalog.getAlbums();
    const idx = manifest.albums.findIndex((a) => a.id === albumId);
    if (idx === -1) {
      return reply.status(404).send({ error: 'ALBUM_NOT_FOUND', message: 'Album not found' });
    }
    manifest.albums.splice(idx, 1);
    await catalog.saveAlbums(manifest);
    return { deleted: albumId };
  });

  app.get('/catalog/media/:encodedKey', async (req, reply) => {
    if (!catalog) {
      return reply.status(503).send({
        error: 'CATALOG_UNAVAILABLE',
        message: 'Scaleway catalog is not configured',
      });
    }

    const { encodedKey } = mediaParamsSchema.parse(req.params);

    let media;
    try {
      media = await catalog.getObject(encodedKey);
    } catch (error) {
      if (isCatalogObjectNotFound(error)) {
        return reply.status(404).send({
          error: {
            code: 'CATALOG_MEDIA_NOT_FOUND',
            message: 'Catalog media not found',
          },
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

function buildCatalogHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Scaleway Catalog Browser</title>
  <script>document.documentElement.dataset.theme=localStorage.getItem('catalogTheme')||'dark'</script>
  <style>
    :root { color-scheme: dark; --bg: #0f1115; --surface: #141923; --surface2: #1a2030; --border: #252b39; --text: #e8ecf3; --text-dim: #9aa6bf; --accent: #4d8bff; --accent-light: #6ba0ff; --danger: #ff4d6a; --danger-dim: #3d1520; --warning: #ffb84d; --warning-dim: #3d2e15; --success: #4dff88; --check-bg: #4d8bff; --select-ring: #4d8bff55; --tile-radius: 8px; }
    [data-theme="light"] { color-scheme: light; --bg: #ffffff; --surface: #f8f9fa; --surface2: #f1f3f4; --border: #dadce0; --text: #202124; --text-dim: #5f6368; --accent: #1a73e8; --accent-light: #4285f4; --danger: #d93025; --danger-dim: #fce8e6; --warning: #f9ab00; --warning-dim: #fef7e0; --success: #1e8e3e; --check-bg: #1a73e8; --select-ring: #1a73e855; --tile-radius: 8px; }
    #themeToggle .theme-moon { display:none; }
    [data-theme="light"] #themeToggle .theme-sun { display:none; }
    [data-theme="light"] #themeToggle .theme-moon { display:block; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: 'Google Sans', Inter, system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--text); }

    /* ── Top bar ── */
    .topbar { position:sticky; top:0; z-index:50; display:flex; gap:10px; align-items:center; padding:8px 16px; background:var(--surface); border-bottom:1px solid var(--border); min-height:56px; }
    .topbar .spacer { flex:1; }
    .search-container { flex:1; max-width:720px; position:relative; display:flex; align-items:center; }
    .search-container input { width:100%; height:40px; padding:0 40px; border:none; border-radius:9999px; background:var(--surface2); color:var(--text); font-size:14px; outline:none; transition:background .15s, box-shadow .15s; font-family:inherit; }
    .search-container input:focus { background:var(--bg); box-shadow:0 0 0 2px var(--accent); }
    .search-container input::placeholder { color:var(--text-dim); }
    .search-icon { position:absolute; left:12px; width:20px; height:20px; color:var(--text-dim); pointer-events:none; fill:currentColor; }
    .search-clear { position:absolute; right:8px; width:28px; height:28px; border:none; background:none; color:var(--text-dim); cursor:pointer; border-radius:50%; display:flex; align-items:center; justify-content:center; padding:0; transition:background .15s; }
    .search-clear:hover { background:var(--surface2); color:var(--text); }
    .search-clear svg { width:18px; height:18px; fill:currentColor; }
    .settings-menu { position:fixed; top:56px; right:16px; width:220px; background:var(--surface); border:1px solid var(--border); border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,.3); z-index:70; padding:8px 0; display:none; }
    .settings-menu.visible { display:block; }
    .settings-group { padding:8px 16px; }
    .settings-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text-dim); padding-bottom:6px; }
    .settings-option { display:block; width:100%; padding:6px 12px; border:none; background:none; color:var(--text-dim); font-size:13px; cursor:pointer; text-align:left; border-radius:6px; font-family:inherit; transition:background .15s; }
    .settings-option:hover { background:var(--surface2); color:var(--text); }
    .settings-option.active { color:var(--accent); font-weight:500; }
    .settings-divider { height:1px; background:var(--border); margin:4px 0; }
    .settings-action { display:flex; align-items:center; gap:8px; width:calc(100% - 16px); padding:8px 12px; margin:0 8px; border:none; background:none; color:var(--text-dim); font-size:13px; cursor:pointer; font-family:inherit; border-radius:6px; transition:background .15s; }
    .settings-action:hover { background:var(--surface2); color:var(--text); }
    .settings-action svg { width:18px; height:18px; fill:currentColor; }
    .icon-btn { width:40px; height:40px; border-radius:50%; border:none; background:transparent; color:var(--text-dim); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:background .15s; position:relative; overflow:hidden; }
    .icon-btn:hover { background:var(--surface2); color:var(--text); }
    .icon-btn::after { content:''; position:absolute; inset:0; background:radial-gradient(circle, var(--text) 10%, transparent 10.01%) no-repeat 50%; transform:scale(10); opacity:0; transition:transform .5s, opacity 1s; }
    .icon-btn:active::after { transform:scale(0); opacity:.12; transition:0s; }
    .icon-btn svg { width:24px; height:24px; fill:currentColor; }

    /* ── Selection toolbar ── */
    .sel-toolbar { position:fixed; top:0; left:0; right:0; z-index:60; display:flex; align-items:center; gap:8px; padding:8px 16px; background:var(--surface); border-bottom:2px solid var(--accent); transform:translateY(-100%); transition:transform .2s ease; }
    .sel-toolbar.visible { transform:translateY(0); }
    .sel-toolbar .sel-count { font-size:16px; font-weight:600; margin-left:8px; }
    .sel-toolbar .spacer { flex:1; }
    .sel-toolbar .icon-btn { color:var(--text); }
    .sel-toolbar .icon-btn:hover { background:var(--surface2); }
    .sel-toolbar .icon-btn.danger:hover { background:var(--danger-dim); color:var(--danger); }

    /* ── Sidebar ── */
    .sidebar { position:fixed; left:0; top:0; bottom:0; width:256px; z-index:40; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow-y:auto; overflow-x:hidden; transition:transform .2s ease; }
    .sidebar-brand { display:flex; align-items:center; gap:10px; padding:16px 20px; font-size:18px; font-weight:600; border-bottom:1px solid var(--border); white-space:nowrap; }
    .sidebar-brand svg { width:28px; height:28px; flex-shrink:0; color:var(--accent); }
    .sidebar-nav { flex:1; padding:8px 0; }
    .sidebar-section { padding:16px 20px 4px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text-dim); }
    .sidebar-item { display:flex; align-items:center; gap:12px; padding:0 16px; margin:2px 8px; height:44px; border-radius:9999px; cursor:pointer; font-size:14px; color:var(--text-dim); transition:all .15s; border:none; background:none; width:calc(100% - 16px); text-align:left; font-family:inherit; }
    .sidebar-item:hover { background:var(--surface2); color:var(--text); }
    .sidebar-item.active { background:color-mix(in srgb, var(--accent) 12%, transparent); color:var(--accent); font-weight:500; }
    .sidebar-item svg { width:22px; height:22px; flex-shrink:0; fill:currentColor; }
    .sidebar-item .item-label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sidebar-item .item-badge { font-size:11px; background:var(--surface2); color:var(--text-dim); padding:2px 8px; border-radius:99px; min-width:18px; text-align:center; }
    .sidebar-item .item-chevron { width:18px; height:18px; flex-shrink:0; transition:transform .2s; }
    .sidebar-item.expanded .item-chevron { transform:rotate(90deg); }
    .album-sublist { display:none; padding:0 0 4px 0; }
    .album-sublist.open { display:block; }
    .album-subitem { display:flex; align-items:center; gap:8px; padding:0 16px 0 50px; height:36px; cursor:pointer; font-size:13px; color:var(--text-dim); border-radius:9999px; margin:1px 8px; transition:all .15s; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .album-subitem:hover { background:var(--surface2); color:var(--text); }
    .album-subitem.create-link { color:var(--accent); font-weight:500; }
    .album-subitem .subitem-count { font-size:11px; color:var(--text-dim); margin-left:auto; }
    .sidebar-bottom { padding:12px 20px; border-top:1px solid var(--border); font-size:12px; color:var(--text-dim); display:flex; flex-direction:column; gap:4px; }
    .sidebar-bottom .stat-line { display:flex; align-items:center; gap:6px; }
    .sidebar-bottom .stat-value { color:var(--text); font-weight:600; }
    .sidebar-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:39; display:none; }
    .sidebar-overlay.visible { display:block; }
    .main-area { margin-left:256px; min-height:100vh; }
    .hamburger { display:none !important; }
    @media (max-width:768px) {
      .sidebar { transform:translateX(-100%); z-index:100; box-shadow:none; }
      .sidebar.open { transform:translateX(0); box-shadow:0 25px 50px -12px rgba(0,0,0,.25); }
      .main-area { margin-left:0; }
      .hamburger { display:inline-flex !important; }
    }
    @media (min-width:769px) {
      .sel-toolbar { left:256px; }
    }

    /* ── Content ── */
    .content { padding:4px 8px 80px; }
    .section { margin-bottom:4px; }
    .section-header { position:sticky; top:56px; z-index:5; display:flex; align-items:center; gap:12px; padding:20px 8px 8px; background:var(--bg); min-height:48px; }
    .section-header .section-check { width:24px; height:24px; border-radius:50%; border:2px solid var(--text-dim); background:transparent; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all .15s; opacity:0; }
    .section:hover .section-check, .section-header .section-check.some-selected { opacity:1; }
    .section-header .section-check.all-selected { background:var(--check-bg); border-color:var(--check-bg); opacity:1; }
    .section-header .section-check svg { width:14px; height:14px; fill:#fff; display:none; }
    .section-header .section-check.all-selected svg, .section-header .section-check.some-selected svg { display:block; }
    .section-header .section-date { font-size:16px; font-weight:600; color:var(--text); letter-spacing:0.01em; }
    .section-header .section-count { font-size:12px; color:var(--text-dim); }
    .section-header .section-warn { display:inline-flex; align-items:center; gap:4px; font-size:11px; color:var(--warning); background:var(--warning-dim); padding:2px 8px; border-radius:10px; }
    @media (max-width:768px) { .section-header { min-height:32px; padding:12px 8px 4px; } .section-header .section-date { font-size:14px; } }

    /* ── Grid ── */
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(var(--grid-min,180px),1fr)); gap:4px; user-select:none; }
    @media (min-width:900px) { .grid { grid-template-columns:repeat(auto-fill,minmax(var(--grid-min-md,210px),1fr)); } }
    @media (min-width:1400px) { .grid { grid-template-columns:repeat(auto-fill,minmax(var(--grid-min-lg,240px),1fr)); } }

    /* ── Tile ── */
    .tile { position:relative; aspect-ratio:1; border-radius:var(--tile-radius); overflow:hidden; background:var(--surface2); cursor:pointer; content-visibility:auto; contain-intrinsic-size:200px; animation:skeleton-pulse 1.5s ease-in-out infinite; }
    .tile.loaded { animation:none; }
    .tile img, .tile video { width:100%; height:100%; object-fit:cover; display:block; transition:transform .2s, opacity .3s ease; opacity:0; }
    .tile img.loaded, .tile video.loaded { opacity:1; }
    .tile:hover img.loaded, .tile:hover video.loaded { transform:scale(1.03); }
    @keyframes skeleton-pulse { 0%,100% { opacity:.6; } 50% { opacity:1; } }
    .tile .check-circle { position:absolute; top:6px; left:6px; width:24px; height:24px; border-radius:50%; border:2px solid rgba(255,255,255,.7); background:rgba(0,0,0,.25); display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity .15s; cursor:pointer; z-index:2; }
    .tile:hover .check-circle, .tile.selected .check-circle { opacity:1; }
    .tile.selected .check-circle { background:var(--check-bg); border-color:var(--check-bg); }
    .tile .check-circle svg { width:14px; height:14px; fill:#fff; display:none; }
    .tile.selected .check-circle svg { display:block; }
    .tile.selected { box-shadow:0 0 0 3px var(--select-ring); border-radius:var(--tile-radius); }
    .tile .badge { position:absolute; bottom:6px; right:6px; font-size:11px; font-weight:600; padding:2px 6px; border-radius:4px; background:rgba(0,0,0,.7); color:#fff; z-index:2; }
    .tile .badge-warn { position:absolute; top:6px; right:6px; width:20px; height:20px; border-radius:50%; background:var(--warning); display:flex; align-items:center; justify-content:center; z-index:2; }
    .tile .badge-warn svg { width:12px; height:12px; fill:#000; }

    /* ── Status ── */
    .status { text-align:center; color:var(--text-dim); font-size:13px; padding:16px; }
    #sentinel { height:1px; }
    #toTop { position:fixed; right:16px; bottom:16px; width:44px; height:44px; border-radius:50%; border:none; background:var(--accent); color:#fff; cursor:pointer; display:none; z-index:30; box-shadow:0 2px 8px rgba(0,0,0,.4); font-size:18px; }
    .empty-state { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:80px 20px; color:var(--text-dim); text-align:center; }
    .empty-state h3 { margin:0 0 8px; font-size:18px; font-weight:500; color:var(--text); }
    .empty-state p { margin:0; font-size:14px; }

    /* ── Viewer ── */
    .modal { position:fixed; inset:0; display:none; z-index:70; background:#000; }
    .modal.open { display:flex; flex-direction:column; }
    .viewer-toolbar { position:absolute; top:0; left:0; right:0; z-index:2; display:flex; align-items:center; gap:8px; padding:8px 16px; background:linear-gradient(to bottom, rgba(0,0,0,.6), transparent); transition:opacity .3s; }
    .viewer-toolbar.hidden { opacity:0; pointer-events:none; }
    .viewer-toolbar .title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#fff; font-size:14px; margin:0 8px; }
    .viewer-toolbar .icon-btn { color:rgba(255,255,255,.8); }
    .viewer-toolbar .icon-btn:hover { color:#fff; background:rgba(255,255,255,.15); }
    .viewer-body { flex:1; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; cursor:default; }
    .viewer-body img, .viewer-body video { max-width:100%; max-height:100%; object-fit:contain; transition:transform .2s; }
    .viewer-nav { position:absolute; top:50%; transform:translateY(-50%); z-index:2; width:48px; height:80px; border:none; background:rgba(0,0,0,.4); color:#fff; cursor:pointer; border-radius:8px; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity .2s; }
    .viewer-nav:hover { opacity:1 !important; background:rgba(0,0,0,.6); }
    .modal:hover .viewer-nav { opacity:.6; }
    .viewer-nav:disabled { display:none; }
    .viewer-nav.prev { left:12px; }
    .viewer-nav.next { right:12px; }
    .viewer-nav svg { width:32px; height:32px; fill:currentColor; }
    .viewer-pos { position:absolute; bottom:16px; left:50%; transform:translateX(-50%); font-size:13px; color:rgba(255,255,255,.6); z-index:2; }
    .detail-panel { position:absolute; top:0; right:0; bottom:0; width:360px; background:var(--surface); border-left:1px solid var(--border); z-index:3; transform:translateX(100%); transition:transform .3s ease; overflow-y:auto; display:flex; flex-direction:column; }
    .detail-panel.open { transform:translateX(0); }
    .detail-panel-head { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--border); }
    .detail-panel-head h3 { margin:0; font-size:16px; font-weight:500; color:var(--text); }
    .detail-section { padding:16px 20px; border-bottom:1px solid var(--border); }
    .detail-section-title { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:var(--text-dim); margin-bottom:8px; }
    .detail-row { font-size:13px; color:var(--text); line-height:1.6; word-break:break-all; }
    .detail-row .label { color:var(--text-dim); }
    .detail-chips { display:flex; flex-wrap:wrap; gap:6px; }
    .detail-chip { padding:4px 12px; border-radius:9999px; background:var(--surface2); color:var(--text); font-size:12px; cursor:pointer; border:1px solid var(--border); }
    .detail-chip:hover { background:var(--accent); color:#fff; border-color:var(--accent); }
    @media (max-width:768px) { .detail-panel { width:100%; } }

    /* ── Dialog / overlay ── */
    .dialog-overlay { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:80; display:none; place-items:center; }
    .dialog-overlay.open { display:grid; }
    .dialog { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:24px; min-width:320px; max-width:460px; }
    .dialog h3 { margin:0 0 12px; font-size:18px; }
    .dialog p { margin:0 0 16px; font-size:14px; color:var(--text-dim); }
    .dialog input { width:100%; height:38px; border-radius:8px; border:1px solid var(--border); padding:0 12px; background:var(--bg); color:var(--text); font-size:14px; margin-bottom:12px; }
    .dialog .actions { display:flex; gap:8px; justify-content:flex-end; }
    .dialog .btn { padding:8px 20px; border-radius:8px; border:none; cursor:pointer; font-size:14px; font-weight:500; }
    .dialog .btn-cancel { background:var(--surface2); color:var(--text); }
    .dialog .btn-danger { background:var(--danger); color:#fff; }
    .dialog .btn-primary { background:var(--accent); color:#fff; }

    /* ── Toast ── */
    .toast-container { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:90; display:flex; flex-direction:column; gap:8px; align-items:center; }
    .toast { padding:10px 20px; border-radius:10px; font-size:13px; background:var(--surface2); border:1px solid var(--border); color:var(--text); animation:toastIn .3s ease; box-shadow:0 4px 16px rgba(0,0,0,.4); }
    .toast.error { border-color:var(--danger); }
    .toast.success { border-color:var(--success); }
    @keyframes toastIn { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }

    /* ── Albums sidebar ── */
    .albums-panel { display:none; padding:16px; max-width:800px; margin:0 auto; }
    .albums-panel.visible { display:block; }
    .album-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px; margin-top:12px; }
    .album-card { background:var(--surface2); border:1px solid var(--border); border-radius:12px; overflow:hidden; cursor:pointer; transition:border-color .15s; }
    .album-card:hover { border-color:var(--accent); }
    .album-card .album-cover { width:100%; aspect-ratio:16/10; background:var(--surface); display:flex; align-items:center; justify-content:center; overflow:hidden; }
    .album-card .album-cover img { width:100%; height:100%; object-fit:cover; }
    .album-card .album-cover .no-cover { font-size:32px; color:var(--text-dim); }
    .album-card .album-info { padding:10px 12px; }
    .album-card .album-name { font-size:14px; font-weight:600; }
    .album-card .album-count { font-size:12px; color:var(--text-dim); }

    /* ── Date repair panel ── */
    .repair-panel { display:none; padding:16px; max-width:1000px; margin:0 auto; }
    .repair-panel.visible { display:block; }
    .repair-panel h3 { margin:0 0 8px; }
    .repair-panel p { color:var(--text-dim); font-size:13px; margin:0 0 16px; }
    .repair-list { display:flex; flex-direction:column; gap:4px; max-height:600px; overflow-y:auto; }
    .repair-row { display:flex; align-items:center; gap:10px; padding:8px 12px; background:var(--surface2); border-radius:8px; font-size:13px; }
    .repair-row .repair-thumb { width:48px; height:48px; border-radius:4px; object-fit:cover; background:var(--surface); }
    .repair-row .repair-key { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .repair-row input[type="date"] { height:30px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text); padding:0 8px; }
  </style>
</head>
<body>

  <!-- ═══ Sidebar ═══ -->
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-brand">
      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
      MediaTransfer
    </div>
    <nav class="sidebar-nav">
      <button class="sidebar-item active" data-nav="photos">
        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
        <span class="item-label">Photos</span>
      </button>
      <div class="sidebar-section">Library</div>
      <button class="sidebar-item" data-nav="albums" id="albumsNavBtn">
        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M22 16V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2zm-11-4l2.03 2.71L16 11l4 5H8l3-4zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6H2z"/></svg>
        <span class="item-label">Albums</span>
        <span class="item-badge" id="albumBadge">0</span>
        <svg class="item-chevron" viewBox="0 0 24 24"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
      </button>
      <div class="album-sublist" id="albumSublist"></div>
      <div class="sidebar-section">Tools</div>
      <button class="sidebar-item" data-nav="repair">
        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>
        <span class="item-label">Date Repair</span>
      </button>
    </nav>
    <div class="sidebar-bottom" id="sidebarStats">
      <div class="stat-line">Loading stats…</div>
    </div>
  </aside>
  <div class="sidebar-overlay" id="sidebarOverlay"></div>

  <div class="main-area">

  <!-- ═══ Top bar ═══ -->
  <div class="topbar" id="topbar">
    <button class="icon-btn hamburger" id="hamburgerBtn" title="Menu"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg></button>
    <div class="search-container">
      <svg class="search-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <input id="searchInput" type="text" placeholder="Search your photos…" autocomplete="off" />
      <button class="search-clear" id="searchClear" style="display:none"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </div>
    <span id="stats" style="font-size:12px;color:var(--text-dim)"></span>
    <button class="icon-btn" id="themeToggle" title="Toggle theme"><svg class="theme-sun" viewBox="0 0 24 24"><path fill="currentColor" d="M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm0-10c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z"/></svg><svg class="theme-moon" viewBox="0 0 24 24"><path fill="currentColor" d="M9.5 2c-1.82 0-3.53.5-5 1.35 2.99 1.73 5 4.95 5 8.65s-2.01 6.92-5 8.65c1.47.85 3.18 1.35 5 1.35 5.52 0 10-4.48 10-10S15.02 2 9.5 2z"/></svg></button>
    <button class="icon-btn" id="settingsBtn" title="Settings"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></button>
    <select id="mediaType" style="display:none" title="Filter by media type">
      <option value="all">All media</option>
      <option value="image">Photos</option>
      <option value="video">Videos</option>
    </select>
    <select id="sortOrder" style="display:none" title="Arrange order">
      <option value="date-desc">Newest first</option>
      <option value="date-asc">Oldest first</option>
      <option value="key-asc">Name A→Z</option>
      <option value="key-desc">Name Z→A</option>
      <option value="size-desc">Largest first</option>
      <option value="size-asc">Smallest first</option>
    </select>
  </div>
  <div class="settings-menu" id="settingsMenu">
    <div class="settings-group">
      <div class="settings-label">Sort by</div>
      <button class="settings-option active" data-sort="date-desc">Newest first</button>
      <button class="settings-option" data-sort="date-asc">Oldest first</button>
      <button class="settings-option" data-sort="key-asc">Name A→Z</button>
      <button class="settings-option" data-sort="key-desc">Name Z→A</button>
      <button class="settings-option" data-sort="size-desc">Largest first</button>
      <button class="settings-option" data-sort="size-asc">Smallest first</button>
    </div>
    <div class="settings-group">
      <div class="settings-label">Media type</div>
      <button class="settings-option active" data-media="all">All media</button>
      <button class="settings-option" data-media="image">Photos only</button>
      <button class="settings-option" data-media="video">Videos only</button>
    </div>
    <div class="settings-group">
      <div class="settings-label">Grid size</div>
      <button class="settings-option" data-grid="small">Small</button>
      <button class="settings-option active" data-grid="medium">Medium</button>
      <button class="settings-option" data-grid="large">Large</button>
    </div>
    <div class="settings-divider"></div>
    <button class="settings-action" id="settingsReload"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>Reload</button>
  </div>

  <!-- ═══ Selection toolbar ═══ -->
  <div class="sel-toolbar" id="selToolbar">
    <button class="icon-btn" id="selClose" title="Cancel selection"><svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    <span class="sel-count" id="selCount">0</span>
    <div class="spacer"></div>
    <button class="icon-btn" id="selAddAlbum" title="Add to album"><svg viewBox="0 0 24 24"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-4v4h-2v-4H9V9h4V5h2v4h4v2z"/></svg></button>
    <button class="icon-btn" id="selRepairDate" title="Repair date"><svg viewBox="0 0 24 24"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-2 .9-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/></svg></button>
    <button class="icon-btn" id="selDownload" title="Download"><svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
    <button class="icon-btn danger" id="selDelete" title="Delete"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
  </div>

  <!-- ═══ Photos tab ═══ -->
  <div class="content" id="content"></div>
  <div class="status" id="status">Loading…</div>
  <div id="sentinel"></div>

  <!-- ═══ Albums tab ═══ -->
  <div class="albums-panel" id="albumsPanel">
    <div style="display:flex; align-items:center; justify-content:space-between;">
      <h3>Albums</h3>
      <button class="btn btn-primary" id="createAlbumBtn" style="padding:8px 16px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;">+ New Album</button>
    </div>
    <div class="album-grid" id="albumGrid"></div>
  </div>

  <!-- ═══ Date repair tab ═══ -->
  <div class="repair-panel" id="repairPanel">
    <h3>Date Repair</h3>
    <p>Items below have problematic date paths (e.g. future dates like 2026). Select items and assign a correct date to move them.</p>
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;">
      <button class="btn btn-primary" id="repairScan" style="padding:6px 14px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;">Scan for problematic items</button>
      <span id="repairStatus" style="font-size:13px;color:var(--text-dim)"></span>
    </div>
    <div class="repair-list" id="repairList"></div>
    <div style="margin-top:12px;display:none;" id="repairActions">
      <label style="font-size:13px;color:var(--text-dim);margin-right:8px;">Move selected to date:</label>
      <input type="date" id="repairDate" style="height:32px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:0 8px;" />
      <button class="btn btn-primary" id="repairApply" style="padding:6px 14px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;margin-left:8px;">Apply</button>
    </div>
  </div>

  <button id="toTop" title="Back to top">↑</button>

  <!-- ═══ Viewer ═══ -->
  <div class="modal" id="modal">
    <div class="viewer-toolbar" id="viewerToolbar">
      <button class="icon-btn" id="closeModal" title="Back (Esc)"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button>
      <span class="title" id="modalTitle">Preview</span>
      <button class="icon-btn" id="modalInfo" title="Info (I)"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg></button>
      <button class="icon-btn" id="modalDownload" title="Download (D)"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
      <button class="icon-btn danger" id="modalDelete" title="Delete"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
    </div>
    <div class="viewer-body" id="modalBody"></div>
    <button class="viewer-nav prev" id="modalPrev"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button>
    <button class="viewer-nav next" id="modalNext"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></button>
    <span class="viewer-pos" id="modalPos"></span>
    <div class="detail-panel" id="detailPanel">
      <div class="detail-panel-head">
        <h3>Details</h3>
        <button class="icon-btn" id="closeDetail" title="Close"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
      </div>
      <div id="detailContent"></div>
    </div>
  </div>

  <!-- ═══ Dialogs ═══ -->
  <div class="dialog-overlay" id="deleteDialog">
    <div class="dialog">
      <h3>Delete items?</h3>
      <p id="deleteMsg">This will permanently delete 0 items from Scaleway storage. This cannot be undone.</p>
      <div class="actions">
        <button class="btn btn-cancel" id="deleteCancelBtn">Cancel</button>
        <button class="btn btn-danger" id="deleteConfirmBtn">Delete</button>
      </div>
    </div>
  </div>

  <div class="dialog-overlay" id="albumDialog">
    <div class="dialog">
      <h3 id="albumDialogTitle">Create Album</h3>
      <input id="albumNameInput" placeholder="Album name" />
      <div class="actions">
        <button class="btn btn-cancel" id="albumCancelBtn">Cancel</button>
        <button class="btn btn-primary" id="albumSaveBtn">Create</button>
      </div>
    </div>
  </div>

  <div class="dialog-overlay" id="addToAlbumDialog">
    <div class="dialog">
      <h3>Add to Album</h3>
      <div id="albumPickList" style="max-height:300px;overflow-y:auto;margin-bottom:12px;"></div>
      <div class="actions">
        <button class="btn btn-cancel" id="addAlbumCancelBtn">Cancel</button>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  </div><!-- /main-area -->

  <script>
    /* ═══════════════════════════════════════════════════════════
       STATE
       ═══════════════════════════════════════════════════════════ */
    const $ = (id) => document.getElementById(id);
    const query = new URLSearchParams(location.search);
    const apiToken = query.get('apiToken') || '';

    let nextToken = null, loading = false, hasMore = true, loaded = 0;
    let allItems = [], renderVersion = 0, prefetchingAll = false, renderQueued = false, lastVisibleCount = 0;
    const PREFETCH_MAX_ITEMS = 5000, PREFETCH_MAX_PAGES = 40;
    const sections = new Map();
    const selected = new Set(); // encodedKeys

    /* Lazy-load observer: sets src on media only when tile enters viewport */
    let lazyObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const media = entry.target.querySelector('[data-src]');
        if (media) {
          media.src = media.dataset.src;
          delete media.dataset.src;
          if (media.tagName === 'VIDEO') media.preload = 'metadata';
        }
        lazyObserver.unobserve(entry.target);
      }
    }, { rootMargin: '400px 0px' }); // 400px ahead
    let currentTab = 'photos';
    let albums = [];
    let albumKeyIndex = new Map(); // key → Set<albumName> for O(1) search
    let modalIndex = -1;
    let flatVisible = [];

    const PROBLEMATIC_PREFIXES = ['2025/', '2026/', '2027/', '2028/', '2029/', '2030/'];

    function isProblematic(key) {
      return PROBLEMATIC_PREFIXES.some(p => key.startsWith(p));
    }

    /* ═══════════════════════════════════════════════════════════
       API HELPERS
       ═══════════════════════════════════════════════════════════ */
    function apiHeaders() {
      const h = { 'Content-Type': 'application/json' };
      if (apiToken) h['x-api-key'] = apiToken;
      return h;
    }

    function mediaUrl(encodedKey) {
      const url = new URL('/catalog/media/' + encodedKey, location.origin);
      if (apiToken) url.searchParams.set('apiToken', apiToken);
      return url.toString();
    }

    /* ═══════════════════════════════════════════════════════════
       TOAST
       ═══════════════════════════════════════════════════════════ */
    function toast(msg, type = 'info') {
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = msg;
      $('toastContainer').appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
    }

    /* ═══════════════════════════════════════════════════════════
       SIDEBAR NAVIGATION
       ═══════════════════════════════════════════════════════════ */
    function navigateTo(section) {
      document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
      const navBtn = document.querySelector('.sidebar-item[data-nav="' + section + '"]');
      if (navBtn) navBtn.classList.add('active');
      currentTab = section;
      $('content').style.display = section === 'photos' ? '' : 'none';
      $('status').style.display = section === 'photos' ? '' : 'none';
      $('sentinel').style.display = section === 'photos' ? '' : 'none';
      $('albumsPanel').classList.toggle('visible', section === 'albums');
      $('repairPanel').classList.toggle('visible', section === 'repair');
      if (section === 'albums') loadAlbums();
      closeSidebar();
    }

    function toggleSidebar() {
      $('sidebar').classList.toggle('open');
      $('sidebarOverlay').classList.toggle('visible');
    }

    function closeSidebar() {
      $('sidebar').classList.remove('open');
      $('sidebarOverlay').classList.remove('visible');
    }

    // Chevron click: expand/collapse album sublist without navigation
    document.querySelectorAll('.sidebar-item .item-chevron').forEach(chevron => {
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = chevron.closest('.sidebar-item');
        btn.classList.toggle('expanded');
        $('albumSublist').classList.toggle('open');
        if ($('albumSublist').classList.contains('open') && albums.length === 0) {
          loadAlbums();
        }
      });
    });

    document.querySelectorAll('.sidebar-item').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.nav === 'albums') {
          // Navigate to albums panel AND expand sublist
          if (!btn.classList.contains('expanded')) {
            btn.classList.add('expanded');
            $('albumSublist').classList.add('open');
          }
          navigateTo('albums');
          return;
        }
        navigateTo(btn.dataset.nav);
      });
    });

    $('hamburgerBtn').addEventListener('click', toggleSidebar);
    $('sidebarOverlay').addEventListener('click', closeSidebar);

    /* ═══════════════════════════════════════════════════════════
       SELECTION
       ═══════════════════════════════════════════════════════════ */
    let lastSelectedIdx = -1;

    function updateSelectionToolbar() {
      const bar = $('selToolbar');
      bar.classList.toggle('visible', selected.size > 0);
      $('selCount').textContent = selected.size + ' selected';
    }

    function shiftSelectRange(fromIdx, toIdx) {
      const start = Math.min(fromIdx, toIdx);
      const end = Math.max(fromIdx, toIdx);
      for (let i = start; i <= end; i++) {
        const item = flatVisible[i];
        if (item && !selected.has(item.encodedKey)) {
          selected.add(item.encodedKey);
        }
      }
      document.querySelectorAll('.tile').forEach(tile => {
        tile.classList.toggle('selected', selected.has(tile.dataset.ek));
      });
      updateSelectionToolbar();
      updateSectionChecks();
    }

    function toggleSelect(encodedKey, el) {
      if (selected.has(encodedKey)) {
        selected.delete(encodedKey);
        el?.classList.remove('selected');
      } else {
        selected.add(encodedKey);
        el?.classList.add('selected');
      }
      updateSelectionToolbar();
      updateSectionChecks();
    }

    function clearSelection() {
      selected.clear();
      lastSelectedIdx = -1;
      document.querySelectorAll('.tile.selected').forEach(t => t.classList.remove('selected'));
      updateSelectionToolbar();
      updateSectionChecks();
    }

    function selectSection(sectionDate) {
      const items = allItems.filter(i => i.sectionDate === sectionDate);
      const allSelected = items.every(i => selected.has(i.encodedKey));
      items.forEach(i => {
        if (allSelected) {
          selected.delete(i.encodedKey);
        } else {
          selected.add(i.encodedKey);
        }
      });
      // Update tile visuals
      document.querySelectorAll('.tile').forEach(tile => {
        const ek = tile.dataset.ek;
        tile.classList.toggle('selected', selected.has(ek));
      });
      updateSelectionToolbar();
      updateSectionChecks();
    }

    function updateSectionChecks() {
      document.querySelectorAll('.section').forEach(sec => {
        const date = sec.dataset.date;
        const items = allItems.filter(i => i.sectionDate === date);
        const count = items.filter(i => selected.has(i.encodedKey)).length;
        const checkBtn = sec.querySelector('.section-check');
        if (!checkBtn) return;
        checkBtn.classList.toggle('all-selected', count === items.length && count > 0);
        checkBtn.classList.toggle('some-selected', count > 0 && count < items.length);
      });
    }

    $('selClose').addEventListener('click', clearSelection);

    /* ═══════════════════════════════════════════════════════════
       DELETE (with undo toast — Immich pattern)
       ═══════════════════════════════════════════════════════════ */
    let pendingDelete = null; // { encodedKeys, removedItems, timeoutId, toastEl }

    function showDeleteDialog(encodedKeys) {
      // Cancel any previous pending delete first
      if (pendingDelete) commitDelete();

      // Immediately remove items from view (optimistic)
      const ekSet = new Set(encodedKeys);
      const removedItems = allItems.filter(i => ekSet.has(i.encodedKey));
      allItems = allItems.filter(i => !ekSet.has(i.encodedKey));
      selected.clear();
      updateSelectionToolbar();
      scheduleRender();

      // Show undo toast
      const el = document.createElement('div');
      el.className = 'toast info';
      el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.gap = '12px';
      el.innerHTML = '<span>' + encodedKeys.length + ' item' + (encodedKeys.length > 1 ? 's' : '') + ' deleted</span>';
      const undoBtn = document.createElement('button');
      undoBtn.textContent = 'Undo';
      undoBtn.style.cssText = 'background:var(--accent);color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px;font-weight:500;';
      undoBtn.addEventListener('click', () => {
        // Restore items
        clearTimeout(pendingDelete.timeoutId);
        allItems = allItems.concat(pendingDelete.removedItems);
        pendingDelete.toastEl.remove();
        pendingDelete = null;
        scheduleRender();
        toast('Delete undone', 'success');
      });
      el.appendChild(undoBtn);
      $('toastContainer').appendChild(el);

      const timeoutId = setTimeout(() => commitDelete(), 5000);
      pendingDelete = { encodedKeys, removedItems, timeoutId, toastEl: el };
    }

    async function commitDelete() {
      if (!pendingDelete) return;
      const { encodedKeys, toastEl } = pendingDelete;
      clearTimeout(pendingDelete.timeoutId);
      toastEl.style.opacity = '0';
      setTimeout(() => toastEl.remove(), 300);
      pendingDelete = null;

      try {
        const res = await fetch('/catalog/api/items', {
          method: 'DELETE',
          headers: apiHeaders(),
          body: JSON.stringify({ encodedKeys }),
        });
        const result = await res.json();
        if (result.deleted?.length) {
          toast(result.deleted.length + ' items permanently deleted', 'success');
          loadStats();
        }
        if (result.failed?.length) {
          toast(result.failed.length + ' items failed to delete', 'error');
          // Reload to restore state
          resetAndReload();
        }
      } catch (err) {
        toast('Delete failed: ' + err.message, 'error');
        resetAndReload();
      }
    }

    $('selDelete').addEventListener('click', () => {
      if (selected.size === 0) return;
      showDeleteDialog([...selected]);
    });

    /* ═══════════════════════════════════════════════════════════
       DOWNLOAD
       ═══════════════════════════════════════════════════════════ */
    $('selDownload').addEventListener('click', () => {
      if (selected.size === 0) return;
      // For single file, direct download. For multiple, download sequentially.
      const keys = [...selected];
      if (keys.length === 1) {
        downloadFile(keys[0]);
      } else {
        toast('Starting download of ' + keys.length + ' files…');
        keys.forEach((ek, i) => {
          setTimeout(() => downloadFile(ek), i * 300);
        });
      }
    });

    function downloadFile(encodedKey) {
      const a = document.createElement('a');
      a.href = mediaUrl(encodedKey);
      a.download = '';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    /* ═══════════════════════════════════════════════════════════
       DATE REPAIR (from selection)
       ═══════════════════════════════════════════════════════════ */
    $('selRepairDate').addEventListener('click', () => {
      if (selected.size === 0) return;
      navigateTo('repair');
      showRepairItems([...selected].map(ek => allItems.find(i => i.encodedKey === ek)).filter(Boolean));
    });

    /* ═══════════════════════════════════════════════════════════
       LOADING ITEMS
       ═══════════════════════════════════════════════════════════ */
    async function loadMore() {
      if (loading || !hasMore) return;
      loading = true;
      $('status').textContent = 'Loading…';

      const params = new URLSearchParams();
      params.set('max', isDateSortSelected() ? '200' : '90');
      if (nextToken) params.set('token', nextToken);
      const prefix = $('searchInput').value.trim();
      if (prefix) params.set('prefix', prefix);
      if (apiToken) params.set('apiToken', apiToken);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const res = await fetch('/catalog/api/items?' + params.toString(), {
          headers: apiToken ? { 'x-api-key': apiToken } : {},
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Request failed: ' + res.status);
        const page = await res.json();
        const newItems = page.items || [];
        allItems.push(...newItems);
        loaded += newItems.length;
        if (!prefetchingAll) scheduleRender();
        updateItemStats();
        nextToken = page.nextToken || null;
        hasMore = Boolean(nextToken);
        if (prefetchingAll && hasMore) {
          $('status').textContent = 'Loading all items for date sorting… (' + loaded + ')';
        } else {
          $('status').textContent = hasMore ? 'Scroll for more' : (allItems.length ? 'All ' + allItems.length + ' items loaded' : 'No items found');
        }
      } catch (err) {
        $('status').textContent = 'Error — click Reload to retry';
        toast('Load error: ' + err.message, 'error');
      } finally {
        clearTimeout(timeout);
        loading = false;
      }
    }

    function isDateSortSelected() {
      return $('sortOrder').value.startsWith('date-');
    }

    async function prefetchAllForDateSort() {
      if (prefetchingAll || !isDateSortSelected() || !hasMore) return;
      prefetchingAll = true;
      try {
        let pages = 0;
        while (hasMore && pages < PREFETCH_MAX_PAGES && allItems.length < PREFETCH_MAX_ITEMS) {
          await loadMore();
          pages++;
          await new Promise(r => setTimeout(r, 0));
        }
      } finally {
        prefetchingAll = false;
        scheduleRender();
        $('status').textContent = hasMore
          ? 'Loaded ' + loaded + ' items. Refine prefix for more.'
          : (allItems.length ? 'All ' + allItems.length + ' items loaded' : 'No items found');
      }
    }

    async function prefetchAllForSearch() {
      if (prefetchingAll || !hasMore) return;
      prefetchingAll = true;
      $('status').textContent = 'Loading all items for search…';
      try {
        let pages = 0;
        while (hasMore && pages < PREFETCH_MAX_PAGES && allItems.length < PREFETCH_MAX_ITEMS) {
          await loadMore();
          pages++;
          await new Promise(r => setTimeout(r, 0));
        }
      } finally {
        prefetchingAll = false;
        scheduleRender();
      }
    }

    function updateItemStats() {
      $('stats').textContent = lastVisibleCount + ' shown / ' + loaded + ' loaded';
    }

    /* ═══════════════════════════════════════════════════════════
       SORTING / FILTERING
       ═══════════════════════════════════════════════════════════ */
    const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];

    function matchesSearchQuery(item, query) {
      if (!query) return true;
      // Match filename/key
      if (item.key && item.key.toLowerCase().includes(query)) return true;
      // Match section date string
      if (item.sectionDate && item.sectionDate.toLowerCase().includes(query)) return true;
      // Match captured date
      if (item.capturedAt && item.capturedAt.toLowerCase().includes(query)) return true;
      // Match date by month name or year
      const dateStr = item.capturedAt || item.lastModified || item.sectionDate;
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d)) {
          if (String(d.getFullYear()).includes(query)) return true;
          const mn = MONTH_NAMES[d.getMonth()];
          if (mn && (mn.includes(query) || mn.slice(0,3).includes(query))) return true;
        }
      }
      // Match album name — O(1) via albumKeyIndex
      const itemAlbumNames = albumKeyIndex.get(item.key);
      if (itemAlbumNames) {
        for (const name of itemAlbumNames) {
          if (name.includes(query)) return true;
        }
      }
      return false;
    }

    function getVisibleItems() {
      const type = $('mediaType').value;
      const query = ($('searchInput') ? $('searchInput').value : '').trim().toLowerCase();
      return allItems.filter(i => {
        if (type !== 'all' && i.mediaType !== type) return false;
        return matchesSearchQuery(i, query);
      });
    }

    function parseDateValue(item) {
      if (item.capturedAt) { const v = Date.parse(item.capturedAt); if (!isNaN(v)) return v; }
      if (item.lastModified) { const v = Date.parse(item.lastModified); if (!isNaN(v)) return v; }
      if (item.sectionDate) { const v = Date.parse(item.sectionDate); if (!isNaN(v)) return v; }
      return 0;
    }

    function compareItems(a, b) {
      const order = $('sortOrder').value;
      if (order === 'date-asc') return parseDateValue(a) - parseDateValue(b);
      if (order === 'date-desc') return parseDateValue(b) - parseDateValue(a);
      if (order === 'key-asc') return (a.key || '').localeCompare(b.key || '');
      if (order === 'key-desc') return (b.key || '').localeCompare(a.key || '');
      if (order === 'size-asc') return (a.size || 0) - (b.size || 0);
      if (order === 'size-desc') return (b.size || 0) - (a.size || 0);
      return 0;
    }

    /* ═══════════════════════════════════════════════════════════
       RENDERING
       ═══════════════════════════════════════════════════════════ */
    function formatDate(dateStr) {
      const d = new Date(dateStr);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const diffDays = Math.round((today - target) / 86400000);
      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
      const opts = { day: 'numeric', month: 'short' };
      if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
      return d.toLocaleDateString(undefined, opts);
    }

    function renderAllItems() {
      renderQueued = false;
      sections.clear();
      // Disconnect old observer and create fresh one
      lazyObserver.disconnect();
      lazyObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const media = entry.target.querySelector('[data-src]');
          if (media) {
            media.src = media.dataset.src;
            delete media.dataset.src;
            if (media.tagName === 'VIDEO') media.preload = 'metadata';
          }
          lazyObserver.unobserve(entry.target);
        }
      }, { rootMargin: '400px 0px' });
      $('content').innerHTML = '';
      const items = getVisibleItems().slice().sort(compareItems);
      flatVisible = items;
      lastVisibleCount = items.length;
      buildProblematicIndex(items);

      // Empty state
      const existingEmpty = $('content').querySelector('.empty-state');
      if (existingEmpty) existingEmpty.remove();
      if (items.length === 0 && !hasMore) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<svg viewBox="0 0 24 24" style="width:64px;height:64px;fill:var(--text-dim);margin-bottom:16px"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg><h3>No photos found</h3><p>Try a different search or filter</p>';
        $('content').appendChild(empty);
      }

      const version = ++renderVersion;
      let idx = 0;
      const BATCH = 200;

      function chunk() {
        if (version !== renderVersion) return;
        const end = Math.min(idx + BATCH, items.length);
        for (; idx < end; idx++) renderItem(items[idx], idx);
        if (idx < items.length) {
          requestAnimationFrame(chunk);
        } else {
          // All batches done — update section counts accurately
          updateAllSectionCounts();
        }
      }
      requestAnimationFrame(chunk);
    }

    function scheduleRender() {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => { renderAllItems(); updateItemStats(); });
    }

    function updateAllSectionCounts() {
      sections.forEach((grid, dateStr) => {
        const sec = grid.closest('section');
        if (!sec) return;
        const countLabel = sec.querySelector('.section-count');
        if (countLabel) countLabel.textContent = grid.children.length + ' items';
      });
    }

    // Pre-computed problematic counts per section date (rebuilt before each render)
    let problematicBySection = new Map();

    function buildProblematicIndex(items) {
      problematicBySection = new Map();
      for (const item of items) {
        if (isProblematic(item.key)) {
          const d = item.sectionDate || 'Unknown date';
          problematicBySection.set(d, (problematicBySection.get(d) || 0) + 1);
        }
      }
    }

    function getSection(dateStr) {
      let grid = sections.get(dateStr);
      if (grid) return grid;

      const sec = document.createElement('section');
      sec.className = 'section';
      sec.dataset.date = dateStr;

      const header = document.createElement('div');
      header.className = 'section-header';

      const checkBtn = document.createElement('button');
      checkBtn.className = 'section-check';
      checkBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
      checkBtn.addEventListener('click', (e) => { e.stopPropagation(); selectSection(dateStr); });

      const dateLabel = document.createElement('span');
      dateLabel.className = 'section-date';
      dateLabel.textContent = formatDate(dateStr);

      const countLabel = document.createElement('span');
      countLabel.className = 'section-count';

      header.appendChild(checkBtn);
      header.appendChild(dateLabel);
      header.appendChild(countLabel);

      // Use pre-computed problematic count (O(1) lookup)
      const problemCount = problematicBySection.get(dateStr) || 0;
      if (problemCount > 0) {
        const warn = document.createElement('span');
        warn.className = 'section-warn';
        warn.innerHTML = '⚠ ' + problemCount + ' wrong date';
        header.appendChild(warn);
      }

      grid = document.createElement('div');
      grid.className = 'grid';

      sec.appendChild(header);
      sec.appendChild(grid);
      $('content').appendChild(sec);
      sections.set(dateStr, grid);

      return grid;
    }

    function renderItem(item, globalIdx) {
      const grid = getSection(item.sectionDate || 'Unknown date');
      const tile = document.createElement('div');
      tile.className = 'tile' + (selected.has(item.encodedKey) ? ' selected' : '');
      tile.dataset.ek = item.encodedKey;
      tile.dataset.idx = globalIdx;

      const src = mediaUrl(item.encodedKey);

      // Check circle
      const check = document.createElement('div');
      check.className = 'check-circle';
      check.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
      check.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey && lastSelectedIdx >= 0) {
          shiftSelectRange(lastSelectedIdx, globalIdx);
        } else {
          toggleSelect(item.encodedKey, tile);
          lastSelectedIdx = globalIdx;
        }
      });

      // Media element — use data-src; IntersectionObserver sets real src when visible
      const media = document.createElement(item.mediaType === 'video' ? 'video' : 'img');
      media.loading = 'lazy';
      media.decoding = 'async';
      media.dataset.src = src;
      if (item.mediaType === 'video') {
        media.muted = true;
        media.playsInline = true;
        // preload set by observer when tile enters viewport
      }
      media.addEventListener(item.mediaType === 'video' ? 'loadeddata' : 'load', () => {
        media.classList.add('loaded');
        tile.classList.add('loaded');
      });

      tile.appendChild(check);
      tile.appendChild(media);

      // Video duration badge
      if (item.mediaType === 'video') {
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = formatBytes(item.size);
        media.addEventListener('loadedmetadata', () => {
          if (media.duration && isFinite(media.duration)) {
            badge.textContent = formatDuration(media.duration);
          }
        });
        tile.appendChild(badge);
      } else {
        // Size badge for images
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = formatBytes(item.size);
        tile.appendChild(badge);
      }

      // Problematic warning badge
      if (isProblematic(item.key)) {
        const warn = document.createElement('div');
        warn.className = 'badge-warn';
        warn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
        warn.title = 'Problematic date path: ' + item.key.split('/').slice(0, 3).join('/');
        tile.appendChild(warn);
      }

      tile.addEventListener('click', (e) => {
        if (e.shiftKey && lastSelectedIdx >= 0) {
          shiftSelectRange(lastSelectedIdx, globalIdx);
        } else if (selected.size > 0) {
          toggleSelect(item.encodedKey, tile);
          lastSelectedIdx = globalIdx;
        } else {
          openModal(globalIdx);
        }
      });

      grid.appendChild(tile);
      lazyObserver.observe(tile);
    }

    /* ═══════════════════════════════════════════════════════════
       VIEWER
       ═══════════════════════════════════════════════════════════ */
    let viewerTimeout;
    let viewerZoom = 1;

    function openModal(idx) {
      modalIndex = idx;
      viewerZoom = 1;
      renderModal();
      $('modal').classList.add('open');
      showViewerToolbar();
    }

    function closeViewer() {
      $('modal').classList.remove('open');
      $('modalBody').innerHTML = '';
      clearTimeout(viewerTimeout);
    }

    function renderModal() {
      const item = flatVisible[modalIndex];
      if (!item) return;
      $('modalTitle').textContent = item.key;
      $('modalBody').innerHTML = '';
      viewerZoom = 1;
      const src = mediaUrl(item.encodedKey);
      const media = document.createElement(item.mediaType === 'video' ? 'video' : 'img');
      media.src = src;
      if (item.mediaType === 'video') { media.controls = true; media.autoplay = true; }
      $('modalBody').appendChild(media);
      $('modalPos').textContent = (modalIndex + 1) + ' / ' + flatVisible.length;
      $('modalPrev').disabled = modalIndex <= 0;
      $('modalNext').disabled = modalIndex >= flatVisible.length - 1;
      $('modal').dataset.ek = item.encodedKey;
      if (detailOpen) renderDetailPanel();
    }

    function showViewerToolbar() {
      $('viewerToolbar').classList.remove('hidden');
      clearTimeout(viewerTimeout);
      viewerTimeout = setTimeout(() => $('viewerToolbar').classList.add('hidden'), 3000);
    }

    $('modal').addEventListener('mousemove', showViewerToolbar);

    $('modalPrev').addEventListener('click', () => { if (modalIndex > 0) { modalIndex--; renderModal(); } });
    $('modalNext').addEventListener('click', () => { if (modalIndex < flatVisible.length - 1) { modalIndex++; renderModal(); } });

    $('closeModal').addEventListener('click', closeViewer);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal') || e.target === $('modalBody')) closeViewer(); });

    // Zoom support
    $('modalBody').addEventListener('wheel', (e) => {
      e.preventDefault();
      viewerZoom = Math.max(0.5, Math.min(5, viewerZoom + (e.deltaY > 0 ? -0.2 : 0.2)));
      const media = $('modalBody').querySelector('img, video');
      if (media) media.style.transform = 'scale(' + viewerZoom + ')';
    }, { passive: false });
    $('modalBody').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      viewerZoom = viewerZoom > 1 ? 1 : 2;
      const media = $('modalBody').querySelector('img, video');
      if (media) media.style.transform = 'scale(' + viewerZoom + ')';
    });

    // Keyboard nav for viewer
    document.addEventListener('keydown', (e) => {
      if (!$('modal').classList.contains('open')) return;
      if (e.key === 'ArrowLeft') { $('modalPrev').click(); }
      else if (e.key === 'ArrowRight') { $('modalNext').click(); }
      else if (e.key === 'Escape') { closeViewer(); }
      else if (e.key === 'd' || e.key === 'D') { $('modalDownload').click(); }
      else if (e.key === 'i' || e.key === 'I') { $('modalInfo').click(); }
      else if (e.key === 'Delete') { $('modalDelete').click(); }
      else if (e.key === '+' || e.key === '=') { viewerZoom = Math.min(5, viewerZoom + 0.25); const m = $('modalBody').querySelector('img, video'); if (m) m.style.transform = 'scale(' + viewerZoom + ')'; }
      else if (e.key === '-') { viewerZoom = Math.max(0.5, viewerZoom - 0.25); const m = $('modalBody').querySelector('img, video'); if (m) m.style.transform = 'scale(' + viewerZoom + ')'; }
      else if (e.key === '0') { viewerZoom = 1; const m = $('modalBody').querySelector('img, video'); if (m) m.style.transform = 'scale(1)'; }
    });

    $('modalDownload').addEventListener('click', () => {
      const ek = $('modal').dataset.ek;
      if (ek) downloadFile(ek);
    });

    $('modalDelete').addEventListener('click', () => {
      const ek = $('modal').dataset.ek;
      if (ek) {
        closeViewer();
        showDeleteDialog([ek]);
      }
    });

    $('modalInfo').addEventListener('click', () => {
      detailOpen = !detailOpen;
      $('detailPanel').classList.toggle('open', detailOpen);
      if (detailOpen) renderDetailPanel();
    });

    $('closeDetail').addEventListener('click', () => {
      detailOpen = false;
      $('detailPanel').classList.remove('open');
    });

    let detailOpen = false;
    function renderDetailPanel() {
      const item = flatVisible[modalIndex];
      if (!item) return;
      let html = '';
      if (item.capturedAt || item.lastModified) {
        html += '<div class="detail-section"><div class="detail-section-title">📅 Date</div>';
        if (item.capturedAt) html += '<div class="detail-row">' + new Date(item.capturedAt).toLocaleString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' }) + '</div>';
        if (item.lastModified && item.lastModified !== item.capturedAt) html += '<div class="detail-row"><span class="label">Modified: </span>' + new Date(item.lastModified).toLocaleString() + '</div>';
        html += '</div>';
      }
      html += '<div class="detail-section"><div class="detail-section-title">🖼️ File</div>';
      html += '<div class="detail-row" style="font-weight:500">' + (item.key.split('/').pop() || item.key) + '</div>';
      html += '<div class="detail-row"><span class="label">Path: </span>' + item.key + '</div>';
      html += '<div class="detail-row"><span class="label">Size: </span>' + formatBytes(item.size) + '</div>';
      html += '<div class="detail-row"><span class="label">Type: </span>' + (item.contentType || item.mediaType) + '</div>';
      html += '</div>';
      const itemAlbums = albums.filter(a => a.keys && a.keys.includes(item.key));
      if (itemAlbums.length > 0) {
        html += '<div class="detail-section"><div class="detail-section-title">📁 Albums</div>';
        html += '<div class="detail-chips">';
        itemAlbums.forEach(a => { html += '<div class="detail-chip">' + (a.name || 'Unnamed') + '</div>'; });
        html += '</div></div>';
      }
      $('detailContent').innerHTML = html;
    }

    /* ═══════════════════════════════════════════════════════════
       ALBUMS
       ═══════════════════════════════════════════════════════════ */
    function rebuildAlbumKeyIndex() {
      albumKeyIndex = new Map();
      albums.forEach(a => {
        if (!a.keys || !a.name) return;
        const lowerName = a.name.toLowerCase();
        a.keys.forEach(k => {
          let names = albumKeyIndex.get(k);
          if (!names) { names = new Set(); albumKeyIndex.set(k, names); }
          names.add(lowerName);
        });
      });
    }

    async function loadAlbums() {
      try {
        const res = await fetch('/catalog/api/albums', { headers: apiHeaders() });
        const data = await res.json();
        albums = data.albums || [];
        rebuildAlbumKeyIndex();
        renderAlbums();
      } catch (err) {
        toast('Failed to load albums', 'error');
      }
    }

    function renderSidebarAlbums() {
      const list = $('albumSublist');
      list.innerHTML = '';
      $('albumBadge').textContent = albums.length;
      albums.forEach(album => {
        const row = document.createElement('div');
        row.className = 'album-subitem';
        row.textContent = album.name;
        const cnt = document.createElement('span');
        cnt.className = 'subitem-count';
        cnt.textContent = album.keys.length;
        row.appendChild(cnt);
        row.addEventListener('click', () => { viewAlbum(album); closeSidebar(); });
        list.appendChild(row);
      });
      const create = document.createElement('div');
      create.className = 'album-subitem create-link';
      create.textContent = '+ Create album';
      create.addEventListener('click', () => { $('createAlbumBtn').click(); closeSidebar(); });
      list.appendChild(create);
    }

    function renderAlbums() {
      renderSidebarAlbums();
      const grid = $('albumGrid');
      grid.innerHTML = '';
      if (albums.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-dim);font-size:14px;grid-column:1/-1;">No albums yet. Click "+ New Album" to create one.</p>';
        return;
      }
      albums.forEach(album => {
        const card = document.createElement('div');
        card.className = 'album-card';

        const cover = document.createElement('div');
        cover.className = 'album-cover';
        if (album.coverKey || album.keys.length > 0) {
          const coverKey = album.coverKey || album.keys[0];
          const img = document.createElement('img');
          img.src = mediaUrl(encodeKeyLocal(coverKey));
          img.loading = 'lazy';
          cover.appendChild(img);
        } else {
          cover.innerHTML = '<span class="no-cover">📷</span>';
        }

        const info = document.createElement('div');
        info.className = 'album-info';
        const name = document.createElement('div');
        name.className = 'album-name';
        name.textContent = album.name;
        const count = document.createElement('div');
        count.className = 'album-count';
        count.textContent = album.keys.length + ' items';

        info.appendChild(name);
        info.appendChild(count);
        card.appendChild(cover);
        card.appendChild(info);

        card.addEventListener('click', () => viewAlbum(album));

        // Context menu for delete
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (confirm('Delete album "' + album.name + '"?')) {
            deleteAlbum(album.id);
          }
        });

        grid.appendChild(card);
      });
    }

    function encodeKeyLocal(key) {
      // Base64url encode
      return btoa(key).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
    }

    $('createAlbumBtn').addEventListener('click', () => {
      $('albumDialogTitle').textContent = 'Create Album';
      $('albumNameInput').value = '';
      $('albumSaveBtn').textContent = 'Create';
      $('albumDialog').classList.add('open');
      $('albumNameInput').focus();
      $('albumSaveBtn').onclick = async () => {
        const name = $('albumNameInput').value.trim();
        if (!name) return;
        $('albumDialog').classList.remove('open');
        try {
          await fetch('/catalog/api/albums', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ name }) });
          toast('Album "' + name + '" created', 'success');
          loadAlbums();
        } catch (err) {
          toast('Failed to create album', 'error');
        }
      };
    });

    $('albumCancelBtn').addEventListener('click', () => $('albumDialog').classList.remove('open'));
    $('albumDialog').addEventListener('click', (e) => { if (e.target === $('albumDialog')) $('albumDialog').classList.remove('open'); });

    async function deleteAlbum(id) {
      try {
        await fetch('/catalog/api/albums/' + id, { method: 'DELETE', headers: apiHeaders() });
        toast('Album deleted', 'success');
        loadAlbums();
      } catch (err) {
        toast('Failed to delete album', 'error');
      }
    }

    function viewAlbum(album) {
      // Show album items in main content area, keeping Albums active in sidebar
      $('searchInput').value = ''; $('searchClear').style.display = 'none';
      clearSelection();

      // Show content area but keep Albums sidebar item active
      currentTab = 'photos';
      $('content').style.display = '';
      $('status').style.display = '';
      $('sentinel').style.display = '';
      $('albumsPanel').classList.remove('visible');
      $('repairPanel').classList.remove('visible');
      document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
      const albumNav = document.querySelector('.sidebar-item[data-nav="albums"]');
      if (albumNav) albumNav.classList.add('active');
      closeSidebar();

      // Filter allItems to only album keys
      const keySet = new Set(album.keys);
      const albumItems = allItems.filter(i => keySet.has(i.key));

      // Render only album items
      sections.clear();
      $('content').innerHTML = '';
      const header = document.createElement('div');
      header.style.cssText = 'padding:12px 8px;display:flex;align-items:center;gap:12px;';
      header.innerHTML = '<button class="icon-btn" id="albumBack" title="Back"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button><h3 style="margin:0">' + album.name + ' <span style="font-weight:400;color:var(--text-dim);font-size:14px">(' + album.keys.length + ' items)</span></h3>';
      $('content').appendChild(header);
      header.querySelector('#albumBack').addEventListener('click', () => { navigateTo('albums'); });

      flatVisible = albumItems.sort(compareItems);
      lastVisibleCount = albumItems.length;
      albumItems.forEach((item, i) => renderItem(item, i));
      $('status').textContent = albumItems.length + ' items in album';
    }

    // Add to album from selection
    $('selAddAlbum').addEventListener('click', async () => {
      if (selected.size === 0) return;
      await loadAlbums();
      const pickList = $('albumPickList');
      pickList.innerHTML = '';
      if (albums.length === 0) {
        pickList.innerHTML = '<p style="color:var(--text-dim);">No albums. Create one first.</p>';
      } else {
        albums.forEach(album => {
          const row = document.createElement('div');
          row.style.cssText = 'padding:10px 12px;cursor:pointer;border-radius:8px;transition:background .15s;';
          row.textContent = album.name + ' (' + album.keys.length + ' items)';
          row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface2)'; });
          row.addEventListener('mouseleave', () => { row.style.background = ''; });
          row.addEventListener('click', async () => {
            $('addToAlbumDialog').classList.remove('open');
            const keys = [...selected].map(ek => {
              const item = allItems.find(i => i.encodedKey === ek);
              return item?.key;
            }).filter(Boolean);
            try {
              await fetch('/catalog/api/albums/' + album.id, {
                method: 'PATCH', headers: apiHeaders(),
                body: JSON.stringify({ addKeys: keys })
              });
              toast(keys.length + ' items added to "' + album.name + '"', 'success');
              clearSelection();
            } catch (err) {
              toast('Failed to add to album', 'error');
            }
          });
          pickList.appendChild(row);
        });
      }
      $('addToAlbumDialog').classList.add('open');
    });

    $('addAlbumCancelBtn').addEventListener('click', () => $('addToAlbumDialog').classList.remove('open'));
    $('addToAlbumDialog').addEventListener('click', (e) => { if (e.target === $('addToAlbumDialog')) $('addToAlbumDialog').classList.remove('open'); });

    /* ═══════════════════════════════════════════════════════════
       DATE REPAIR
       ═══════════════════════════════════════════════════════════ */
    let repairItems = [];
    const repairSelected = new Set();

    $('repairScan').addEventListener('click', async () => {
      $('repairStatus').textContent = 'Scanning…';
      try {
        // Find items with problematic date paths
        const problematic = allItems.filter(i => isProblematic(i.key));
        if (problematic.length === 0 && allItems.length < 1000) {
          // Load all items first
          const res = await fetch('/catalog/api/items/all' + (apiToken ? '?apiToken=' + apiToken : ''), {
            headers: apiToken ? { 'x-api-key': apiToken } : {}
          });
          const data = await res.json();
          const all = data.items || [];
          repairItems = all.filter(i => isProblematic(i.key));
        } else {
          repairItems = problematic;
        }
        $('repairStatus').textContent = repairItems.length + ' items with problematic dates found';
        showRepairItems(repairItems);
      } catch (err) {
        $('repairStatus').textContent = 'Scan failed: ' + err.message;
        toast('Scan failed', 'error');
      }
    });

    function showRepairItems(items) {
      repairItems = items;
      repairSelected.clear();
      const list = $('repairList');
      list.innerHTML = '';
      $('repairActions').style.display = items.length > 0 ? 'flex' : 'none';

      items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'repair-row';
        row.dataset.idx = idx;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          if (cb.checked) repairSelected.add(idx);
          else repairSelected.delete(idx);
        });

        const thumb = document.createElement(item.mediaType === 'video' ? 'video' : 'img');
        thumb.className = 'repair-thumb';
        thumb.src = mediaUrl(item.encodedKey);
        thumb.loading = 'lazy';

        const keyLabel = document.createElement('span');
        keyLabel.className = 'repair-key';
        keyLabel.textContent = item.key;
        keyLabel.title = item.key;

        const currentDate = document.createElement('span');
        currentDate.style.cssText = 'font-size:12px;color:var(--warning);white-space:nowrap;';
        currentDate.textContent = item.sectionDate;

        row.appendChild(cb);
        row.appendChild(thumb);
        row.appendChild(keyLabel);
        row.appendChild(currentDate);
        list.appendChild(row);
      });
    }

    $('repairApply').addEventListener('click', async () => {
      const dateVal = $('repairDate').value;
      if (!dateVal) { toast('Select a target date first', 'error'); return; }
      const indices = repairSelected.size > 0 ? [...repairSelected] : repairItems.map((_, i) => i);
      if (indices.length === 0) { toast('No items to repair', 'error'); return; }

      const dateParts = dateVal.split('-');
      const newDatePrefix = dateParts[0] + '/' + dateParts[1] + '/' + dateParts[2];

      const moves = indices.map(i => ({
        encodedKey: repairItems[i].encodedKey,
        newDatePrefix,
      }));

      toast('Moving ' + moves.length + ' items to ' + newDatePrefix + '…');
      try {
        const res = await fetch('/catalog/api/items/bulk-move', {
          method: 'PATCH',
          headers: apiHeaders(),
          body: JSON.stringify({ moves }),
        });
        const result = await res.json();
        if (result.moved?.length) {
          toast(result.moved.length + ' items moved successfully', 'success');
          // Update allItems in place
          const movedMap = new Map(result.moved.map(m => [m.from, m.to]));
          allItems = allItems.map(i => {
            const newKey = movedMap.get(i.key);
            if (newKey) {
              const capturedAt = inferCapturedAtLocal(newKey, i.lastModified);
              return { ...i, key: newKey, encodedKey: encodeKeyLocal(newKey), capturedAt, sectionDate: capturedAt.slice(0, 10) };
            }
            return i;
          });
          repairItems = repairItems.filter(i => !movedMap.has(i.key));
          showRepairItems(repairItems);
          loadStats();
        }
        if (result.failed?.length) {
          toast(result.failed.length + ' items failed', 'error');
        }
      } catch (err) {
        toast('Move failed: ' + err.message, 'error');
      }
    });

    function inferCapturedAtLocal(key, fallback) {
      const match = key.match(/(\\d{4})\\/(\\d{2})\\/(\\d{2})/);
      if (match) return match[1] + '-' + match[2] + '-' + match[3] + 'T00:00:00.000Z';
      return fallback;
    }

    /* ═══════════════════════════════════════════════════════════
       UTILITIES
       ═══════════════════════════════════════════════════════════ */
    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let v = bytes / 1024, u = 0;
      while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
      return v.toFixed(1) + ' ' + units[u];
    }

    function formatDuration(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + String(s).padStart(2, '0');
    }

    /* ═══════════════════════════════════════════════════════════
       INIT
       ═══════════════════════════════════════════════════════════ */
    function resetAndReload() {
      nextToken = null; hasMore = true; loading = false; loaded = 0;
      allItems = []; prefetchingAll = false; renderQueued = false; lastVisibleCount = 0;
      sections.clear(); $('content').innerHTML = '';
      updateItemStats();
      if (isDateSortSelected()) prefetchAllForDateSort();
      else loadMore();
    }

    /* ═══ Theme toggle ═══ */
    function setTheme(theme) {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('catalogTheme', theme);
      const btn = $('themeToggle');
      if (btn) btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
    $('themeToggle').addEventListener('click', () => {
      const current = document.documentElement.dataset.theme || 'dark';
      setTheme(current === 'dark' ? 'light' : 'dark');
    });

    /* ═══ Search ═══ */
    let searchTimeout;
    $('searchInput').addEventListener('input', () => {
      const val = $('searchInput').value;
      $('searchClear').style.display = val ? 'flex' : 'none';
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        if (val.trim() && hasMore && allItems.length < PREFETCH_MAX_ITEMS) {
          prefetchAllForSearch();
        } else {
          scheduleRender();
        }
      }, 200);
    });
    $('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimeout); resetAndReload(); }
    });
    $('searchClear').addEventListener('click', () => {
      $('searchInput').value = ''; $('searchClear').style.display = 'none';
      scheduleRender();
    });

    /* ═══ Settings menu ═══ */
    $('settingsBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      $('settingsMenu').classList.toggle('visible');
    });
    document.addEventListener('click', (e) => {
      if (!$('settingsMenu').contains(e.target) && e.target !== $('settingsBtn')) {
        $('settingsMenu').classList.remove('visible');
      }
    });
    document.querySelectorAll('#settingsMenu .settings-option[data-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#settingsMenu .settings-option[data-sort]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('sortOrder').value = btn.dataset.sort;
        localStorage.setItem('catalogSort', btn.dataset.sort);
        $('sortOrder').dispatchEvent(new Event('change'));
      });
    });
    document.querySelectorAll('#settingsMenu .settings-option[data-media]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#settingsMenu .settings-option[data-media]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('mediaType').value = btn.dataset.media;
        localStorage.setItem('catalogMedia', btn.dataset.media);
        $('mediaType').dispatchEvent(new Event('change'));
      });
    });
    const GRID_SIZES = { small: ['140px','160px','180px'], medium: ['180px','210px','240px'], large: ['220px','260px','300px'] };
    function applyGridSize(size) {
      const vals = GRID_SIZES[size] || GRID_SIZES.medium;
      document.documentElement.style.setProperty('--grid-min', vals[0]);
      document.documentElement.style.setProperty('--grid-min-md', vals[1]);
      document.documentElement.style.setProperty('--grid-min-lg', vals[2]);
    }
    document.querySelectorAll('#settingsMenu .settings-option[data-grid]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#settingsMenu .settings-option[data-grid]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        localStorage.setItem('catalogGrid', btn.dataset.grid);
        applyGridSize(btn.dataset.grid);
      });
    });
    $('settingsReload').addEventListener('click', () => {
      $('settingsMenu').classList.remove('visible');
      resetAndReload();
    });

    $('mediaType').addEventListener('change', scheduleRender);
    $('sortOrder').addEventListener('change', () => {
      scheduleRender();
      if (isDateSortSelected() && hasMore) prefetchAllForDateSort();
    });

    $('toTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    window.addEventListener('scroll', () => {
      $('toTop').style.display = window.scrollY > 800 ? 'block' : 'none';
      sessionStorage.setItem('catalog.scrollY', String(window.scrollY));
    });

    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting) && currentTab === 'photos') loadMore();
    }, { rootMargin: '800px 0px' });
    observer.observe($('sentinel'));

    async function loadStats() {
      try {
        const headers = apiToken ? { 'x-api-key': apiToken } : {};
        const ctrl = new AbortController();
        const tm = setTimeout(() => ctrl.abort(), 60000);
        const res = await fetch('/catalog/api/stats' + (apiToken ? '?apiToken=' + apiToken : ''), { headers, signal: ctrl.signal });
        clearTimeout(tm);
        if (!res.ok) return;
        const s = await res.json();
        const sb = $('sidebarStats');
        if (sb) {
          let html = '<div class="stat-line"><span class="stat-value">' + s.totalFiles.toLocaleString() + '</span> files</div>';
          html += '<div class="stat-line">📷 ' + s.imageCount.toLocaleString() + ' photos · 🎬 ' + s.videoCount.toLocaleString() + ' videos</div>';
          html += '<div class="stat-line">💾 ' + formatBytes(s.totalBytes) + '</div>';
          if (s.oldestDate && s.newestDate) {
            const fmt = d => new Date(d).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
            html += '<div class="stat-line">📅 ' + fmt(s.oldestDate) + ' — ' + fmt(s.newestDate) + '</div>';
          }
          sb.innerHTML = html;
        }
      } catch { /* non-critical */ }
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && selected.size > 0 && !$('modal').classList.contains('open')) {
        clearSelection();
      }
      if (e.key === 'a' && (e.ctrlKey || e.metaKey) && currentTab === 'photos' && !$('modal').classList.contains('open')) {
        e.preventDefault();
        const visible = getVisibleItems();
        const allSel = visible.every(i => selected.has(i.encodedKey));
        if (allSel) {
          clearSelection();
        } else {
          visible.forEach(i => selected.add(i.encodedKey));
          document.querySelectorAll('.tile').forEach(t => t.classList.add('selected'));
          updateSelectionToolbar();
          updateSectionChecks();
        }
      }
    });

    const savedScroll = Number(sessionStorage.getItem('catalog.scrollY') || '0');

    // Restore persisted settings
    const savedSort = localStorage.getItem('catalogSort');
    if (savedSort && $('sortOrder').querySelector('option[value="' + savedSort + '"]')) {
      $('sortOrder').value = savedSort;
      document.querySelectorAll('#settingsMenu .settings-option[data-sort]').forEach(b => b.classList.toggle('active', b.dataset.sort === savedSort));
    }
    const savedMedia = localStorage.getItem('catalogMedia');
    if (savedMedia && $('mediaType').querySelector('option[value="' + savedMedia + '"]')) {
      $('mediaType').value = savedMedia;
      document.querySelectorAll('#settingsMenu .settings-option[data-media]').forEach(b => b.classList.toggle('active', b.dataset.media === savedMedia));
    }
    const savedGrid = localStorage.getItem('catalogGrid');
    if (savedGrid && GRID_SIZES[savedGrid]) {
      applyGridSize(savedGrid);
      document.querySelectorAll('#settingsMenu .settings-option[data-grid]').forEach(b => b.classList.toggle('active', b.dataset.grid === savedGrid));
    }

    resetAndReload();
    loadStats();
    if (savedScroll > 0) setTimeout(() => window.scrollTo(0, savedScroll), 200);
  </script>
</body>
</html>`;
}