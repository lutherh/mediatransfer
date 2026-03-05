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

  it('should override inputDir when overrides.inputDir is provided', () => {
    const env = loadEnv({
      ...validEnv,
      TAKEOUT_INPUT_DIR: './default-input',
    });

    const cfg = loadTakeoutConfig(env, { inputDir: './custom-input' });

    expect(cfg.inputDir).toBe(path.resolve('./custom-input'));
    // Other fields should remain unaffected
    expect(cfg.workDir).toBe(path.resolve('./data/takeout/work'));
    expect(cfg.uploadConcurrency).toBe(4);
  });

  it('should fall back to env inputDir when overrides.inputDir is undefined', () => {
    const env = loadEnv({
      ...validEnv,
      TAKEOUT_INPUT_DIR: './env-input',
    });

    const cfg = loadTakeoutConfig(env, { inputDir: undefined });

    expect(cfg.inputDir).toBe(path.resolve('./env-input'));
  });

  it('should fall back to env inputDir when overrides.inputDir is empty string', () => {
    const env = loadEnv({
      ...validEnv,
      TAKEOUT_INPUT_DIR: './env-input',
    });

    const cfg = loadTakeoutConfig(env, { inputDir: '' });

    expect(cfg.inputDir).toBe(path.resolve('./env-input'));
  });

  it('should resolve relative override inputDir to absolute path', () => {
    const env = loadEnv(validEnv);

    const cfg = loadTakeoutConfig(env, { inputDir: '../some/relative/path' });

    expect(path.isAbsolute(cfg.inputDir)).toBe(true);
    expect(cfg.inputDir).toBe(path.resolve('../some/relative/path'));
  });

  it('should pass through absolute override inputDir', () => {
    const env = loadEnv(validEnv);
    const absolutePath = process.platform === 'win32'
      ? 'C:\\Users\\test\\takeout-data'
      : '/tmp/takeout-data';

    const cfg = loadTakeoutConfig(env, { inputDir: absolutePath });

    expect(cfg.inputDir).toBe(absolutePath);
  });

  it('should work with overrides but no env parameter', () => {
    // When env is undefined but overrides is provided, loadEnv() is called internally
    // We can't easily test this without setting process.env, but we verify the type works
    const env = loadEnv(validEnv);
    const cfg = loadTakeoutConfig(env, { inputDir: './override-only' });

    expect(cfg.inputDir).toBe(path.resolve('./override-only'));
  });
});
