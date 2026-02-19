import { describe, it, expect, vi } from 'vitest';
import { TransferStatus } from '../generated/prisma/client.js';
import { createApiServer } from './index.js';
import type { ApiServices } from './types.js';

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
  };
}

describe('api server', () => {
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
});
