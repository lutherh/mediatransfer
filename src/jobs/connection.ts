import { Redis, type RedisOptions } from 'ioredis';
import { loadEnv } from '../config/env.js';

export function getRedisOptionsFromEnv(overrides?: Partial<RedisOptions>): RedisOptions {
  const env = loadEnv();
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...overrides,
  };
}

export function createRedisConnection(overrides?: Partial<RedisOptions>): Redis {
  return new Redis(getRedisOptionsFromEnv(overrides));
}
