import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTakeoutRoutes } from './takeout.js';
import type { Env } from '../../config/env.js';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    HOST: '127.0.0.1',
    PORT: 3000,
    API_AUTH_TOKEN: undefined,
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    DATABASE_URL: 'http://localhost:5432/db',
    REDIS_HOST: 'localhost',
    REDIS_PORT: 6379,
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_SECRET: 'unit-test-encryption-secret-123',
    SCW_ACCESS_KEY: undefined,
    SCW_SECRET_KEY: undefined,
    SCW_REGION: 'fr-par',
    SCW_BUCKET: undefined,
    SCW_PREFIX: undefined,
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    GOOGLE_REDIRECT_URI: 'http://localhost:5173/auth/google/callback',
    GOOGLE_REFRESH_TOKEN: undefined,
    GOOGLE_ACCESS_TOKEN: undefined,
    GOOGLE_TOKEN_EXPIRY_DATE: undefined,
    GOOGLE_BATCH_STATE_PATH: './data/takeout/google-api-state.json',
    GOOGLE_BATCH_TEMP_DIR: './data/takeout/work/google-api-batches',
    TAKEOUT_INPUT_DIR: './data/takeout/input',
    TAKEOUT_WORK_DIR: './data/takeout/work',
    TRANSFER_STATE_PATH: './data/takeout/state.json',
    UPLOAD_CONCURRENCY: 4,
    UPLOAD_RETRY_COUNT: 5,
    ...overrides,
  };
}

describe('takeout routes', () => {
  let tempDir: string;

  beforeEach(async () => {
    spawnMock.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takeout-routes-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns computed status from manifest and upload state', async () => {
    const inputDir = path.join(tempDir, 'input');
    const workDir = path.join(tempDir, 'work');
    const statePath = path.join(tempDir, 'state.json');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'archive-1.zip'), 'zip-content');
    await fs.writeFile(
      path.join(workDir, 'manifest.jsonl'),
      [
        JSON.stringify({ destinationKey: 'a.jpg' }),
        JSON.stringify({ destinationKey: 'b.jpg' }),
      ].join('\n') + '\n',
    );
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        items: {
          'a.jpg': { status: 'uploaded', attempts: 1, updatedAt: '2025-01-01T00:00:00.000Z' },
          orphan: { status: 'failed', attempts: 3, updatedAt: '2025-01-02T00:00:00.000Z' },
        },
      }),
    );

    const env = baseEnv({ TAKEOUT_INPUT_DIR: inputDir, TAKEOUT_WORK_DIR: workDir, TRANSFER_STATE_PATH: statePath });
    const app = Fastify();
    await registerTakeoutRoutes(app, env);

    const res = await app.inject({ method: 'GET', url: '/takeout/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts).toEqual({
      total: 2,
      processed: 1,
      pending: 1,
      uploaded: 1,
      skipped: 0,
      failed: 0,
    });
    expect(res.json().archivesInInput).toBe(1);

    await app.close();
  });

  it('returns 400 for unknown action and 202 for known action', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'scan output\n');
        child.emit('close', 0);
      });
      return child;
    });

    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const badRes = await app.inject({
      method: 'POST',
      url: '/takeout/actions/not-valid',
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error.code).toBe('UNKNOWN_ACTION');

    const okRes = await app.inject({
      method: 'POST',
      url: '/takeout/actions/scan',
    });
    expect(okRes.statusCode).toBe(202);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const statusRes = await app.inject({ method: 'GET', url: '/takeout/action-status' });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().running).toBe(false);
    expect(statusRes.json().exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalled();

    await app.close();
  });

  // ─── PUT /takeout/input-dir ───────────────────────────────────────────────

  it('PUT /takeout/input-dir sets custom input dir and returns it resolved', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'PUT',
      url: '/takeout/input-dir',
      payload: { inputDir: './custom/input' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().inputDir).toBe(path.resolve('./custom/input'));

    await app.close();
  });

  it('PUT /takeout/input-dir returns 400 when inputDir is missing', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'PUT',
      url: '/takeout/input-dir',
      payload: {},
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('PUT /takeout/input-dir returns 400 when inputDir is empty string', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'PUT',
      url: '/takeout/input-dir',
      payload: { inputDir: '   ' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  // ─── DELETE /takeout/input-dir ────────────────────────────────────────────

  it('DELETE /takeout/input-dir resets to env default', async () => {
    const customEnvInput = path.join(tempDir, 'env-input');
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv({ TAKEOUT_INPUT_DIR: customEnvInput }));

    // First set a custom dir
    await app.inject({
      method: 'PUT',
      url: '/takeout/input-dir',
      payload: { inputDir: './override' },
    });

    // Then reset
    const res = await app.inject({
      method: 'DELETE',
      url: '/takeout/input-dir',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reset).toBe(true);
    expect(res.json().inputDir).toBe(path.resolve(customEnvInput));

    await app.close();
  });

  // ─── Custom inputDir affects /takeout/status ──────────────────────────────

  it('custom inputDir is reflected in /takeout/status paths', async () => {
    const customInput = path.join(tempDir, 'custom-input');
    const workDir = path.join(tempDir, 'work');
    await fs.mkdir(customInput, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });

    const env = baseEnv({ TAKEOUT_INPUT_DIR: './default-input', TAKEOUT_WORK_DIR: workDir });
    const app = Fastify();
    await registerTakeoutRoutes(app, env);

    // Set custom input dir
    await app.inject({
      method: 'PUT',
      url: '/takeout/input-dir',
      payload: { inputDir: customInput },
    });

    // Check status reflects the custom dir
    const statusRes = await app.inject({ method: 'GET', url: '/takeout/status' });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().paths.inputDir).toBe(path.resolve(customInput));

    await app.close();
  });

  // ─── Custom inputDir is passed to spawned scripts ─────────────────────────

  it('spawned action commands include --input-dir when custom dir is set', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'scan output\n');
        child.emit('close', 0);
      });
      return child;
    });

    const customInput = path.join(tempDir, 'my-archives');
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    // Set custom input dir
    await app.inject({
      method: 'PUT',
      url: '/takeout/input-dir',
      payload: { inputDir: customInput },
    });

    // Trigger an action
    const okRes = await app.inject({
      method: 'POST',
      url: '/takeout/actions/scan',
    });
    expect(okRes.statusCode).toBe(202);

    // Verify the spawned command includes --input-dir
    expect(spawnMock).toHaveBeenCalled();
    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--input-dir');
    expect(spawnArgs).toContain(path.resolve(customInput));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();
  });
});
