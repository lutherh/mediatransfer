/**
 * End-to-end workflow tests.
 *
 * Each test chains multiple API calls that mirror a real user session.
 * All external services (DB, Redis, S3) are mocked via ApiServices injection.
 *
 * Run:  npx vitest run src/api/e2e.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { TransferStatus } from '../generated/prisma/index.js';
import { createApiServer } from './index.js';
import type { ApiServices } from './types.js';
import { clearEnvCache } from '../config/env.js';

beforeEach(() => {
  process.env.ENCRYPTION_SECRET = 'e2e-test-encryption-secret-1234';
  clearEnvCache();
});

// ── Helpers ──────────────────────────────────────────────

function createServices(): ApiServices {
  return {
    credentials: {
      create: vi.fn(async (input) => ({
        id: `cred-${Date.now()}`,
        name: input.name,
        provider: input.provider,
        config: input.config,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      list: vi.fn(async () => []),
      delete: vi.fn(async () => ({
        id: 'cred-1',
        name: 'main',
        provider: 'scaleway',
        config: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    },
    jobs: {
      create: vi.fn(async (input) => ({
        id: 'job-e2e',
        sourceProvider: input.sourceProvider,
        destProvider: input.destProvider,
        sourceConfig: input.sourceConfig ?? null,
        destConfig: input.destConfig ?? null,
        keys: input.keys ?? [],
        status: TransferStatus.PENDING,
        progress: 0,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      })),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      update: vi.fn(async (id, input) => ({
        id,
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        sourceConfig: null,
        destConfig: null,
        keys: [],
        status: input.status ?? TransferStatus.PENDING,
        progress: input.progress ?? 0,
        errorMessage: input.errorMessage ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      })),
      delete: vi.fn(async (id) => ({
        id,
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        sourceConfig: null,
        destConfig: null,
        keys: [],
        status: TransferStatus.CANCELLED,
        progress: 0,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      })),
      listLogs: vi.fn(async () => []),
    },
    providers: {
      listNames: vi.fn(() => ['scaleway']),
      testConnection: vi.fn(async () => ({ ok: true, message: 'Connection successful' })),
      listObjects: vi.fn(async () => []),
    },
    queue: {
      enqueueBulk: vi.fn(async (input) => ({
        enqueuedCount: input.keys?.length ?? 0,
        queueJobIds: (input.keys ?? []).map((_: string, i: number) => String(i + 1)),
      })),
    },
    catalog: {
      listPage: vi.fn(async () => ({ items: [], nextToken: undefined })),
      listAll: vi.fn(async () => []),
      listUndated: vi.fn(async () => []),
      getObject: vi.fn(async () => ({
        stream: Readable.from([Buffer.from('mock')]),
        contentType: 'image/jpeg',
        etag: '"etag-1"',
        lastModified: '2026-01-01T00:00:00.000Z',
        contentLength: 4,
      })),
      getObjectBuffer: vi.fn(async () => ({
        buffer: Buffer.from('mock'),
        contentType: 'image/jpeg',
        contentLength: 4,
      })),
      getStats: vi.fn(async () => ({
        totalFiles: 0,
        totalBytes: 0,
        imageCount: 0,
        videoCount: 0,
        oldestDate: null,
        newestDate: null,
      })),
      getDateDistribution: vi.fn(async () => ({ dates: {} })),
      getThumbnail: vi.fn(async () => ({
        buffer: Buffer.from('thumb'),
        contentType: 'image/webp',
      })),
      findDuplicates: vi.fn(async () => []),
      deduplicateObjects: vi.fn(async () => ({ deleted: 0, kept: 0, groups: 0 })),
      deleteObjects: vi.fn(async (keys: string[]) => ({
        deleted: keys,
        failed: [],
      })),
      moveObject: vi.fn(async (ek: string, newDate: string) => ({
        from: `old/${ek}`,
        to: `${newDate}/${ek}`,
      })),
      getAlbums: vi.fn(async () => ({ albums: [] })),
      saveAlbums: vi.fn(async () => {}),
    },
    cloudUsage: {
      getSummary: vi.fn(async () => ({
        provider: 'scaleway' as const,
        bucket: 'test-bucket',
        region: 'nl-ams',
        prefix: '',
        totalObjects: 0,
        totalBytes: 0,
        measuredAt: new Date().toISOString(),
      })),
    },
  };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-e2e',
    sourceProvider: 'google-photos',
    destProvider: 'scaleway',
    sourceConfig: null,
    destConfig: null,
    keys: ['a.jpg', 'b.jpg', 'c.jpg'],
    status: TransferStatus.PENDING,
    progress: 0,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

// ── E2E workflow tests ──────────────────────────────────

describe('e2e: transfer lifecycle', () => {
  it('creates a transfer, monitors it, then cleans up', async () => {
    const services = createServices();

    // After creation, list should return the new job
    const createdJob = makeJob();
    services.jobs.list = vi.fn(async () => [createdJob]);
    services.jobs.get = vi.fn(async () => createdJob);

    const app = await createApiServer({ services });

    // Step 1: Create transfer
    const createRes = await app.inject({
      method: 'POST',
      url: '/transfers',
      payload: {
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        keys: ['a.jpg', 'b.jpg', 'c.jpg'],
      },
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().enqueueResult.enqueuedCount).toBe(3);

    // Step 2: List transfers — should include our job
    const listRes = await app.inject({ method: 'GET', url: '/transfers' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toHaveLength(1);

    // Step 3: Get transfer details
    const detailRes = await app.inject({ method: 'GET', url: '/transfers/job-e2e' });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().job.id).toBe('job-e2e');

    // Step 4: Fetch logs
    const logsRes = await app.inject({ method: 'GET', url: '/transfers/job-e2e/logs' });
    expect(logsRes.statusCode).toBe(200);
    expect(Array.isArray(logsRes.json().logs)).toBe(true);

    // Step 5: Delete transfer
    const deleteRes = await app.inject({ method: 'DELETE', url: '/transfers/job-e2e' });
    expect(deleteRes.statusCode).toBe(204);
    expect(services.jobs.delete).toHaveBeenCalledWith('job-e2e');

    await app.close();
  });

  it('creates a transfer, pauses it, then resumes from where it left off', async () => {
    const services = createServices();

    // Simulate in-progress job
    const inProgressJob = makeJob({
      status: TransferStatus.IN_PROGRESS,
      progress: 0.33,
      startedAt: new Date(),
    });
    services.jobs.get = vi.fn(async () => inProgressJob);

    const app = await createApiServer({ services });

    // Step 1: Create transfer
    const createRes = await app.inject({
      method: 'POST',
      url: '/transfers',
      payload: {
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        keys: ['a.jpg', 'b.jpg', 'c.jpg'],
      },
    });
    expect(createRes.statusCode).toBe(201);

    // Step 2: Pause the transfer
    const pauseRes = await app.inject({ method: 'POST', url: '/transfers/job-e2e/pause' });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json().message).toBe('Transfer paused');
    expect(services.jobs.update).toHaveBeenCalledWith('job-e2e', {
      status: TransferStatus.CANCELLED,
      errorMessage: 'Paused by user',
    });

    // Step 3: Simulate paused state with partial logs (a.jpg completed)
    const pausedJob = makeJob({
      status: TransferStatus.CANCELLED,
      errorMessage: 'Paused by user',
      progress: 0.33,
    });
    services.jobs.get = vi.fn(async () => pausedJob);
    services.jobs.listLogs = vi.fn(async () => [
      {
        id: 'log-1',
        jobId: 'job-e2e',
        level: 'INFO',
        message: 'Uploaded a.jpg',
        meta: { mediaItemId: 'a.jpg', status: 'COMPLETED' },
        createdAt: new Date(),
      },
    ]);

    // Step 4: Resume — should re-enqueue only b.jpg and c.jpg
    const resumeRes = await app.inject({ method: 'POST', url: '/transfers/job-e2e/resume' });
    expect(resumeRes.statusCode).toBe(200);
    expect(services.queue.enqueueBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        transferJobId: 'job-e2e',
        keys: ['b.jpg', 'c.jpg'],
        startIndex: 1,
        totalKeys: 3,
      }),
    );

    await app.close();
  });

  it('handles a failed transfer with retry-all recovering remaining items', async () => {
    const services = createServices();

    const failedJob = makeJob({
      keys: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'],
      status: TransferStatus.FAILED,
      progress: 0.6,
      errorMessage: 'Network timeout',
    });
    services.jobs.get = vi
      .fn()
      .mockResolvedValueOnce(failedJob)
      .mockResolvedValueOnce(failedJob);
    services.jobs.listLogs = vi.fn(async () => [
      { id: 'l1', jobId: 'job-e2e', level: 'INFO', message: 'ok', meta: { mediaItemId: 'a.jpg', status: 'COMPLETED' }, createdAt: new Date() },
      { id: 'l2', jobId: 'job-e2e', level: 'INFO', message: 'ok', meta: { mediaItemId: 'b.jpg', status: 'COMPLETED' }, createdAt: new Date() },
      { id: 'l3', jobId: 'job-e2e', level: 'INFO', message: 'ok', meta: { mediaItemId: 'c.jpg', status: 'COMPLETED' }, createdAt: new Date() },
    ]);

    const app = await createApiServer({ services });

    // Retry all — should enqueue d.jpg and e.jpg
    const retryRes = await app.inject({ method: 'POST', url: '/transfers/job-e2e/retry-all-items' });
    expect(retryRes.statusCode).toBe(200);
    expect(services.queue.enqueueBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: ['d.jpg', 'e.jpg'],
      }),
    );

    await app.close();
  });
});

describe('e2e: credential → provider → transfer flow', () => {
  it('stores credentials, tests connection, lists objects, then starts transfer', async () => {
    const services = createServices();

    // Provider tests succeed, and listing returns existing objects
    services.providers.listObjects = vi.fn(async () => [
      { key: '2026/01/01/existing.jpg', size: 5000, lastModified: new Date(), contentType: 'image/jpeg' },
    ]);

    const app = await createApiServer({ services });

    // Step 1: Store new cloud credential
    const credRes = await app.inject({
      method: 'POST',
      url: '/credentials',
      payload: { name: 'scaleway-main', provider: 'scaleway', config: '{"accessKey":"ak","secretKey":"sk","region":"nl-ams","bucket":"photos"}' },
    });
    expect(credRes.statusCode).toBe(201);
    expect(credRes.json()).not.toHaveProperty('config'); // config hidden in response

    // Step 2: Test the connection
    const testRes = await app.inject({
      method: 'POST',
      url: '/providers/scaleway/test',
      payload: { config: { accessKey: 'ak', secretKey: 'sk', region: 'nl-ams', bucket: 'photos' } },
    });
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().ok).toBe(true);

    // Step 3: List existing objects to see what's already uploaded
    const listRes = await app.inject({
      method: 'POST',
      url: '/providers/scaleway/list',
      payload: { config: { accessKey: 'ak', secretKey: 'sk', region: 'nl-ams', bucket: 'photos' }, prefix: '2026/', maxResults: 100 },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items).toHaveLength(1);

    // Step 4: Start a transfer for new items
    const transferRes = await app.inject({
      method: 'POST',
      url: '/transfers',
      payload: { sourceProvider: 'google-photos', destProvider: 'scaleway', keys: ['new-photo.jpg'] },
    });
    expect(transferRes.statusCode).toBe(201);
    expect(transferRes.json().enqueueResult.enqueuedCount).toBe(1);

    await app.close();
  });
});

describe('e2e: catalog browsing and management', () => {
  it('browses catalog, inspects items, reorganizes by date, then checks stats', async () => {
    const services = createServices();

    const items = [
      { key: '2026/02/20/photo1.jpg', encodedKey: 'cGhvdG8x', size: 2048, lastModified: '2026-02-20T10:00:00.000Z', capturedAt: '2026-02-20T09:00:00.000Z', mediaType: 'image', sectionDate: '2026-02-20' },
      { key: 'unknown-date/photo2.jpg', encodedKey: 'cGhvdG8y', size: 4096, lastModified: '2026-03-01T12:00:00.000Z', capturedAt: null, mediaType: 'image', sectionDate: 'unknown-date' },
    ];

    services.catalog!.listPage = vi.fn(async () => ({ items, nextToken: undefined }));
    services.catalog!.listUndated = vi.fn(async () => [items[1]]);
    services.catalog!.getStats = vi.fn(async () => ({
      totalFiles: 2,
      totalBytes: 6144,
      imageCount: 2,
      videoCount: 0,
      oldestDate: '2026-02-20T09:00:00.000Z',
      newestDate: '2026-03-01T12:00:00.000Z',
    }));
    services.catalog!.moveObject = vi.fn(async (_ek: string, newDate: string) => ({
      from: 'unknown-date/photo2.jpg',
      to: `${newDate}/photo2.jpg`,
    }));

    const app = await createApiServer({ services });

    // Step 1: Browse the catalog page
    const pageRes = await app.inject({ method: 'GET', url: '/catalog' });
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.headers['content-type']).toContain('text/html');

    // Step 2: Fetch paginated items
    const itemsRes = await app.inject({ method: 'GET', url: '/catalog/api/items?max=50' });
    expect(itemsRes.statusCode).toBe(200);
    expect(itemsRes.json().items).toHaveLength(2);

    // Step 3: Check undated items
    const undatedRes = await app.inject({ method: 'GET', url: '/catalog/api/undated' });
    expect(undatedRes.statusCode).toBe(200);
    expect(undatedRes.json().items).toHaveLength(1);
    expect(undatedRes.json().items[0].encodedKey).toBe('cGhvdG8y');

    // Step 4: Move the undated item to the correct date
    const moveRes = await app.inject({
      method: 'PATCH',
      url: '/catalog/api/items/move',
      payload: { encodedKey: 'cGhvdG8y', newDatePrefix: '2025/12/25' },
    });
    expect(moveRes.statusCode).toBe(200);
    expect(moveRes.json().to).toBe('2025/12/25/photo2.jpg');

    // Step 5: Check stats
    const statsRes = await app.inject({ method: 'GET', url: '/catalog/api/stats' });
    expect(statsRes.statusCode).toBe(200);
    expect(statsRes.json().totalFiles).toBe(2);
    expect(statsRes.json().imageCount).toBe(2);

    await app.close();
  });

  it('creates album, adds items, renames it, then deletes it', async () => {
    const services = createServices();

    let albums: Array<{ id: string; name: string; keys: string[]; createdAt: string; updatedAt: string }> = [];

    services.catalog!.getAlbums = vi.fn(async () => ({ albums }));
    services.catalog!.saveAlbums = vi.fn(async (manifest) => {
      albums = (manifest as { albums: typeof albums }).albums;
    });

    const app = await createApiServer({ services });

    // Step 1: Create album
    const createRes = await app.inject({
      method: 'POST',
      url: '/catalog/api/albums',
      payload: { name: 'Vacation 2026' },
    });
    expect(createRes.statusCode).toBe(200);
    const albumId = createRes.json().id;
    expect(albumId).toBeDefined();
    expect(createRes.json().name).toBe('Vacation 2026');

    // Step 2: Update — add items and rename
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/catalog/api/albums/${albumId}`,
      payload: { name: 'Summer Vacation 2026', addKeys: ['photo1.jpg', 'photo2.jpg'] },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().name).toBe('Summer Vacation 2026');
    expect(updateRes.json().keys).toContain('photo1.jpg');

    // Step 3: List albums — should have our album
    const listRes = await app.inject({ method: 'GET', url: '/catalog/api/albums' });
    expect(listRes.statusCode).toBe(200);

    // Step 4: Delete album
    const deleteRes = await app.inject({ method: 'DELETE', url: `/catalog/api/albums/${albumId}` });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().deleted).toBe(albumId);

    await app.close();
  });

  it('streams media, checks ETag caching, and handles missing objects', async () => {
    const services = createServices();

    // First call returns image, second call simulates not-found
    services.catalog!.getObject = vi
      .fn()
      .mockResolvedValueOnce({
        stream: Readable.from([Buffer.from('jpeg-bytes')]),
        contentType: 'image/jpeg',
        etag: '"e2e-etag"',
        lastModified: '2026-02-20T10:00:00.000Z',
        contentLength: 10,
      })
      .mockResolvedValueOnce({
        stream: Readable.from([Buffer.from('jpeg-bytes')]),
        contentType: 'image/jpeg',
        etag: '"e2e-etag"',
        lastModified: '2026-02-20T10:00:00.000Z',
        contentLength: 10,
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }),
      );

    const app = await createApiServer({ services });
    const encodedKey = 'MjAyNi8wMi8yMC9waG90by5qcGc';

    // Step 1: First fetch — full response
    const firstRes = await app.inject({ method: 'GET', url: `/catalog/media/${encodedKey}` });
    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.headers['etag']).toBe('"e2e-etag"');
    expect(firstRes.headers['cache-control']).toContain('max-age=86400');

    // Step 2: Conditional request with matching ETag — expect 304
    const cachedRes = await app.inject({
      method: 'GET',
      url: `/catalog/media/${encodedKey}`,
      headers: { 'if-none-match': '"e2e-etag"' },
    });
    expect(cachedRes.statusCode).toBe(304);
    expect(cachedRes.body).toBe('');

    // Step 3: Request a missing object — expect 404
    const missingRes = await app.inject({ method: 'GET', url: `/catalog/media/${encodedKey}` });
    expect(missingRes.statusCode).toBe(404);
    expect(missingRes.json().error.code).toBe('CATALOG_MEDIA_NOT_FOUND');

    await app.close();
  });
});

describe('e2e: duplicate check → selective transfer', () => {
  it('checks for duplicates then only transfers new items', async () => {
    const services = createServices();

    const mockDestProvider = {
      name: 'scaleway',
      list: vi.fn(async (opts?: { prefix?: string }) => {
        const prefix = opts?.prefix ?? '';
        // Simulate: "existing-photo" already in S3
        if (prefix.includes('existing-photo')) {
          return [{ key: prefix, size: 5000, lastModified: new Date(), contentType: 'image/jpeg' }];
        }
        return [];
      }),
      download: vi.fn(),
      upload: vi.fn(),
      delete: vi.fn(),
    };

    const app = await createApiServer({ services, transferDestProvider: mockDestProvider });

    // Step 1: Check which items already exist
    const dupRes = await app.inject({
      method: 'POST',
      url: '/transfers/check-duplicates',
      payload: {
        items: [
          { id: 'existing-photo', filename: 'already-there.jpg', createTime: '2026-01-15T10:00:00Z' },
          { id: 'new-photo-1', filename: 'vacation.jpg', createTime: '2026-03-20T14:00:00Z' },
          { id: 'new-photo-2', filename: 'sunset.jpg', createTime: '2026-03-20T18:00:00Z' },
        ],
      },
    });
    expect(dupRes.statusCode).toBe(200);
    const dupBody = dupRes.json();
    expect(dupBody.totalChecked).toBe(3);
    expect(dupBody.duplicateCount).toBe(1);

    // Find which items are new
    const newItems = dupBody.items
      .filter((i: { exists: boolean }) => !i.exists)
      .map((i: { id: string }) => i.id);
    expect(newItems).toEqual(['new-photo-1', 'new-photo-2']);

    // Step 2: Transfer only the new items
    const transferRes = await app.inject({
      method: 'POST',
      url: '/transfers',
      payload: { sourceProvider: 'google-photos', destProvider: 'scaleway', keys: newItems },
    });
    expect(transferRes.statusCode).toBe(201);
    expect(transferRes.json().enqueueResult.enqueuedCount).toBe(2);

    await app.close();
  });
});

describe('e2e: cloud usage and cost estimation', () => {
  it('checks storage usage then estimates cost with different scenarios', async () => {
    const services = createServices();
    services.cloudUsage!.getSummary = vi.fn(async () => ({
      provider: 'scaleway' as const,
      bucket: 'photos',
      region: 'nl-ams',
      prefix: '',
      totalObjects: 5000,
      totalBytes: 100 * 1024 * 1024 * 1024, // 100 GB
      measuredAt: new Date().toISOString(),
    }));

    const app = await createApiServer({ services });

    // Step 1: Base usage (default pricing)
    const baseRes = await app.inject({ method: 'GET', url: '/usage/cloud?bucketType=standard' });
    expect(baseRes.statusCode).toBe(200);
    const base = baseRes.json();
    expect(base.totalObjects).toBe(5000);
    expect(base.totalGB).toBe(100);
    expect(base.estimatedMonthlyCost).toBeGreaterThan(0);

    // Step 2: Pessimistic estimate (high traffic + VAT)
    const pessRes = await app.inject({
      method: 'GET',
      url: '/usage/cloud?bucketType=standard&putRequests=50000&getRequests=200000&egressGB=20&vatRate=0.21',
    });
    expect(pessRes.statusCode).toBe(200);
    const pess = pessRes.json();
    expect(pess.estimatedMonthlyCost).toBeGreaterThan(base.estimatedMonthlyCost);
    expect(pess.breakdown.vatAmount).toBeGreaterThan(0);

    await app.close();
  });
});

describe('e2e: health and auth enforcement', () => {
  it('health is accessible without auth, protected routes require token', async () => {
    const services = createServices();
    const token = 'e2e-secure-token-1234567890';

    const app = await createApiServer({
      services,
      apiAuthToken: token,
      corsAllowedOrigins: ['http://localhost:3000'],
    });

    // Health is unauthenticated
    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().ok).toBe(true);

    // Protected routes without token → 401
    const noAuthRoutes = [
      { method: 'GET' as const, url: '/providers' },
      { method: 'GET' as const, url: '/transfers' },
      { method: 'GET' as const, url: '/credentials' },
      { method: 'GET' as const, url: '/catalog/api/items' },
      { method: 'GET' as const, url: '/usage/cloud?bucketType=standard' },
    ];

    for (const route of noAuthRoutes) {
      const res = await app.inject(route);
      expect(res.statusCode).toBe(401);
    }

    // Same routes with valid token → success
    for (const route of noAuthRoutes) {
      const res = await app.inject({
        ...route,
        headers: { 'x-api-key': token },
      });
      expect(res.statusCode).toBe(200);
    }

    // Wrong token → still 401
    const wrongRes = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { 'x-api-key': 'wrong-token-not-valid' },
    });
    expect(wrongRes.statusCode).toBe(401);

    await app.close();
  });
});

describe('e2e: catalog bulk operations', () => {
  it('deletes multiple items then verifies catalog is empty', async () => {
    const services = createServices();

    const allItems = [
      { key: '2026/01/01/a.jpg', encodedKey: 'YS5qcGc', size: 100, lastModified: '2026-01-01T00:00:00Z', capturedAt: null, mediaType: 'image', sectionDate: '2026-01-01' },
      { key: '2026/01/01/b.jpg', encodedKey: 'Yi5qcGc', size: 200, lastModified: '2026-01-01T00:00:00Z', capturedAt: null, mediaType: 'image', sectionDate: '2026-01-01' },
      { key: '2026/01/01/c.jpg', encodedKey: 'Yy5qcGc', size: 300, lastModified: '2026-01-01T00:00:00Z', capturedAt: null, mediaType: 'image', sectionDate: '2026-01-01' },
    ];
    let remaining = [...allItems];

    services.catalog!.listPage = vi.fn(async () => ({ items: remaining, nextToken: undefined }));
    services.catalog!.deleteObjects = vi.fn(async (keys: string[]) => {
      remaining = remaining.filter((i) => !keys.includes(i.encodedKey));
      return { deleted: keys, failed: [] };
    });
    services.catalog!.getStats = vi.fn(async () => ({
      totalFiles: remaining.length,
      totalBytes: remaining.reduce((s, i) => s + i.size, 0),
      imageCount: remaining.length,
      videoCount: 0,
      oldestDate: null,
      newestDate: null,
    }));

    const app = await createApiServer({ services });

    // Step 1: List items — 3 items
    const listRes = await app.inject({ method: 'GET', url: '/catalog/api/items' });
    expect(listRes.json().items).toHaveLength(3);

    // Step 2: Delete first two
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/catalog/api/items',
      payload: { encodedKeys: ['YS5qcGc', 'Yi5qcGc'] },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().deleted).toHaveLength(2);

    // Step 3: Stats should reflect deletion
    const statsRes = await app.inject({ method: 'GET', url: '/catalog/api/stats' });
    expect(statsRes.statusCode).toBe(200);
    expect(statsRes.json().totalFiles).toBe(1);

    await app.close();
  });

  it('bulk moves multiple items to a new date', async () => {
    const services = createServices();

    services.catalog!.moveObject = vi.fn(async (ek: string, newDate: string) => ({
      from: `unknown-date/${ek}`,
      to: `${newDate}/${ek}`,
    }));

    const app = await createApiServer({ services });

    const moveRes = await app.inject({
      method: 'PATCH',
      url: '/catalog/api/items/bulk-move',
      payload: {
        moves: [
          { encodedKey: 'aXRlbTE', newDatePrefix: '2025/06/15' },
          { encodedKey: 'aXRlbTI', newDatePrefix: '2025/06/15' },
          { encodedKey: 'aXRlbTM', newDatePrefix: '2025/07/04' },
        ],
      },
    });

    expect(moveRes.statusCode).toBe(200);
    const body = moveRes.json();
    expect(body.moved).toHaveLength(3);
    expect(body.failed).toHaveLength(0);
    expect(services.catalog!.moveObject).toHaveBeenCalledTimes(3);

    await app.close();
  });
});
