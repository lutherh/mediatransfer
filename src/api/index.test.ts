import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { TransferStatus } from '../generated/prisma/index.js';
import { createApiServer } from './index.js';
import type { ApiServices } from './types.js';
import { clearEnvCache } from '../config/env.js';

beforeEach(() => {
  process.env.ENCRYPTION_SECRET = 'unit-test-encryption-secret-123';
  clearEnvCache();
});

function createServices(): ApiServices {
  return {
    credentials: {
      create: vi.fn(async (input) => ({
        id: 'cred-1',
        name: input.name,
        provider: input.provider,
        config: input.config,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      })),
      list: vi.fn(async () => [
        {
          id: 'cred-1',
          name: 'main',
          provider: 'scaleway',
          config: '{"ok":true}',
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
          updatedAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      ]),
      delete: vi.fn(async () => ({
        id: 'cred-1',
        name: 'main',
        provider: 'scaleway',
        config: '{"ok":true}',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      })),
    },
    jobs: {
      create: vi.fn(async (input) => ({
        id: 'job-1',
        sourceProvider: input.sourceProvider,
        destProvider: input.destProvider,
        sourceConfig: input.sourceConfig ?? null,
        destConfig: input.destConfig ?? null,
        keys: input.keys ?? [],
        status: TransferStatus.PENDING,
        progress: 0,
        errorMessage: null,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
        startedAt: null,
        completedAt: null,
      })),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      update: vi.fn(async () => ({
        id: 'job-1',
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        sourceConfig: null,
        destConfig: null,
        keys: [],
        status: TransferStatus.CANCELLED,
        progress: 0,
        errorMessage: null,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
        startedAt: null,
        completedAt: null,
      })),
      delete: vi.fn(async () => ({
        id: 'job-1',
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        sourceConfig: null,
        destConfig: null,
        keys: [],
        status: TransferStatus.CANCELLED,
        progress: 0,
        errorMessage: null,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
        startedAt: null,
        completedAt: null,
      })),
      listLogs: vi.fn(async () => [
        {
          id: 'log-1',
          jobId: 'job-1',
          level: 'INFO',
          message: 'Transfer job started',
          meta: { totalItems: 2 },
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      ]),
    },
    providers: {
      listNames: vi.fn(() => ['scaleway']),
      testConnection: vi.fn(async () => ({ ok: true, message: 'Connection successful' })),
      listObjects: vi.fn(async () => [
        {
          key: '2025/01/01/a.jpg',
          size: 123,
          lastModified: new Date('2025-01-01T00:00:00.000Z'),
          contentType: 'image/jpeg',
        },
      ]),
    },
    queue: {
      enqueueBulk: vi.fn(async () => ({ enqueuedCount: 2, queueJobIds: ['1', '2'] })),
    },
    catalog: {
      listPage: vi.fn(async () => ({
        items: [
          {
            key: '2026/02/20/photo.jpg',
            encodedKey: 'MjAyNi8wMi8yMC9waG90by5qcGc',
            size: 123,
            lastModified: '2026-02-20T10:00:00.000Z',
            capturedAt: '2026-02-20T09:32:10.000Z',
            mediaType: 'image',
            sectionDate: '2026-02-20',
          },
        ],
        nextToken: 'next-token',
      })),
      listAll: vi.fn(async () => [
        {
          key: '2026/02/20/photo.jpg',
          encodedKey: 'MjAyNi8wMi8yMC9waG90by5qcGc',
          size: 123,
          lastModified: '2026-02-20T10:00:00.000Z',
          capturedAt: '2026-02-20T09:32:10.000Z',
          mediaType: 'image',
          sectionDate: '2026-02-20',
        },
      ]),
      getObject: vi.fn(async () => ({
        stream: Readable.from([Buffer.from('mock-image')]),
        contentType: 'image/jpeg',
        etag: '"mock-etag-1"',
        lastModified: '2026-02-20T10:00:00.000Z',
        contentLength: 10,
      })),
      getStats: vi.fn(async () => ({
        totalFiles: 100,
        totalBytes: 1024000,
        imageCount: 80,
        videoCount: 20,
        oldestDate: '2019-01-01T00:00:00.000Z',
        newestDate: '2024-12-31T00:00:00.000Z',
      })),
      deleteObjects: vi.fn(async (keys: string[]) => ({
        deleted: keys.map(() => '2026/02/20/photo.jpg'),
        failed: [],
      })),
      moveObject: vi.fn(async (ek: string, newDate: string) => ({
        from: '2026/02/20/photo.jpg',
        to: newDate + '/photo.jpg',
      })),
      getAlbums: vi.fn(async () => ({
        albums: [
          { id: 'album-1', name: 'Vacation', keys: ['2026/02/20/photo.jpg'], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
        ],
      })),
      saveAlbums: vi.fn(async () => {}),
    },
    cloudUsage: {
      getSummary: vi.fn(async () => ({
        provider: 'scaleway' as const,
        bucket: 'photos-bucket',
        region: 'nl-ams',
        prefix: 'photos',
        totalObjects: 25,
        totalBytes: 25 * 1024 * 1024 * 1024,
        measuredAt: new Date('2026-02-23T00:00:00.000Z').toISOString(),
      })),
    },
  };
}

describe('api server', () => {
  it('requires API auth token for protected routes when configured', async () => {
    const app = await createApiServer({
      services: createServices(),
      apiAuthToken: 'test-token-1234567890',
      corsAllowedOrigins: ['http://localhost:3000'],
    });

    const unauthorized = await app.inject({ method: 'GET', url: '/providers' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.code).toBe('UNAUTHORIZED');

    const authorized = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { 'x-api-key': 'test-token-1234567890' },
    });
    expect(authorized.statusCode).toBe(200);

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    await app.close();
  });

  it('exposes health endpoint', async () => {
    const app = await createApiServer({ services: createServices() });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });

  it('creates credential and hides config in response', async () => {
    const app = await createApiServer({ services: createServices() });
    const res = await app.inject({
      method: 'POST',
      url: '/credentials',
      payload: {
        name: 'main',
        provider: 'scaleway',
        config: '{"secret":true}',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('config');

    await app.close();
  });

  it('creates transfer job and enqueues work', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      payload: {
        sourceProvider: 'google-photos',
        destProvider: 'scaleway',
        keys: ['a.jpg', 'b.jpg'],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().enqueueResult.enqueuedCount).toBe(2);
    expect(services.queue.enqueueBulk).toHaveBeenCalledOnce();

    await app.close();
  });

  it('pauses an in-progress transfer job', async () => {
    const services = createServices();
    services.jobs.get = vi.fn(async () => ({
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      sourceConfig: { sessionId: 'picker-1' },
      destConfig: null,
      keys: ['a.jpg', 'b.jpg'],
      status: TransferStatus.IN_PROGRESS,
      progress: 0.5,
      errorMessage: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      startedAt: new Date('2025-01-01T00:00:00.000Z'),
      completedAt: null,
    }));

    const app = await createApiServer({ services });
    const res = await app.inject({ method: 'POST', url: '/transfers/job-1/pause' });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe('Transfer paused');
    expect(services.jobs.update).toHaveBeenCalledWith('job-1', {
      status: TransferStatus.CANCELLED,
      errorMessage: 'Paused by user',
    });

    await app.close();
  });

  it('resumes a paused transfer job from remaining keys', async () => {
    const services = createServices();
    const pausedJob = {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      sourceConfig: { sessionId: 'picker-1' },
      destConfig: null,
      keys: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      status: TransferStatus.CANCELLED,
      progress: 0.5,
      errorMessage: 'Paused by user',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      startedAt: new Date('2025-01-01T00:00:00.000Z'),
      completedAt: null,
    };

    services.jobs.get = vi.fn(async () => pausedJob);
    services.jobs.listLogs = vi.fn(async () => [
      {
        id: 'log-a',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded a.jpg',
        meta: { mediaItemId: 'a.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:01:00.000Z'),
      },
      {
        id: 'log-b',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded b.jpg',
        meta: { mediaItemId: 'b.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:02:00.000Z'),
      },
    ]);

    const app = await createApiServer({ services });
    const res = await app.inject({ method: 'POST', url: '/transfers/job-1/resume' });

    expect(res.statusCode).toBe(200);
    expect(services.queue.enqueueBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        transferJobId: 'job-1',
        keys: ['c.jpg', 'd.jpg'],
        startIndex: 2,
        totalKeys: 4,
      }),
    );

    await app.close();
  });

  it('resumes a failed transfer job from remaining keys', async () => {
    const services = createServices();
    const failedJob = {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      sourceConfig: { sessionId: 'picker-1' },
      destConfig: null,
      keys: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      status: TransferStatus.FAILED,
      progress: 0.5,
      errorMessage: 'Transfer failed: fetch failed',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      startedAt: new Date('2025-01-01T00:00:00.000Z'),
      completedAt: null,
    };

    services.jobs.get = vi.fn(async () => failedJob);
    services.jobs.listLogs = vi.fn(async () => [
      {
        id: 'log-a',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded a.jpg',
        meta: { mediaItemId: 'a.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:01:00.000Z'),
      },
      {
        id: 'log-b',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded b.jpg',
        meta: { mediaItemId: 'b.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:02:00.000Z'),
      },
    ]);

    const app = await createApiServer({ services });
    const res = await app.inject({ method: 'POST', url: '/transfers/job-1/resume' });

    expect(res.statusCode).toBe(200);
    expect(services.queue.enqueueBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        transferJobId: 'job-1',
        keys: ['c.jpg', 'd.jpg'],
        startIndex: 2,
        totalKeys: 4,
      }),
    );

    await app.close();
  });

  it('retries a failed transfer item', async () => {
    const services = createServices();
    const failedJob = {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      sourceConfig: { sessionId: 'picker-1' },
      destConfig: null,
      keys: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      status: TransferStatus.FAILED,
      progress: 0.5,
      errorMessage: 'Transfer failed: fetch failed',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      startedAt: new Date('2025-01-01T00:00:00.000Z'),
      completedAt: null,
    };

    services.jobs.get = vi
      .fn()
      .mockResolvedValueOnce(failedJob)
      .mockResolvedValueOnce(failedJob);
    services.jobs.listLogs = vi.fn(async () => [
      {
        id: 'log-a',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded a.jpg',
        meta: { mediaItemId: 'a.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:01:00.000Z'),
      },
      {
        id: 'log-b',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded b.jpg',
        meta: { mediaItemId: 'b.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:02:00.000Z'),
      },
    ]);

    const app = await createApiServer({ services });
    const res = await app.inject({
      method: 'POST',
      url: '/transfers/job-1/retry-item',
      payload: { mediaItemId: 'c.jpg' },
    });

    expect(res.statusCode).toBe(200);
    expect(services.queue.enqueueBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        transferJobId: 'job-1',
        keys: ['c.jpg'],
        startIndex: 2,
        totalKeys: 4,
      }),
    );

    await app.close();
  });

  it('retries an item while transfer is in progress', async () => {
    const services = createServices();
    const inProgressJob = {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      sourceConfig: { sessionId: 'picker-1' },
      destConfig: null,
      keys: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      status: TransferStatus.IN_PROGRESS,
      progress: 0.92,
      errorMessage: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      startedAt: new Date('2025-01-01T00:00:00.000Z'),
      completedAt: null,
    };

    services.jobs.get = vi
      .fn()
      .mockResolvedValueOnce(inProgressJob)
      .mockResolvedValueOnce(inProgressJob);
    services.jobs.listLogs = vi.fn(async () => [
      {
        id: 'log-a',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded a.jpg',
        meta: { mediaItemId: 'a.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:01:00.000Z'),
      },
      {
        id: 'log-b',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded b.jpg',
        meta: { mediaItemId: 'b.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:02:00.000Z'),
      },
    ]);

    const app = await createApiServer({ services });
    const res = await app.inject({
      method: 'POST',
      url: '/transfers/job-1/retry-item',
      payload: { mediaItemId: 'c.jpg' },
    });

    expect(res.statusCode).toBe(200);
    expect(services.jobs.update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: TransferStatus.PENDING }));
    expect(services.queue.enqueueBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        transferJobId: 'job-1',
        keys: ['c.jpg'],
        startIndex: 2,
        totalKeys: 4,
      }),
    );

    await app.close();
  });

  it('queues all incomplete items in a failed transfer', async () => {
    const services = createServices();
    const failedJob = {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      sourceConfig: { sessionId: 'picker-1' },
      destConfig: null,
      keys: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      status: TransferStatus.FAILED,
      progress: 0.5,
      errorMessage: 'Transfer failed: fetch failed',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      startedAt: new Date('2025-01-01T00:00:00.000Z'),
      completedAt: null,
    };

    services.jobs.get = vi
      .fn()
      .mockResolvedValueOnce(failedJob)
      .mockResolvedValueOnce(failedJob);
    services.jobs.listLogs = vi.fn(async () => [
      {
        id: 'log-a',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded a.jpg',
        meta: { mediaItemId: 'a.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:01:00.000Z'),
      },
      {
        id: 'log-b',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded b.jpg',
        meta: { mediaItemId: 'b.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:02:00.000Z'),
      },
      {
        id: 'log-c',
        jobId: 'job-1',
        level: 'WARN',
        message: 'Retrying item c.jpg (attempt 2/3)',
        meta: { mediaItemId: 'c.jpg', status: 'RETRYING' },
        createdAt: new Date('2025-01-01T00:03:00.000Z'),
      },
    ]);

    const app = await createApiServer({ services });
    const res = await app.inject({
      method: 'POST',
      url: '/transfers/job-1/retry-all-items',
    });

    expect(res.statusCode).toBe(200);
    expect(services.queue.enqueueBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        transferJobId: 'job-1',
        keys: ['d.jpg'],
        startIndex: 2,
        totalKeys: 4,
      }),
    );

    await app.close();
  });

  it('queues all incomplete items while transfer is in progress', async () => {
    const services = createServices();
    const inProgressJob = {
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      sourceConfig: { sessionId: 'picker-1' },
      destConfig: null,
      keys: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      status: TransferStatus.IN_PROGRESS,
      progress: 0.92,
      errorMessage: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      startedAt: new Date('2025-01-01T00:00:00.000Z'),
      completedAt: null,
    };

    services.jobs.get = vi
      .fn()
      .mockResolvedValueOnce(inProgressJob)
      .mockResolvedValueOnce(inProgressJob);
    services.jobs.listLogs = vi.fn(async () => [
      {
        id: 'log-a',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded a.jpg',
        meta: { mediaItemId: 'a.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:01:00.000Z'),
      },
      {
        id: 'log-b',
        jobId: 'job-1',
        level: 'INFO',
        message: 'Uploaded b.jpg',
        meta: { mediaItemId: 'b.jpg', status: 'COMPLETED' },
        createdAt: new Date('2025-01-01T00:02:00.000Z'),
      },
    ]);

    const app = await createApiServer({ services });
    const res = await app.inject({
      method: 'POST',
      url: '/transfers/job-1/retry-all-items',
    });

    expect(res.statusCode).toBe(200);
    expect(services.jobs.update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: TransferStatus.PENDING }));
    expect(services.queue.enqueueBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        transferJobId: 'job-1',
        keys: ['c.jpg', 'd.jpg'],
        startIndex: 2,
        totalKeys: 4,
      }),
    );

    await app.close();
  });
  it('returns provider list and object listing', async () => {
    const app = await createApiServer({ services: createServices() });

    const listRes = await app.inject({ method: 'GET', url: '/providers' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual({ providers: ['scaleway'] });

    const objectsRes = await app.inject({
      method: 'POST',
      url: '/providers/scaleway/list',
      payload: {
        config: { region: 'nl-ams', bucket: 'b', accessKey: 'a', secretKey: 's' },
        prefix: '2025/01/01',
        maxResults: 10,
      },
    });

    expect(objectsRes.statusCode).toBe(200);
    expect(objectsRes.json().items).toHaveLength(1);

    await app.close();
  });

  it('returns cloud usage totals and monthly estimate (with default VAT)', async () => {
    const app = await createApiServer({ services: createServices() });

    const res = await app.inject({ method: 'GET', url: '/usage/cloud?bucketType=standard' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.provider).toBe('scaleway');
    expect(body.totalObjects).toBe(25);
    expect(body.totalGB).toBe(25);
    expect(body.pricing.currency).toBe('USD');
    expect(body.pricing.pricePerGBMonthly).toBe(0.023);
    expect(body.estimatedMonthlyCost).toBe(0.72);

    await app.close();
  });

  it('applies advanced cloud usage assumptions and returns detailed breakdown', async () => {
    const app = await createApiServer({ services: createServices() });

    const res = await app.inject({
      method: 'GET',
      url: '/usage/cloud?bucketType=standard&putRequests=10000&getRequests=50000&listRequests=2000&lifecycleTransitionGB=3&retrievalGB=10&egressGB=5&vatRate=0.25',
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.assumptions.putRequests).toBe(10000);
    expect(body.assumptions.getRequests).toBe(50000);
    expect(body.assumptions.listRequests).toBe(2000);
    expect(body.breakdown.storageCost).toBeCloseTo(0.575, 4);
    expect(body.breakdown.requestCost).toBeCloseTo(0.08, 4);
    expect(body.breakdown.lifecycleTransitionCost).toBeCloseTo(0.03, 4);
    expect(body.breakdown.retrievalCost).toBeCloseTo(0, 4);
    expect(body.breakdown.egressCost).toBeCloseTo(0.45, 4);
    expect(body.breakdown.subtotalExclVat).toBeCloseTo(1.135, 4);
    expect(body.breakdown.vatAmount).toBeCloseTo(0.2838, 4);
    expect(body.estimatedMonthlyCost).toBeCloseTo(1.42, 2);

    await app.close();
  });

  it('returns transfer logs endpoint payload', async () => {
    const services = createServices();
    services.jobs.get = vi.fn(async () => ({
      id: 'job-1',
      sourceProvider: 'google-photos',
      destProvider: 'scaleway',
      sourceConfig: null,
      destConfig: null,
      keys: [],
      status: TransferStatus.IN_PROGRESS,
      progress: 0.5,
      errorMessage: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      startedAt: new Date('2025-01-01T00:00:00.000Z'),
      completedAt: null,
    }));

    const app = await createApiServer({ services });
    const res = await app.inject({ method: 'GET', url: '/transfers/job-1/logs' });

    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toHaveLength(1);
    expect(services.jobs.listLogs).toHaveBeenCalledWith('job-1');

    await app.close();
  });

  it('serves catalog browser and paginated items', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const pageRes = await app.inject({ method: 'GET', url: '/catalog' });
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.headers['content-type']).toContain('text/html');

    const apiRes = await app.inject({ method: 'GET', url: '/catalog/api/items?max=30' });
    expect(apiRes.statusCode).toBe(200);
    expect(apiRes.json().items).toHaveLength(1);
    expect(services.catalog?.listPage).toHaveBeenCalled();

    await app.close();
  });

  it('streams media from catalog endpoint', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const mediaRes = await app.inject({
      method: 'GET',
      url: '/catalog/media/MjAyNi8wMi8yMC9waG90by5qcGc',
    });

    expect(mediaRes.statusCode).toBe(200);
    expect(mediaRes.headers['content-type']).toContain('image/jpeg');
    expect(mediaRes.headers['etag']).toBe('"mock-etag-1"');
    expect(mediaRes.headers['cache-control']).toContain('max-age=86400');
    expect(mediaRes.body.length).toBeGreaterThan(0);

    await app.close();
  });

  it('returns 304 for catalog media when ETag matches', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const mediaRes = await app.inject({
      method: 'GET',
      url: '/catalog/media/MjAyNi8wMi8yMC9waG90by5qcGc',
      headers: { 'if-none-match': '"mock-etag-1"' },
    });

    expect(mediaRes.statusCode).toBe(304);
    expect(mediaRes.body).toBe('');

    await app.close();
  });

  it('streams media for long encoded keys', async () => {
    const services = createServices();
    const app = await createApiServer({ services });
    const longEncodedKey = 'cGhvdG9zL2J5LWhhc2gvMDAvMjQvMDAyNDNiNmUzZThlMjhhNzhlMTFjZTdhOGY3OGEwMjUzZWFkYjFmNzA3OTRmN2IzZTMzODE2NGNhOWM3MDBhZi5IRUlD';

    const mediaRes = await app.inject({
      method: 'GET',
      url: `/catalog/media/${longEncodedKey}`,
    });

    expect(mediaRes.statusCode).toBe(200);
    expect(services.catalog?.getObject).toHaveBeenCalledWith(longEncodedKey, undefined);

    await app.close();
  });

  it('returns 404 when catalog media object does not exist', async () => {
    const services = createServices();
    services.catalog!.getObject = vi.fn(async () => {
      const err = Object.assign(new Error('NoSuchKey'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
      throw err;
    });

    const app = await createApiServer({ services });
    const mediaRes = await app.inject({
      method: 'GET',
      url: '/catalog/media/MjAyNi8wMi8yMC9taXNzaW5nLmpwZw',
    });

    expect(mediaRes.statusCode).toBe(404);
    expect(mediaRes.json().error.code).toBe('CATALOG_MEDIA_NOT_FOUND');

    await app.close();
  });

  it('returns 206 partial content for Range requests on catalog media', async () => {
    const services = createServices();
    services.catalog!.getObject = vi.fn(async (_key: string, range?: string) => ({
      stream: Readable.from([Buffer.from('partial')]),
      contentType: 'video/mp4',
      etag: '"mock-etag-video"',
      lastModified: '2026-02-20T10:00:00.000Z',
      contentLength: 7,
      contentRange: range ? 'bytes 0-6/1000000' : undefined,
    }));

    const app = await createApiServer({ services });

    const mediaRes = await app.inject({
      method: 'GET',
      url: '/catalog/media/MjAyNi8wMi8yMC92aWRlby5tcDQ',
      headers: { range: 'bytes=0-6' },
    });

    expect(mediaRes.statusCode).toBe(206);
    expect(mediaRes.headers['content-range']).toBe('bytes 0-6/1000000');
    expect(mediaRes.headers['accept-ranges']).toBe('bytes');
    expect(services.catalog?.getObject).toHaveBeenCalledWith(
      'MjAyNi8wMi8yMC92aWRlby5tcDQ',
      'bytes=0-6',
    );

    await app.close();
  });


  it('rejects malformed encoded media key', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const mediaRes = await app.inject({
      method: 'GET',
      url: '/catalog/media/not-valid+base64',
    });

    expect(mediaRes.statusCode).toBe(400);
    expect(mediaRes.json().error.code).toBe('VALIDATION_ERROR');
    expect(services.catalog?.getObject).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns structured validation errors', async () => {
    const app = await createApiServer({ services: createServices() });
    const res = await app.inject({
      method: 'POST',
      url: '/credentials',
      payload: {
        name: 'main',
        config: '{"secret":true}',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toBe('Request validation failed');
    expect(Array.isArray(res.json().error.details)).toBe(true);
    expect(res.json()).toHaveProperty('requestId');

    await app.close();
  });

  it('returns structured internal errors', async () => {
    const services = createServices();
    services.credentials.create = vi.fn(async () => {
      throw new Error('db unavailable');
    });

    const app = await createApiServer({ services });
    const res = await app.inject({
      method: 'POST',
      url: '/credentials',
      payload: {
        name: 'main',
        provider: 'scaleway',
        config: '{"secret":true}',
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    expect(res.json().error.message).toBe('Internal server error');
    expect(res.json()).toHaveProperty('requestId');

    await app.close();
  });

  it('deletes catalog items via DELETE /catalog/api/items', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'DELETE',
      url: '/catalog/api/items',
      payload: { encodedKeys: ['MjAyNi8wMi8yMC9waG90by5qcGc'] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deleted).toHaveLength(1);
    expect(body.failed).toHaveLength(0);
    expect(services.catalog?.deleteObjects).toHaveBeenCalledWith(['MjAyNi8wMi8yMC9waG90by5qcGc']);

    await app.close();
  });

  it('rejects delete with empty keys array', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'DELETE',
      url: '/catalog/api/items',
      payload: { encodedKeys: [] },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('moves catalog item via PATCH /catalog/api/items/move', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'PATCH',
      url: '/catalog/api/items/move',
      payload: { encodedKey: 'MjAyNi8wMi8yMC9waG90by5qcGc', newDatePrefix: '2020/03/15' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from).toBe('2026/02/20/photo.jpg');
    expect(body.to).toBe('2020/03/15/photo.jpg');

    await app.close();
  });

  it('rejects move with invalid date prefix', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'PATCH',
      url: '/catalog/api/items/move',
      payload: { encodedKey: 'MjAyNi8wMi8yMC9waG90by5qcGc', newDatePrefix: '2020-03-15' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('bulk moves catalog items via PATCH /catalog/api/items/bulk-move', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'PATCH',
      url: '/catalog/api/items/bulk-move',
      payload: {
        moves: [
          { encodedKey: 'MjAyNi8wMi8yMC9waG90by5qcGc', newDatePrefix: '2020/03/15' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.moved).toHaveLength(1);
    expect(body.failed).toHaveLength(0);

    await app.close();
  });

  it('lists all items via GET /catalog/api/items/all', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({ method: 'GET', url: '/catalog/api/items/all' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(services.catalog?.listAll).toHaveBeenCalled();

    await app.close();
  });

  it('returns catalog stats via GET /catalog/api/stats', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({ method: 'GET', url: '/catalog/api/stats' });

    expect(res.statusCode).toBe(200);
    const stats = res.json();
    expect(stats.totalFiles).toBe(100);
    expect(stats.imageCount).toBe(80);
    expect(stats.videoCount).toBe(20);

    await app.close();
  });

  it('lists albums via GET /catalog/api/albums', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({ method: 'GET', url: '/catalog/api/albums' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.albums).toHaveLength(1);
    expect(body.albums[0].name).toBe('Vacation');

    await app.close();
  });

  it('creates album via POST /catalog/api/albums', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'POST',
      url: '/catalog/api/albums',
      payload: { name: 'Summer 2024' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('Summer 2024');
    expect(body.id).toBeDefined();
    expect(services.catalog?.saveAlbums).toHaveBeenCalled();

    await app.close();
  });

  it('updates album via PATCH /catalog/api/albums/:albumId', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'PATCH',
      url: '/catalog/api/albums/album-1',
      payload: { name: 'Updated Name', addKeys: ['new-key.jpg'] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('Updated Name');
    expect(body.keys).toContain('new-key.jpg');

    await app.close();
  });

  it('returns 404 for non-existent album update', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'PATCH',
      url: '/catalog/api/albums/non-existent',
      payload: { name: 'Fail' },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('deletes album via DELETE /catalog/api/albums/:albumId', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'DELETE',
      url: '/catalog/api/albums/album-1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe('album-1');
    expect(services.catalog?.saveAlbums).toHaveBeenCalled();

    await app.close();
  });

  it('returns 404 when deleting non-existent album', async () => {
    const services = createServices();
    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'DELETE',
      url: '/catalog/api/albums/non-existent',
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('POST /transfers/check-duplicates returns exists for matching keys', async () => {
    const services = createServices();
    // Mock listObjects to return a matching key for a specific prefix
    services.providers.listObjects = vi.fn(async (_name, _config, opts) => {
      const prefix = opts?.prefix ?? '';
      if (prefix.includes('item-existing')) {
        return [{ key: prefix, size: 1024, lastModified: new Date(), contentType: 'image/jpeg' }];
      }
      return [];
    });

    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'POST',
      url: '/transfers/check-duplicates',
      payload: {
        items: [
          { id: 'item-existing', filename: 'photo.jpg', createTime: '2026-03-21T10:00:00Z' },
          { id: 'item-new', filename: 'other.jpg', createTime: '2026-03-21T10:00:00Z' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalChecked).toBe(2);
    expect(body.duplicateCount).toBe(1);
    expect(body.items).toHaveLength(2);

    const existing = body.items.find((i: any) => i.id === 'item-existing');
    const newItem = body.items.find((i: any) => i.id === 'item-new');
    expect(existing.exists).toBe(true);
    expect(newItem.exists).toBe(false);

    await app.close();
  });

  it('POST /transfers/check-duplicates returns 0 duplicates when nothing exists', async () => {
    const services = createServices();
    services.providers.listObjects = vi.fn(async () => []);

    const app = await createApiServer({ services });

    const res = await app.inject({
      method: 'POST',
      url: '/transfers/check-duplicates',
      payload: {
        items: [
          { id: 'new-1', filename: 'a.jpg' },
          { id: 'new-2', filename: 'b.jpg' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.duplicateCount).toBe(0);
    expect(body.items.every((i: any) => !i.exists)).toBe(true);

    await app.close();
  });

  it('POST /transfers/check-duplicates validates input', async () => {
    const app = await createApiServer({ services: createServices() });

    const res = await app.inject({
      method: 'POST',
      url: '/transfers/check-duplicates',
      payload: { items: [] },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});
