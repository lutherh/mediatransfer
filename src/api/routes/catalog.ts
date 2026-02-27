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
    :root { color-scheme: light dark; }
    body { margin:0; font-family: Inter, system-ui, sans-serif; background:#0f1115; color:#e8ecf3; }
    .topbar { position:sticky; top:0; z-index:10; display:flex; gap:10px; align-items:center; padding:10px 12px; background:#141923cc; backdrop-filter:blur(6px); border-bottom:1px solid #252b39; }
    .topbar input, .topbar select { height:34px; border-radius:8px; border:1px solid #31384a; padding:0 10px; background:#0f131c; color:#e8ecf3; }
    .topbar button { height:34px; border-radius:8px; border:1px solid #31384a; background:#1f2633; color:#e8ecf3; padding:0 12px; cursor:pointer; }
    .content { padding:8px; }
    .stats-bar { display:flex; gap:16px; align-items:center; padding:8px 14px; background:#141923; border-bottom:1px solid #252b39; font-size:13px; color:#9aa6bf; flex-wrap:wrap; }
    .stats-bar .stat-value { color:#e8ecf3; font-weight:600; }
    .stats-bar .stat-label { margin-left:3px; }
    .stats-bar .divider { width:1px; height:18px; background:#31384a; }
    .section-title { position:sticky; top:56px; z-index:5; margin:0; padding:8px 6px; font-size:13px; color:#c8d0df; background:#0f1115f2; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:6px; }
    .tile { position:relative; width:100%; aspect-ratio:1/1; border-radius:8px; overflow:hidden; background:#161c28; cursor:pointer; content-visibility:auto; contain-intrinsic-size:170px 170px; }
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
    <select id="mediaType" title="Filter by media type">
      <option value="all">All media</option>
      <option value="image">Photos only</option>
      <option value="video">Videos only</option>
    </select>
    <select id="sortOrder" title="Arrange order">
      <option value="date-desc">Newest first</option>
      <option value="date-asc">Oldest first</option>
      <option value="key-asc">Name A→Z</option>
      <option value="key-desc">Name Z→A</option>
      <option value="size-desc">Largest first</option>
      <option value="size-asc">Smallest first</option>
    </select>
    <button id="reloadBtn">Reload</button>
    <span id="stats" style="font-size:12px;color:#9aa6bf"></span>
  </div>
  <div class="stats-bar" id="statsBar" style="display:none">
    <span>☁️ <span class="stat-value" id="statTotal">—</span><span class="stat-label">files</span></span>
    <div class="divider"></div>
    <span>📷 <span class="stat-value" id="statPhotos">—</span><span class="stat-label">photos</span></span>
    <div class="divider"></div>
    <span>🎬 <span class="stat-value" id="statVideos">—</span><span class="stat-label">videos</span></span>
    <div class="divider"></div>
    <span>💾 <span class="stat-value" id="statSize">—</span></span>
    <div class="divider"></div>
    <span>📅 <span class="stat-value" id="statRange">—</span></span>
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
    const mediaTypeSelect = document.getElementById('mediaType');
    const sortOrderSelect = document.getElementById('sortOrder');
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
    let allItems = [];
    let renderVersion = 0;
    let prefetchingAll = false;
    let renderQueued = false;
    let lastVisibleCount = 0;

    const PREFETCH_MAX_ITEMS = 3000;
    const PREFETCH_MAX_PAGES = 25;

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
      params.set('max', isDateSortSelected() ? '200' : '90');
      if (nextToken) params.set('token', nextToken);
      const prefix = prefixInput.value.trim();
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
        if (!prefetchingAll) {
          scheduleRender();
        }
        updateStats();
        nextToken = page.nextToken || null;
        hasMore = Boolean(nextToken);
        if (prefetchingAll && hasMore) {
          statusEl.textContent = 'Loading all items for date sorting…';
        } else {
          statusEl.textContent = hasMore ? 'Scroll for more' : (allItems.length ? 'Completed' : 'No items found');
        }
      } catch (err) {
        statusEl.textContent = 'Error loading catalog — click Reload to retry';
      } finally {
        clearTimeout(timeout);
        loading = false;
      }
    }

    function isDateSortSelected() {
      const value = sortOrderSelect.value;
      return value === 'date-desc' || value === 'date-asc';
    }

    async function prefetchAllForDateSort() {
      if (prefetchingAll || !isDateSortSelected() || !hasMore) {
        return;
      }

      prefetchingAll = true;
      try {
        let pagesLoaded = 0;
        while (hasMore && pagesLoaded < PREFETCH_MAX_PAGES && allItems.length < PREFETCH_MAX_ITEMS) {
          await loadMore();
          pagesLoaded += 1;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } finally {
        prefetchingAll = false;
        scheduleRender();
        if (hasMore) {
          statusEl.textContent = 'Loaded ' + loaded + ' items. Refine prefix for faster date sorting.';
        } else {
          statusEl.textContent = allItems.length ? 'Completed' : 'No items found';
        }
      }
    }

    function updateStats() {
      statsEl.textContent = lastVisibleCount + ' shown / ' + loaded + ' loaded';
    }

    function getVisibleItems() {
      const selectedType = mediaTypeSelect.value;
      return allItems.filter((item) => {
        if (selectedType === 'all') return true;
        return item.mediaType === selectedType;
      });
    }

    function parseDateValue(item) {
      if (item.capturedAt) {
        const captured = Date.parse(item.capturedAt);
        if (!Number.isNaN(captured)) return captured;
      }

      if (item.lastModified) {
        const precise = Date.parse(item.lastModified);
        if (!Number.isNaN(precise)) return precise;
      }

      if (item.sectionDate) {
        const dayLevel = Date.parse(item.sectionDate);
        if (!Number.isNaN(dayLevel)) return dayLevel;
      }

      return 0;
    }

    function compareItems(a, b) {
      const sortOrder = sortOrderSelect.value;
      if (sortOrder === 'date-asc') return parseDateValue(a) - parseDateValue(b);
      if (sortOrder === 'date-desc') return parseDateValue(b) - parseDateValue(a);
      if (sortOrder === 'key-asc') return String(a.key || '').localeCompare(String(b.key || ''));
      if (sortOrder === 'key-desc') return String(b.key || '').localeCompare(String(a.key || ''));
      if (sortOrder === 'size-asc') return Number(a.size || 0) - Number(b.size || 0);
      if (sortOrder === 'size-desc') return Number(b.size || 0) - Number(a.size || 0);
      return 0;
    }

    function renderAllItems() {
      renderQueued = false;
      sections.clear();
      content.innerHTML = '';

      const items = getVisibleItems().slice().sort(compareItems);
      lastVisibleCount = items.length;
      const version = ++renderVersion;
      let index = 0;
      const batchSize = 150;

      function renderChunk() {
        if (version !== renderVersion) {
          return;
        }

        const end = Math.min(index + batchSize, items.length);
        for (; index < end; index += 1) {
          renderItem(items[index]);
        }

        if (index < items.length) {
          requestAnimationFrame(renderChunk);
        }
      }

      requestAnimationFrame(renderChunk);
    }

    function scheduleRender() {
      if (renderQueued) {
        return;
      }
      renderQueued = true;
      requestAnimationFrame(() => {
        renderAllItems();
        updateStats();
      });
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
      media.decoding = 'async';
      media.src = src;
      if (item.mediaType === 'video') {
        media.muted = true;
        media.playsInline = true;
        media.preload = 'metadata';
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
      allItems = [];
      prefetchingAll = false;
      renderQueued = false;
      lastVisibleCount = 0;
      sections.clear();
      content.innerHTML = '';
      updateStats();
      if (isDateSortSelected()) {
        prefetchAllForDateSort();
      } else {
        loadMore();
      }
    }

    reloadBtn.addEventListener('click', resetAndReload);
    mediaTypeSelect.addEventListener('change', () => {
      scheduleRender();
    });
    sortOrderSelect.addEventListener('change', () => {
      scheduleRender();
      if (isDateSortSelected() && hasMore) {
        prefetchAllForDateSort();
      }
    });
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

    async function loadStats() {
      const statsBar = document.getElementById('statsBar');
      try {
        const headers = apiToken ? { 'x-api-key': apiToken } : {};
        const statsCtrl = new AbortController();
        const statsTimeout = setTimeout(() => statsCtrl.abort(), 60000);
        const res = await fetch('/catalog/api/stats' + (apiToken ? '?apiToken=' + apiToken : ''), { headers, signal: statsCtrl.signal });
        clearTimeout(statsTimeout);
        if (!res.ok) return;
        const s = await res.json();
        document.getElementById('statTotal').textContent = s.totalFiles.toLocaleString();
        document.getElementById('statPhotos').textContent = s.imageCount.toLocaleString();
        document.getElementById('statVideos').textContent = s.videoCount.toLocaleString();
        document.getElementById('statSize').textContent = formatBytes(s.totalBytes);
        if (s.oldestDate && s.newestDate) {
          const fmt = (d) => new Date(d).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
          document.getElementById('statRange').textContent = fmt(s.oldestDate) + ' — ' + fmt(s.newestDate);
        }
        statsBar.style.display = 'flex';
      } catch { /* stats are non-critical */ }
    }

    const saved = Number(sessionStorage.getItem('catalog.scrollY') || '0');
    resetAndReload();
    loadStats();
    if (saved > 0) {
      setTimeout(() => window.scrollTo(0, saved), 200);
    }
  </script>
</body>
</html>`;
}