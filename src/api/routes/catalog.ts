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

    if (media.contentType) {
      reply.type(media.contentType);
    }
    reply.header('Cache-Control', 'private, max-age=60');
    return reply.send(media.stream);
  });
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
    :root { color-scheme: light dark; }
    body { margin:0; font-family: Inter, system-ui, sans-serif; background:#0f1115; color:#e8ecf3; }
    .topbar { position:sticky; top:0; z-index:10; display:flex; gap:10px; align-items:center; padding:10px 12px; background:#141923cc; backdrop-filter:blur(6px); border-bottom:1px solid #252b39; }
    .topbar input { height:34px; border-radius:8px; border:1px solid #31384a; padding:0 10px; background:#0f131c; color:#e8ecf3; }
    .topbar button { height:34px; border-radius:8px; border:1px solid #31384a; background:#1f2633; color:#e8ecf3; padding:0 12px; cursor:pointer; }
    .content { padding:8px; }
    .section-title { position:sticky; top:56px; z-index:5; margin:0; padding:8px 6px; font-size:13px; color:#c8d0df; background:#0f1115f2; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:6px; }
    .tile { position:relative; width:100%; aspect-ratio:1/1; border-radius:8px; overflow:hidden; background:#161c28; cursor:pointer; }
    .tile img, .tile video { width:100%; height:100%; object-fit:cover; display:block; }
    .tile .meta { position:absolute; left:0; right:0; bottom:0; font-size:11px; padding:4px 6px; background:linear-gradient(to top, rgba(0,0,0,.65), rgba(0,0,0,0)); }
    .status { text-align:center; color:#9aa6bf; font-size:13px; padding:14px; }
    #sentinel { height:1px; }
    #toTop { position:fixed; right:16px; bottom:16px; width:42px; height:42px; border-radius:50%; border:1px solid #31384a; background:#1f2633; color:#e8ecf3; cursor:pointer; display:none; }
    .modal { position:fixed; inset:0; display:none; place-items:center; background:rgba(0,0,0,.8); z-index:20; }
    .modal.open { display:grid; }
    .modal-inner { width:min(92vw,1200px); height:min(90vh,900px); background:#0f131c; border:1px solid #2d3446; border-radius:10px; overflow:hidden; display:grid; grid-template-rows:auto 1fr; }
    .modal-head { display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid #2d3446; font-size:12px; }
    .modal-body { display:grid; place-items:center; padding:8px; }
    .modal-body img, .modal-body video { max-width:100%; max-height:100%; object-fit:contain; }
  </style>
</head>
<body>
  <div class="topbar">
    <strong>Scaleway Catalog</strong>
    <input id="prefix" placeholder="Prefix (optional)" />
    <button id="reloadBtn">Reload</button>
    <span id="stats" style="font-size:12px;color:#9aa6bf"></span>
  </div>
  <div class="content" id="content"></div>
  <div class="status" id="status">Loading…</div>
  <div id="sentinel"></div>
  <button id="toTop" title="Back to top">↑</button>

  <div class="modal" id="modal">
    <div class="modal-inner">
      <div class="modal-head">
        <span id="modalTitle">Preview</span>
        <button id="closeModal">Close</button>
      </div>
      <div class="modal-body" id="modalBody"></div>
    </div>
  </div>

  <script>
    const content = document.getElementById('content');
    const statusEl = document.getElementById('status');
    const statsEl = document.getElementById('stats');
    const sentinel = document.getElementById('sentinel');
    const prefixInput = document.getElementById('prefix');
    const reloadBtn = document.getElementById('reloadBtn');
    const toTop = document.getElementById('toTop');
    const modal = document.getElementById('modal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    const closeModal = document.getElementById('closeModal');

    const query = new URLSearchParams(location.search);
    const apiToken = query.get('apiToken') || '';

    let nextToken = null;
    let loading = false;
    let hasMore = true;
    let loaded = 0;

    const sections = new Map();

    function mediaUrl(encodedKey) {
      const url = new URL('/catalog/media/' + encodedKey, location.origin);
      if (apiToken) url.searchParams.set('apiToken', apiToken);
      return url.toString();
    }

    async function loadMore() {
      if (loading || !hasMore) return;
      loading = true;
      statusEl.textContent = 'Loading…';

      const params = new URLSearchParams();
      params.set('max', '90');
      if (nextToken) params.set('token', nextToken);
      const prefix = prefixInput.value.trim();
      if (prefix) params.set('prefix', prefix);
      if (apiToken) params.set('apiToken', apiToken);

      try {
        const res = await fetch('/catalog/api/items?' + params.toString(), {
          headers: apiToken ? { 'x-api-key': apiToken } : {},
        });
        if (!res.ok) throw new Error('Request failed: ' + res.status);

        const page = await res.json();
        for (const item of page.items || []) renderItem(item);

        loaded += (page.items || []).length;
        statsEl.textContent = loaded + ' items';
        nextToken = page.nextToken || null;
        hasMore = Boolean(nextToken);
        statusEl.textContent = hasMore ? 'Scroll for more' : (loaded ? 'Completed' : 'No items found');
      } catch (err) {
        statusEl.textContent = 'Error loading catalog';
      } finally {
        loading = false;
      }
    }

    function getSection(dateStr) {
      let section = sections.get(dateStr);
      if (section) return section;

      const title = document.createElement('h3');
      title.className = 'section-title';
      title.textContent = dateStr;

      const grid = document.createElement('div');
      grid.className = 'grid';

      const wrap = document.createElement('section');
      wrap.appendChild(title);
      wrap.appendChild(grid);
      content.appendChild(wrap);

      sections.set(dateStr, grid);
      return grid;
    }

    function renderItem(item) {
      const grid = getSection(item.sectionDate || 'Unknown date');
      const tile = document.createElement('div');
      tile.className = 'tile';

      const src = mediaUrl(item.encodedKey);
      const media = document.createElement(item.mediaType === 'video' ? 'video' : 'img');
      media.loading = 'lazy';
      media.src = src;
      if (item.mediaType === 'video') {
        media.muted = true;
        media.playsInline = true;
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = formatBytes(item.size || 0);

      tile.appendChild(media);
      tile.appendChild(meta);
      tile.addEventListener('click', () => openModal(item));
      grid.appendChild(tile);
    }

    function openModal(item) {
      modalTitle.textContent = item.key;
      modalBody.innerHTML = '';
      const src = mediaUrl(item.encodedKey);
      const media = document.createElement(item.mediaType === 'video' ? 'video' : 'img');
      media.src = src;
      if (item.mediaType === 'video') {
        media.controls = true;
        media.autoplay = true;
      }
      modalBody.appendChild(media);
      modal.classList.add('open');
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = units[0];
      for (let i = 1; i < units.length && value >= 1024; i++) {
        value /= 1024;
        unit = units[i];
      }
      return value.toFixed(1) + ' ' + unit;
    }

    function resetAndReload() {
      nextToken = null;
      hasMore = true;
      loading = false;
      loaded = 0;
      sections.clear();
      content.innerHTML = '';
      loadMore();
    }

    reloadBtn.addEventListener('click', resetAndReload);
    closeModal.addEventListener('click', () => {
      modal.classList.remove('open');
      modalBody.innerHTML = '';
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('open');
        modalBody.innerHTML = '';
      }
    });

    toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    window.addEventListener('scroll', () => {
      toTop.style.display = window.scrollY > 800 ? 'block' : 'none';
      sessionStorage.setItem('catalog.scrollY', String(window.scrollY));
    });

    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        loadMore();
      }
    }, { rootMargin: '800px 0px' });
    observer.observe(sentinel);

    const saved = Number(sessionStorage.getItem('catalog.scrollY') || '0');
    resetAndReload();
    if (saved > 0) {
      setTimeout(() => window.scrollTo(0, saved), 200);
    }
  </script>
</body>
</html>`;
}