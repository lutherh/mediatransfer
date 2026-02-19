import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../config/env.js';
import { loadTakeoutConfig } from './config.js';

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

describe('loadTakeoutConfig', () => {
  it('should map default env values into absolute paths', () => {
    const env = loadEnv(validEnv);
    const cfg = loadTakeoutConfig(env);

    expect(path.isAbsolute(cfg.inputDir)).toBe(true);
    expect(path.isAbsolute(cfg.workDir)).toBe(true);
    expect(path.isAbsolute(cfg.statePath)).toBe(true);
    expect(cfg.uploadConcurrency).toBe(4);
    expect(cfg.uploadRetryCount).toBe(5);
  });

  it('should keep custom Takeout settings', () => {
    const env = loadEnv({
      ...validEnv,
      TAKEOUT_INPUT_DIR: './exports/takeout-input',
      TAKEOUT_WORK_DIR: './exports/takeout-work',
      TRANSFER_STATE_PATH: './exports/transfer-state.json',
      UPLOAD_CONCURRENCY: '6',
      UPLOAD_RETRY_COUNT: '9',
    });

    const cfg = loadTakeoutConfig(env);

    expect(cfg.inputDir).toBe(path.resolve('./exports/takeout-input'));
    expect(cfg.workDir).toBe(path.resolve('./exports/takeout-work'));
    expect(cfg.statePath).toBe(path.resolve('./exports/transfer-state.json'));
    expect(cfg.uploadConcurrency).toBe(6);
    expect(cfg.uploadRetryCount).toBe(9);
  });
});
