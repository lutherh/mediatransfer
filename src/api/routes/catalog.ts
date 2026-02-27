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
  <style>
    :root { color-scheme: light dark; --bg: #0f1115; --surface: #141923; --surface2: #1a2030; --border: #252b39; --text: #e8ecf3; --text-dim: #9aa6bf; --accent: #4d8bff; --accent-light: #6ba0ff; --danger: #ff4d6a; --danger-dim: #3d1520; --warning: #ffb84d; --warning-dim: #3d2e15; --success: #4dff88; --check-bg: #4d8bff; --select-ring: #4d8bff55; --tile-radius: 4px; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: 'Google Sans', Inter, system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--text); }

    /* ── Top bar ── */
    .topbar { position:sticky; top:0; z-index:50; display:flex; gap:10px; align-items:center; padding:8px 16px; background:var(--surface); border-bottom:1px solid var(--border); min-height:56px; }
    .topbar .logo { font-size:18px; font-weight:600; white-space:nowrap; display:flex; align-items:center; gap:8px; }
    .topbar .logo svg { width:24px; height:24px; }
    .topbar input, .topbar select { height:36px; border-radius:8px; border:1px solid var(--border); padding:0 12px; background:var(--bg); color:var(--text); font-size:13px; }
    .topbar input:focus, .topbar select:focus { outline:none; border-color:var(--accent); }
    .topbar .spacer { flex:1; }
    .icon-btn { width:36px; height:36px; border-radius:50%; border:none; background:transparent; color:var(--text-dim); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:background .15s; }
    .icon-btn:hover { background:var(--surface2); color:var(--text); }
    .icon-btn svg { width:20px; height:20px; fill:currentColor; }

    /* ── Selection toolbar ── */
    .sel-toolbar { position:fixed; top:0; left:0; right:0; z-index:60; display:flex; align-items:center; gap:8px; padding:8px 16px; background:var(--surface); border-bottom:2px solid var(--accent); transform:translateY(-100%); transition:transform .2s ease; }
    .sel-toolbar.visible { transform:translateY(0); }
    .sel-toolbar .sel-count { font-size:16px; font-weight:600; margin-left:8px; }
    .sel-toolbar .spacer { flex:1; }
    .sel-toolbar .icon-btn { color:var(--text); }
    .sel-toolbar .icon-btn:hover { background:var(--surface2); }
    .sel-toolbar .icon-btn.danger:hover { background:var(--danger-dim); color:var(--danger); }

    /* ── Stats bar ── */
    .stats-bar { display:flex; gap:16px; align-items:center; padding:8px 16px; background:var(--surface); border-bottom:1px solid var(--border); font-size:13px; color:var(--text-dim); flex-wrap:wrap; }
    .stats-bar .stat-value { color:var(--text); font-weight:600; }
    .stats-bar .stat-label { margin-left:3px; }
    .stats-bar .divider { width:1px; height:18px; background:var(--border); }

    /* ── Tabs ── */
    .tab-bar { display:flex; gap:0; padding:0 16px; background:var(--surface); border-bottom:1px solid var(--border); }
    .tab-btn { padding:10px 20px; font-size:13px; font-weight:500; color:var(--text-dim); border:none; background:none; cursor:pointer; border-bottom:2px solid transparent; transition:all .15s; }
    .tab-btn:hover { color:var(--text); }
    .tab-btn.active { color:var(--accent); border-bottom-color:var(--accent); }

    /* ── Content ── */
    .content { padding:4px 8px 80px; }
    .section { margin-bottom:4px; }
    .section-header { position:sticky; top:56px; z-index:5; display:flex; align-items:center; gap:10px; padding:12px 8px 6px; background:var(--bg); }
    .section-header .section-check { width:24px; height:24px; border-radius:50%; border:2px solid var(--text-dim); background:transparent; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all .15s; opacity:0; }
    .section:hover .section-check, .section-header .section-check.some-selected { opacity:1; }
    .section-header .section-check.all-selected { background:var(--check-bg); border-color:var(--check-bg); opacity:1; }
    .section-header .section-check svg { width:14px; height:14px; fill:#fff; display:none; }
    .section-header .section-check.all-selected svg, .section-header .section-check.some-selected svg { display:block; }
    .section-header .section-date { font-size:15px; font-weight:600; color:var(--text); }
    .section-header .section-count { font-size:12px; color:var(--text-dim); }
    .section-header .section-warn { display:inline-flex; align-items:center; gap:4px; font-size:11px; color:var(--warning); background:var(--warning-dim); padding:2px 8px; border-radius:10px; }

    /* ── Grid ── */
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:3px; }
    @media (min-width:900px) { .grid { grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); } }
    @media (min-width:1400px) { .grid { grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); } }

    /* ── Tile ── */
    .tile { position:relative; aspect-ratio:1; border-radius:var(--tile-radius); overflow:hidden; background:var(--surface2); cursor:pointer; content-visibility:auto; contain-intrinsic-size:200px; }
    .tile img, .tile video { width:100%; height:100%; object-fit:cover; display:block; transition:transform .2s; }
    .tile:hover img, .tile:hover video { transform:scale(1.03); }
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

    /* ── Modal ── */
    .modal { position:fixed; inset:0; display:none; place-items:center; background:rgba(0,0,0,.85); z-index:70; }
    .modal.open { display:grid; }
    .modal-inner { width:min(94vw,1300px); height:min(92vh,950px); background:var(--bg); border:1px solid var(--border); border-radius:12px; overflow:hidden; display:grid; grid-template-rows:auto 1fr auto; }
    .modal-head { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border-bottom:1px solid var(--border); font-size:13px; }
    .modal-head .title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; margin-right:12px; }
    .modal-body { display:grid; place-items:center; padding:8px; overflow:hidden; }
    .modal-body img, .modal-body video { max-width:100%; max-height:100%; object-fit:contain; }
    .modal-nav { display:flex; justify-content:center; align-items:center; gap:12px; padding:10px; border-top:1px solid var(--border); }
    .modal-nav button { padding:6px 16px; border-radius:8px; border:1px solid var(--border); background:var(--surface2); color:var(--text); cursor:pointer; }
    .modal-nav button:disabled { opacity:.3; cursor:default; }
    .modal-nav .pos { font-size:12px; color:var(--text-dim); }

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

  <!-- ═══ Top bar ═══ -->
  <div class="topbar" id="topbar">
    <div class="logo">
      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
      Catalog
    </div>
    <input id="prefix" placeholder="Search prefix…" style="width:180px" />
    <select id="mediaType" title="Filter by media type">
      <option value="all">All media</option>
      <option value="image">Photos</option>
      <option value="video">Videos</option>
    </select>
    <select id="sortOrder" title="Arrange order">
      <option value="date-desc">Newest first</option>
      <option value="date-asc">Oldest first</option>
      <option value="key-asc">Name A→Z</option>
      <option value="key-desc">Name Z→A</option>
      <option value="size-desc">Largest first</option>
      <option value="size-asc">Smallest first</option>
    </select>
    <div class="spacer"></div>
    <button class="icon-btn" id="reloadBtn" title="Reload"><svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>
    <span id="stats" style="font-size:12px;color:var(--text-dim)"></span>
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

  <!-- ═══ Stats bar ═══ -->
  <div class="stats-bar" id="statsBar" style="display:none">
    <span>☁️ <span class="stat-value" id="statTotal">-</span><span class="stat-label">files</span></span>
    <div class="divider"></div>
    <span>📷 <span class="stat-value" id="statPhotos">-</span><span class="stat-label">photos</span></span>
    <div class="divider"></div>
    <span>🎬 <span class="stat-value" id="statVideos">-</span><span class="stat-label">videos</span></span>
    <div class="divider"></div>
    <span>💾 <span class="stat-value" id="statSize">-</span></span>
    <div class="divider"></div>
    <span>📅 <span class="stat-value" id="statRange">-</span></span>
  </div>

  <!-- ═══ Tab bar ═══ -->
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="photos">Photos</button>
    <button class="tab-btn" data-tab="albums">Albums</button>
    <button class="tab-btn" data-tab="repair">Date Repair</button>
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

  <!-- ═══ Preview modal ═══ -->
  <div class="modal" id="modal">
    <div class="modal-inner">
      <div class="modal-head">
        <span class="title" id="modalTitle">Preview</span>
        <div style="display:flex;gap:4px;">
          <button class="icon-btn" id="modalDownload" title="Download"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
          <button class="icon-btn danger" id="modalDelete" title="Delete"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
          <button class="icon-btn" id="closeModal" title="Close"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
        </div>
      </div>
      <div class="modal-body" id="modalBody"></div>
      <div class="modal-nav">
        <button id="modalPrev">← Prev</button>
        <span class="pos" id="modalPos"></span>
        <button id="modalNext">Next →</button>
      </div>
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
    let currentTab = 'photos';
    let albums = [];
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
       TABS
       ═══════════════════════════════════════════════════════════ */
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTab = btn.dataset.tab;
        $('content').style.display = currentTab === 'photos' ? '' : 'none';
        $('status').style.display = currentTab === 'photos' ? '' : 'none';
        $('sentinel').style.display = currentTab === 'photos' ? '' : 'none';
        $('albumsPanel').classList.toggle('visible', currentTab === 'albums');
        $('repairPanel').classList.toggle('visible', currentTab === 'repair');
        if (currentTab === 'albums') loadAlbums();
      });
    });

    /* ═══════════════════════════════════════════════════════════
       SELECTION
       ═══════════════════════════════════════════════════════════ */
    function updateSelectionToolbar() {
      const bar = $('selToolbar');
      bar.classList.toggle('visible', selected.size > 0);
      $('selCount').textContent = selected.size + ' selected';
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
       DELETE
       ═══════════════════════════════════════════════════════════ */
    function showDeleteDialog(encodedKeys) {
      $('deleteMsg').textContent = 'This will permanently delete ' + encodedKeys.length + ' item' + (encodedKeys.length > 1 ? 's' : '') + ' from Scaleway storage. This cannot be undone.';
      $('deleteDialog').classList.add('open');
      $('deleteConfirmBtn').onclick = async () => {
        $('deleteDialog').classList.remove('open');
        toast('Deleting ' + encodedKeys.length + ' items…');
        try {
          const res = await fetch('/catalog/api/items', {
            method: 'DELETE',
            headers: apiHeaders(),
            body: JSON.stringify({ encodedKeys }),
          });
          const result = await res.json();
          if (result.deleted?.length) {
            toast(result.deleted.length + ' items deleted', 'success');
            // Remove from allItems
            const deletedSet = new Set(result.deleted);
            allItems = allItems.filter(i => !deletedSet.has(i.key));
            selected.clear();
            updateSelectionToolbar();
            scheduleRender();
            loadStats();
          }
          if (result.failed?.length) {
            toast(result.failed.length + ' items failed to delete', 'error');
          }
        } catch (err) {
          toast('Delete failed: ' + err.message, 'error');
        }
      };
    }

    $('deleteCancelBtn').addEventListener('click', () => $('deleteDialog').classList.remove('open'));
    $('deleteDialog').addEventListener('click', (e) => { if (e.target === $('deleteDialog')) $('deleteDialog').classList.remove('open'); });

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
      // Switch to repair tab with selected items
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === 'repair');
      });
      currentTab = 'repair';
      $('content').style.display = 'none';
      $('status').style.display = 'none';
      $('sentinel').style.display = 'none';
      $('albumsPanel').classList.remove('visible');
      $('repairPanel').classList.add('visible');
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
      const prefix = $('prefix').value.trim();
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

    function updateItemStats() {
      $('stats').textContent = lastVisibleCount + ' shown / ' + loaded + ' loaded';
    }

    /* ═══════════════════════════════════════════════════════════
       SORTING / FILTERING
       ═══════════════════════════════════════════════════════════ */
    function getVisibleItems() {
      const type = $('mediaType').value;
      return allItems.filter(i => type === 'all' || i.mediaType === type);
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
      const diff = Math.floor((now - d) / 86400000);
      const opts = { weekday: 'short', day: 'numeric', month: 'short' };
      if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
      return d.toLocaleDateString(undefined, opts);
    }

    function renderAllItems() {
      renderQueued = false;
      sections.clear();
      $('content').innerHTML = '';
      const items = getVisibleItems().slice().sort(compareItems);
      flatVisible = items;
      lastVisibleCount = items.length;
      const version = ++renderVersion;
      let idx = 0;
      const BATCH = 200;

      function chunk() {
        if (version !== renderVersion) return;
        const end = Math.min(idx + BATCH, items.length);
        for (; idx < end; idx++) renderItem(items[idx], idx);
        if (idx < items.length) requestAnimationFrame(chunk);
      }
      requestAnimationFrame(chunk);
    }

    function scheduleRender() {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => { renderAllItems(); updateItemStats(); });
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

      // Check if this section has problematic items
      const sectionItems = allItems.filter(i => i.sectionDate === dateStr);
      const problemCount = sectionItems.filter(i => isProblematic(i.key)).length;
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

      // Update count after rendering
      requestAnimationFrame(() => {
        countLabel.textContent = grid.children.length + ' items';
      });

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
      check.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(item.encodedKey, tile); });

      // Media element
      const media = document.createElement(item.mediaType === 'video' ? 'video' : 'img');
      media.loading = 'lazy';
      media.decoding = 'async';
      media.src = src;
      if (item.mediaType === 'video') {
        media.muted = true;
        media.playsInline = true;
        media.preload = 'metadata';
      }

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
        if (selected.size > 0) {
          // In selection mode, click toggles selection
          toggleSelect(item.encodedKey, tile);
        } else {
          openModal(globalIdx);
        }
      });

      grid.appendChild(tile);
    }

    /* ═══════════════════════════════════════════════════════════
       MODAL (with prev/next)
       ═══════════════════════════════════════════════════════════ */
    function openModal(idx) {
      modalIndex = idx;
      renderModal();
      $('modal').classList.add('open');
    }

    function renderModal() {
      const item = flatVisible[modalIndex];
      if (!item) return;
      $('modalTitle').textContent = item.key;
      $('modalBody').innerHTML = '';
      const src = mediaUrl(item.encodedKey);
      const media = document.createElement(item.mediaType === 'video' ? 'video' : 'img');
      media.src = src;
      if (item.mediaType === 'video') { media.controls = true; media.autoplay = true; }
      $('modalBody').appendChild(media);
      $('modalPos').textContent = (modalIndex + 1) + ' / ' + flatVisible.length;
      $('modalPrev').disabled = modalIndex <= 0;
      $('modalNext').disabled = modalIndex >= flatVisible.length - 1;
      // Store current item for modal actions
      $('modal').dataset.ek = item.encodedKey;
    }

    $('modalPrev').addEventListener('click', () => { if (modalIndex > 0) { modalIndex--; renderModal(); } });
    $('modalNext').addEventListener('click', () => { if (modalIndex < flatVisible.length - 1) { modalIndex++; renderModal(); } });

    $('closeModal').addEventListener('click', () => { $('modal').classList.remove('open'); $('modalBody').innerHTML = ''; });
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) { $('modal').classList.remove('open'); $('modalBody').innerHTML = ''; } });

    // Keyboard nav for modal
    document.addEventListener('keydown', (e) => {
      if (!$('modal').classList.contains('open')) return;
      if (e.key === 'ArrowLeft') { $('modalPrev').click(); }
      else if (e.key === 'ArrowRight') { $('modalNext').click(); }
      else if (e.key === 'Escape') { $('closeModal').click(); }
    });

    $('modalDownload').addEventListener('click', () => {
      const ek = $('modal').dataset.ek;
      if (ek) downloadFile(ek);
    });

    $('modalDelete').addEventListener('click', () => {
      const ek = $('modal').dataset.ek;
      if (ek) {
        $('modal').classList.remove('open');
        $('modalBody').innerHTML = '';
        showDeleteDialog([ek]);
      }
    });

    /* ═══════════════════════════════════════════════════════════
       ALBUMS
       ═══════════════════════════════════════════════════════════ */
    async function loadAlbums() {
      try {
        const res = await fetch('/catalog/api/albums', { headers: apiHeaders() });
        const data = await res.json();
        albums = data.albums || [];
        renderAlbums();
      } catch (err) {
        toast('Failed to load albums', 'error');
      }
    }

    function renderAlbums() {
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
      // Filter to show only album items in main view
      $('prefix').value = '';
      clearSelection();
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'photos'));
      currentTab = 'photos';
      $('content').style.display = '';
      $('status').style.display = '';
      $('sentinel').style.display = '';
      $('albumsPanel').classList.remove('visible');
      $('repairPanel').classList.remove('visible');

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
      header.querySelector('#albumBack').addEventListener('click', () => { scheduleRender(); });

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

    $('reloadBtn').addEventListener('click', resetAndReload);
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
        $('statTotal').textContent = s.totalFiles.toLocaleString();
        $('statPhotos').textContent = s.imageCount.toLocaleString();
        $('statVideos').textContent = s.videoCount.toLocaleString();
        $('statSize').textContent = formatBytes(s.totalBytes);
        if (s.oldestDate && s.newestDate) {
          const fmt = d => new Date(d).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
          $('statRange').textContent = fmt(s.oldestDate) + ' — ' + fmt(s.newestDate);
        }
        $('statsBar').style.display = 'flex';
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
    resetAndReload();
    loadStats();
    if (savedScroll > 0) setTimeout(() => window.scrollTo(0, savedScroll), 200);
  </script>
</body>
</html>`;
}