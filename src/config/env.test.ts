import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.js';

/** Minimal valid env — reused across tests */
const validEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'debug',
  PORT: '3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/mediatransfer',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_SECRET: 'a-very-secure-secret-key',
};

describe('loadEnv', () => {
  // ── Happy path ──────────────────────────────────────────────

  it('should parse a valid environment', () => {
    const env = loadEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toBe(
      'postgresql://user:pass@localhost:5432/mediatransfer',
    );
    expect(env.REDIS_HOST).toBe('localhost');
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.ENCRYPTION_SECRET).toBe('a-very-secure-secret-key');
  });

  it('should apply defaults when optional fields are missing', () => {
    const minimal = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      ENCRYPTION_SECRET: 'minimum-16-chars!',
    };
    const env = loadEnv(minimal);

    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.PORT).toBe(3000);
    expect(env.REDIS_HOST).toBe('localhost');
    expect(env.REDIS_PORT).toBe(6379);
  });

  it('should coerce PORT and REDIS_PORT from strings to numbers', () => {
    const env = loadEnv({ ...validEnv, PORT: '8080', REDIS_PORT: '6380' });

    expect(env.PORT).toBe(8080);
    expect(env.REDIS_PORT).toBe(6380);
  });

  it('should accept all valid NODE_ENV values', () => {
    for (const nodeEnv of ['development', 'production', 'test'] as const) {
      const env = loadEnv({ ...validEnv, NODE_ENV: nodeEnv });
      expect(env.NODE_ENV).toBe(nodeEnv);
    }
  });

  it('should accept all valid LOG_LEVEL values', () => {
    const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
    for (const level of levels) {
      const env = loadEnv({ ...validEnv, LOG_LEVEL: level });
      expect(env.LOG_LEVEL).toBe(level);
    }
  });

  // ── Error path ──────────────────────────────────────────────

  it('should reject missing DATABASE_URL', () => {
    const { DATABASE_URL, ...rest } = validEnv;
    expect(() => loadEnv(rest as Record<string, string>)).toThrow();
  });

  it('should reject invalid DATABASE_URL (not a URL)', () => {
    expect(() =>
      loadEnv({ ...validEnv, DATABASE_URL: 'not-a-url' }),
    ).toThrow(/DATABASE_URL must be a valid URL/);
  });

  it('should reject missing ENCRYPTION_SECRET', () => {
    const { ENCRYPTION_SECRET, ...rest } = validEnv;
    expect(() => loadEnv(rest as Record<string, string>)).toThrow();
  });

  it('should reject ENCRYPTION_SECRET shorter than 16 characters', () => {
    expect(() =>
      loadEnv({ ...validEnv, ENCRYPTION_SECRET: 'short' }),
    ).toThrow(/ENCRYPTION_SECRET must be at least 16 characters/);
  });

  it('should reject invalid NODE_ENV', () => {
    expect(() =>
      loadEnv({ ...validEnv, NODE_ENV: 'staging' }),
    ).toThrow();
  });

  it('should reject invalid LOG_LEVEL', () => {
    expect(() =>
      loadEnv({ ...validEnv, LOG_LEVEL: 'verbose' }),
    ).toThrow();
  });

  it('should reject PORT out of range', () => {
    expect(() => loadEnv({ ...validEnv, PORT: '0' })).toThrow();
    expect(() => loadEnv({ ...validEnv, PORT: '70000' })).toThrow();
  });

  it('should reject REDIS_PORT out of range', () => {
    expect(() => loadEnv({ ...validEnv, REDIS_PORT: '0' })).toThrow();
    expect(() => loadEnv({ ...validEnv, REDIS_PORT: '99999' })).toThrow();
  });

  // ── Scaleway vars ─────────────────────────────────────────

  it('should accept Scaleway config when all keys are provided', () => {
    const env = loadEnv({
      ...validEnv,
      SCW_ACCESS_KEY: 'SCWXXXXXXXXXXXXXXXXX',
      SCW_SECRET_KEY: 'secret-key',
      SCW_REGION: 'nl-ams',
      SCW_BUCKET: 'my-photos',
      SCW_PREFIX: 'backup',
    });
    expect(env.SCW_ACCESS_KEY).toBe('SCWXXXXXXXXXXXXXXXXX');
    expect(env.SCW_SECRET_KEY).toBe('secret-key');
    expect(env.SCW_REGION).toBe('nl-ams');
    expect(env.SCW_BUCKET).toBe('my-photos');
    expect(env.SCW_PREFIX).toBe('backup');
  });

  it('should default SCW_REGION to fr-par and leave other Scaleway vars undefined', () => {
    const env = loadEnv(validEnv);
    expect(env.SCW_REGION).toBe('fr-par');
    expect(env.SCW_ACCESS_KEY).toBeUndefined();
    expect(env.SCW_SECRET_KEY).toBeUndefined();
    expect(env.SCW_BUCKET).toBeUndefined();
  });

  it('should reject empty SCW_ACCESS_KEY when provided', () => {
    expect(() => loadEnv({ ...validEnv, SCW_ACCESS_KEY: '' })).toThrow();
  });

  // ── Google Photos vars ────────────────────────────────────

  it('should accept Google Photos config when all keys are provided', () => {
    const env = loadEnv({
      ...validEnv,
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    });
    expect(env.GOOGLE_CLIENT_ID).toBe('client-id.apps.googleusercontent.com');
    expect(env.GOOGLE_CLIENT_SECRET).toBe('client-secret');
    expect(env.GOOGLE_REDIRECT_URI).toBe('http://localhost:3000/auth/google/callback');
  });

  it('should default GOOGLE_REDIRECT_URI and leave other Google vars undefined', () => {
    const env = loadEnv(validEnv);
    expect(env.GOOGLE_REDIRECT_URI).toBe('http://localhost:3000/auth/google/callback');
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it('should reject invalid GOOGLE_REDIRECT_URI', () => {
    expect(() =>
      loadEnv({ ...validEnv, GOOGLE_REDIRECT_URI: 'not-a-url' }),
    ).toThrow();
  });

  // ── Google Takeout vars ───────────────────────────────────

  it('should set defaults for Takeout migration settings', () => {
    const env = loadEnv(validEnv);

    expect(env.TAKEOUT_INPUT_DIR).toBe('./data/takeout/input');
    expect(env.TAKEOUT_WORK_DIR).toBe('./data/takeout/work');
    expect(env.TRANSFER_STATE_PATH).toBe('./data/takeout/state.json');
    expect(env.UPLOAD_CONCURRENCY).toBe(4);
    expect(env.UPLOAD_RETRY_COUNT).toBe(5);
  });

  it('should accept explicit Takeout migration settings', () => {
    const env = loadEnv({
      ...validEnv,
      TAKEOUT_INPUT_DIR: './exports/takeout',
      TAKEOUT_WORK_DIR: './tmp/work',
      TRANSFER_STATE_PATH: './tmp/state.json',
      UPLOAD_CONCURRENCY: '8',
      UPLOAD_RETRY_COUNT: '7',
    });

    expect(env.TAKEOUT_INPUT_DIR).toBe('./exports/takeout');
    expect(env.TAKEOUT_WORK_DIR).toBe('./tmp/work');
    expect(env.TRANSFER_STATE_PATH).toBe('./tmp/state.json');
    expect(env.UPLOAD_CONCURRENCY).toBe(8);
    expect(env.UPLOAD_RETRY_COUNT).toBe(7);
  });

  it('should reject invalid UPLOAD_CONCURRENCY range', () => {
    expect(() => loadEnv({ ...validEnv, UPLOAD_CONCURRENCY: '0' })).toThrow();
    expect(() => loadEnv({ ...validEnv, UPLOAD_CONCURRENCY: '33' })).toThrow();
  });

  it('should reject invalid UPLOAD_RETRY_COUNT range', () => {
    expect(() => loadEnv({ ...validEnv, UPLOAD_RETRY_COUNT: '-1' })).toThrow();
    expect(() => loadEnv({ ...validEnv, UPLOAD_RETRY_COUNT: '21' })).toThrow();
  });
});
