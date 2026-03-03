import { describe, it, expect, vi } from 'vitest';
import { clearEnvCache } from '../config/env.js';

vi.mock('ioredis', () => {
  const MockRedis = vi.fn(function MockRedis(this: unknown, options: unknown) {
    return { __kind: 'redis', options };
  });

  return {
    Redis: MockRedis,
  };
});

import { createRedisConnection, getRedisOptionsFromEnv } from './connection.js';

describe('jobs/connection', () => {
  it('builds redis options from env', () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/db';
    process.env.ENCRYPTION_SECRET = 'a-very-secure-secret-key';
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = '6385';
    clearEnvCache();

    const options = getRedisOptionsFromEnv();

    expect(options.host).toBe('127.0.0.1');
    expect(options.port).toBe(6385);
    expect(options.maxRetriesPerRequest).toBeNull();
  });

  it('creates redis connection with derived options', () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/db';
    process.env.ENCRYPTION_SECRET = 'a-very-secure-secret-key';
    clearEnvCache();

    const redis = createRedisConnection({ host: 'localhost', port: 6379 });

    expect(redis).toHaveProperty('__kind', 'redis');
    expect(redis).toHaveProperty('options.host', 'localhost');
  });
});
