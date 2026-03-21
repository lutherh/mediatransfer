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

// Mock db/jobs to prevent Prisma client initialization during tests.
// The upload/resume actions call createTransferJobForUpload() which lazily
// initialises PrismaClient + @prisma/adapter-pg.  Without a real DB this
// hangs forever and eventually OOMs the vitest worker.
vi.mock('../../db/jobs.js', () => ({
  createJob: vi.fn(async () => ({ id: 'test-job-id' })),
  updateJob: vi.fn(async () => ({})),
}));

// NOTE: tempDir is declared here so baseEnv() can reference it.
// This ensures TRANSFER_STATE_PATH (and hence custom-paths.json) always
// points into the disposable temp folder, never the real data/ directory.
let tempDir: string;

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
    GOOGLE_BATCH_STATE_PATH: path.join(tempDir, 'google-api-state.json'),
    GOOGLE_BATCH_TEMP_DIR: path.join(tempDir, 'google-api-batches'),
    TAKEOUT_INPUT_DIR: path.join(tempDir, 'input'),
    TAKEOUT_WORK_DIR: path.join(tempDir, 'work'),
    TAKEOUT_ARCHIVE_DIR: undefined,
    TRANSFER_STATE_PATH: path.join(tempDir, 'state.json'),
    UPLOAD_CONCURRENCY: 4,
    UPLOAD_RETRY_COUNT: 5,
    ...overrides,
  };
}

describe('takeout routes', () => {

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
    await fs.writeFile(
      path.join(workDir, 'archive-state.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        archives: {
          'takeout-001.tgz': {
            status: 'completed',
            entryCount: 2,
            uploadedCount: 1,
            skippedCount: 1,
            failedCount: 0,
            skipReasons: {
              already_exists_in_destination: 1,
            },
            archiveSizeBytes: 1073741824,
            mediaBytes: 2147483648,
            startedAt: '2025-01-01T01:00:00.000Z',
            completedAt: '2025-01-01T01:10:00.000Z',
          },
        },
      }),
    );

    const env = baseEnv({ TAKEOUT_INPUT_DIR: inputDir, TAKEOUT_WORK_DIR: workDir, TRANSFER_STATE_PATH: statePath });
    const app = Fastify();
    await registerTakeoutRoutes(app, env);

    const res = await app.inject({ method: 'GET', url: '/takeout/status' });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.counts).toEqual({
      total: 2,
      processed: 1,
      pending: 1,
      uploaded: 1,
      skipped: 0,
      failed: 0,
    });
    expect(body.archivesInInput).toBe(1);
    expect(body.archiveHistory).toEqual([
      expect.objectContaining({
        archiveName: 'takeout-001.tgz',
        archiveSizeBytes: 1073741824,
        mediaBytes: 2147483648,
        handledPercent: 100,
        isFullyUploaded: true,
        status: 'completed',
        notUploadedReasons: [
          {
            code: 'already_exists_in_destination',
            label: 'Already exists in S3',
            count: 1,
          },
        ],
      }),
    ]);

    await app.close();
  });

  it('keeps takeout status readable when archive-state reconciliation hits ENOSPC', async () => {
    const inputDir = path.join(tempDir, 'input');
    const workDir = path.join(tempDir, 'work');
    const statePath = path.join(tempDir, 'state.json');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(workDir, 'manifest.jsonl'),
      `${JSON.stringify({ destinationKey: 'a.jpg' })}\n`,
    );
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        items: {
          'a.jpg': { status: 'uploaded', attempts: 1, updatedAt: '2025-01-01T00:00:00.000Z' },
        },
      }),
    );
    await fs.writeFile(
      path.join(workDir, 'archive-state.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        archives: {
          'takeout-001.tgz': {
            status: 'pending',
            entryCount: 1,
            uploadedCount: 1,
            skippedCount: 0,
            failedCount: 0,
          },
        },
      }),
    );

    const originalWriteFile = fs.writeFile.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (filePath, data, options) => {
      if (String(filePath).includes('archive-state.json')) {
        const error = new Error('ENOSPC: no space left on device, write') as Error & { code?: string };
        error.code = 'ENOSPC';
        throw error;
      }

      return originalWriteFile(filePath, data, options as never);
    });

    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv({
      TAKEOUT_INPUT_DIR: inputDir,
      TAKEOUT_WORK_DIR: workDir,
      TRANSFER_STATE_PATH: statePath,
    }));

    const res = await app.inject({ method: 'GET', url: '/takeout/status' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.isComplete).toBe(true);
    expect(body.archiveHistory).toEqual([
      expect.objectContaining({
        archiveName: 'takeout-001.tgz',
        status: 'completed',
        isFullyUploaded: true,
      }),
    ]);

    writeSpy.mockRestore();
    await app.close();
  });

  it('returns 400 for unknown action and 202 for known action', async () => {
    spawnMock.mockImplementation(() => {
      const c = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = vi.fn();
      queueMicrotask(() => {
        c.stdout.emit('data', 'scan output\n');
        c.emit('close', 0);
      });
      return c;
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

  // â”€â”€â”€ PUT /takeout/input-dir â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€â”€ DELETE /takeout/input-dir â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€â”€ Custom inputDir affects /takeout/status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€â”€ Custom inputDir is passed to spawned scripts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('spawned action commands include --input-dir when custom dir is set', async () => {
    spawnMock.mockImplementation(() => {
      const c = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = vi.fn();
      queueMicrotask(() => {
        c.stdout.emit('data', 'scan output\n');
        c.emit('close', 0);
      });
      return c;
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

  // â”€â”€â”€ PUT /takeout/work-dir â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('PUT /takeout/work-dir sets custom work dir and returns it resolved', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'PUT',
      url: '/takeout/work-dir',
      payload: { workDir: './custom/work' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().workDir).toBe(path.resolve('./custom/work'));

    await app.close();
  });

  it('PUT /takeout/work-dir returns 400 when workDir is missing', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'PUT',
      url: '/takeout/work-dir',
      payload: {},
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('PUT /takeout/work-dir returns 400 when workDir is empty string', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'PUT',
      url: '/takeout/work-dir',
      payload: { workDir: '  ' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  // â”€â”€â”€ DELETE /takeout/work-dir â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('DELETE /takeout/work-dir resets to env default', async () => {
    const envWorkDir = path.join(tempDir, 'env-work');
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv({ TAKEOUT_WORK_DIR: envWorkDir }));

    await app.inject({
      method: 'PUT',
      url: '/takeout/work-dir',
      payload: { workDir: './override-work' },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/takeout/work-dir',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reset).toBe(true);
    expect(res.json().workDir).toBe(path.resolve(envWorkDir));

    await app.close();
  });

  // â”€â”€â”€ Custom workDir affects /takeout/status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('custom workDir is reflected in /takeout/status paths', async () => {
    const customWork = path.join(tempDir, 'custom-work');
    await fs.mkdir(customWork, { recursive: true });

    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    await app.inject({
      method: 'PUT',
      url: '/takeout/work-dir',
      payload: { workDir: customWork },
    });

    const statusRes = await app.inject({ method: 'GET', url: '/takeout/status' });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().paths.workDir).toBe(path.resolve(customWork));

    await app.close();
  });

  it('keeps archive history from default workDir when custom workDir has no archive-state', async () => {
    const customWork = path.join(tempDir, 'custom-work');
    const defaultWork = path.join(tempDir, 'default-work');
    const inputDir = path.join(tempDir, 'input');
    const statePath = path.join(tempDir, 'state.json');

    await fs.mkdir(customWork, { recursive: true });
    await fs.mkdir(defaultWork, { recursive: true });
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ version: 1, updatedAt: '2025-01-01T00:00:00.000Z', items: {} }));
    await fs.writeFile(
      path.join(defaultWork, 'archive-state.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        archives: {
          'takeout-legacy-001.tgz': {
            status: 'completed',
            entryCount: 10,
            uploadedCount: 10,
            skippedCount: 0,
            failedCount: 0,
            completedAt: '2025-01-01T00:10:00.000Z',
          },
        },
      }),
    );

    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv({
      TAKEOUT_INPUT_DIR: inputDir,
      TAKEOUT_WORK_DIR: defaultWork,
      TRANSFER_STATE_PATH: statePath,
    }));

    await app.inject({
      method: 'PUT',
      url: '/takeout/work-dir',
      payload: { workDir: customWork },
    });

    const statusRes = await app.inject({ method: 'GET', url: '/takeout/status' });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().paths.workDir).toBe(path.resolve(customWork));
    expect(statusRes.json().archiveHistory).toEqual([
      expect.objectContaining({
        archiveName: 'takeout-legacy-001.tgz',
        isFullyUploaded: true,
        status: 'completed',
      }),
    ]);

    await app.close();
  });

  // â”€â”€â”€ Custom workDir is passed to spawned scripts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('spawned action commands include --work-dir when custom dir is set', async () => {
    spawnMock.mockImplementation(() => {
      const c = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = vi.fn();
      queueMicrotask(() => {
        c.stdout.emit('data', 'scan output\n');
        c.emit('close', 0);
      });
      return c;
    });

    const customWork = path.join(tempDir, 'my-work');
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    await app.inject({
      method: 'PUT',
      url: '/takeout/work-dir',
      payload: { workDir: customWork },
    });

    const okRes = await app.inject({
      method: 'POST',
      url: '/takeout/actions/scan',
    });
    expect(okRes.statusCode).toBe(202);

    expect(spawnMock).toHaveBeenCalled();
    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--work-dir');
    expect(spawnArgs).toContain(path.resolve(customWork));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();
  });

  // â”€â”€â”€ Custom archiveDir adds --move-archives for upload/resume â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('spawned upload command includes --move-archives and --archive-dir when archiveDir is set', async () => {
    spawnMock.mockImplementation(() => {
      const c = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = vi.fn();
      queueMicrotask(() => {
        c.stdout.emit('data', 'upload output\n');
        c.emit('close', 0);
      });
      return c;
    });

    const archiveDir = path.join(tempDir, 'external-hd');
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    // Set custom archive dir
    await app.inject({
      method: 'PUT',
      url: '/takeout/paths/archiveDir',
      payload: { value: archiveDir },
    });

    const inputDir = path.join(tempDir, 'input');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'takeout-001.tgz'), 'archive');

    // Trigger upload
    const okRes = await app.inject({
      method: 'POST',
      url: '/takeout/actions/upload',
    });
    expect(okRes.statusCode).toBe(202);

    expect(spawnMock).toHaveBeenCalled();
    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--archive-dir');
    expect(spawnArgs).toContain(path.resolve(archiveDir));
    expect(spawnArgs).toContain('--move-archives');

    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();
  });

  it('spawned scan command does NOT include --move-archives when archiveDir is set', async () => {
    spawnMock.mockImplementation(() => {
      const c = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = vi.fn();
      queueMicrotask(() => {
        c.stdout.emit('data', 'scan output\n');
        c.emit('close', 0);
      });
      return c;
    });

    const archiveDir = path.join(tempDir, 'external-hd');
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    await app.inject({
      method: 'PUT',
      url: '/takeout/paths/archiveDir',
      payload: { value: archiveDir },
    });

    const okRes = await app.inject({
      method: 'POST',
      url: '/takeout/actions/scan',
    });
    expect(okRes.statusCode).toBe(202);

    expect(spawnMock).toHaveBeenCalled();
    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    // --archive-dir is still passed (it's a path override) but --move-archives is NOT for scan
    expect(spawnArgs).toContain('--archive-dir');
    expect(spawnArgs).not.toContain('--move-archives');

    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();
  });

  // â”€â”€â”€ Generic PUT /takeout/paths/:name â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('PUT /takeout/paths/:name sets custom path and returns resolved value', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'PUT',
      url: '/takeout/paths/inputDir',
      payload: { value: './generic-input' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('inputDir');
    expect(res.json().value).toBe(path.resolve('./generic-input'));

    await app.close();
  });

  it('PUT /takeout/paths/:name returns 400 for unknown name', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'PUT',
      url: '/takeout/paths/unknownField',
      payload: { value: '/some/path' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');

    await app.close();
  });

  it('PUT /takeout/paths/:name returns 400 for empty value', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'PUT',
      url: '/takeout/paths/inputDir',
      payload: { value: '   ' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  // â”€â”€â”€ Generic DELETE /takeout/paths/:name â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('DELETE /takeout/paths/:name resets to env default', async () => {
    const envInput = path.join(tempDir, 'env-default');
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv({ TAKEOUT_INPUT_DIR: envInput }));

    // Set a custom value first
    await app.inject({
      method: 'PUT',
      url: '/takeout/paths/inputDir',
      payload: { value: './override' },
    });

    // Now reset
    const res = await app.inject({
      method: 'DELETE',
      url: '/takeout/paths/inputDir',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reset).toBe(true);
    expect(res.json().value).toBe(path.resolve(envInput));

    await app.close();
  });

  it('DELETE /takeout/paths/:name returns 400 for unknown name', async () => {
    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv());

    const res = await app.inject({
      method: 'DELETE',
      url: '/takeout/paths/bogus',
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  // â”€â”€â”€ Generic endpoint state is shared with legacy endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('generic and legacy endpoints share the same state', async () => {
    const customInput = path.join(tempDir, 'shared-input');
    const customWork = path.join(tempDir, 'shared-work');
    await fs.mkdir(customInput, { recursive: true });
    await fs.mkdir(customWork, { recursive: true });

    const app = Fastify();
    await registerTakeoutRoutes(app, baseEnv({ TAKEOUT_WORK_DIR: customWork }));

    // Set via generic endpoint
    await app.inject({
      method: 'PUT',
      url: '/takeout/paths/inputDir',
      payload: { value: customInput },
    });

    // Read via status (should see the generic-set value)
    const statusRes = await app.inject({ method: 'GET', url: '/takeout/status' });
    expect(statusRes.json().paths.inputDir).toBe(path.resolve(customInput));

    // Reset via legacy endpoint
    await app.inject({ method: 'DELETE', url: '/takeout/input-dir' });

    // Status should be back to env default
    const afterReset = await app.inject({ method: 'GET', url: '/takeout/status' });
    expect(afterReset.json().paths.inputDir).not.toBe(path.resolve(customInput));

    await app.close();
  });

  // ─── Auto-upload ────────────────────────────────────────────────────────

  describe('auto-upload', () => {
    const tick = () => new Promise((r) => setTimeout(r, 50));
    let autoApp: ReturnType<typeof Fastify>;

    afterEach(async () => {
      // Always disable auto-upload to clear timers, even if an assertion threw
      try {
        await autoApp.inject({
          method: 'PUT',
          url: '/takeout/auto-upload',
          payload: { enabled: false },
        });
      } catch { /* app may already be closed */ }
      try { await autoApp.close(); } catch { /* ignore */ }
    });

    /** Creates a mock child process. Each spawn invocation returns a fresh child. */
    function setupSpawnMock(exitCode = 0) {
      spawnMock.mockImplementation(() => {
        const c = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
        };
        c.stdout = new EventEmitter();
        c.stderr = new EventEmitter();
        c.kill = vi.fn();
        queueMicrotask(() => {
          c.stdout.emit('data', 'output\n');
          c.emit('close', exitCode);
        });
        return c;
      });
    }

    it('GET /takeout/auto-upload defaults to disabled', async () => {
      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      const res = await autoApp.inject({ method: 'GET', url: '/takeout/auto-upload' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false });
    });

    it('PUT /takeout/auto-upload enables and persists to disk', async () => {
      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      const res = await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: true });

      // wait for async persist
      await tick();

      const filePath = path.join(tempDir, 'auto-upload.json');
      const raw = await fs.readFile(filePath, 'utf8');
      expect(JSON.parse(raw)).toEqual({ enabled: true });
    });

    it('PUT /takeout/auto-upload disables and persists to disk', async () => {
      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      // Enable first
      await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: true },
      });
      await tick();

      // Now disable
      const res = await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false });
      await tick();

      const filePath = path.join(tempDir, 'auto-upload.json');
      const raw = await fs.readFile(filePath, 'utf8');
      expect(JSON.parse(raw)).toEqual({ enabled: false });
    });

    it('GET /takeout/status includes autoUpload field', async () => {
      const inputDir = path.join(tempDir, 'input');
      const workDir = path.join(tempDir, 'work');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.mkdir(workDir, { recursive: true });

      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv({
        TAKEOUT_INPUT_DIR: inputDir,
        TAKEOUT_WORK_DIR: workDir,
      }));

      // Default: disabled
      const res1 = await autoApp.inject({ method: 'GET', url: '/takeout/status' });
      expect(res1.json().autoUpload).toBe(false);

      // Enable
      await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: true },
      });

      const res2 = await autoApp.inject({ method: 'GET', url: '/takeout/status' });
      expect(res2.json().autoUpload).toBe(true);
    });

    it('scan completion sets autoUploadPending to upload', async () => {
      setupSpawnMock(0);

      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: true },
      });

      const scanRes = await autoApp.inject({
        method: 'POST',
        url: '/takeout/actions/scan',
      });
      expect(scanRes.statusCode).toBe(202);

      await tick();

      const statusRes = await autoApp.inject({ method: 'GET', url: '/takeout/action-status' });
      expect(statusRes.json().autoUploadPending).toBe('upload');
    });

    it('cleanup-move completion sets autoUploadPending to scan', async () => {
      setupSpawnMock(0);

      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: true },
      });

      const res = await autoApp.inject({
        method: 'POST',
        url: '/takeout/actions/cleanup-move',
      });
      expect(res.statusCode).toBe(202);

      await tick();

      const statusRes = await autoApp.inject({ method: 'GET', url: '/takeout/action-status' });
      expect(statusRes.json().autoUploadPending).toBe('scan');
    });

    it('disabling auto-upload clears pending state', async () => {
      setupSpawnMock(0);

      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: true },
      });

      await autoApp.inject({ method: 'POST', url: '/takeout/actions/scan' });
      await tick();

      const before = await autoApp.inject({ method: 'GET', url: '/takeout/action-status' });
      expect(before.json().autoUploadPending).toBe('upload');

      // Disable → should clear pending
      await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: false },
      });

      const after = await autoApp.inject({ method: 'GET', url: '/takeout/action-status' });
      expect(after.json().autoUploadPending).toBeNull();
    });

    it('failed action does not chain to next step', async () => {
      setupSpawnMock(1); // exit code 1 — failure

      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: true },
      });

      await autoApp.inject({ method: 'POST', url: '/takeout/actions/scan' });
      await tick();

      const statusRes = await autoApp.inject({ method: 'GET', url: '/takeout/action-status' });
      // Failed scan should NOT chain to upload — pending stays 'scan'
      // (from the initial enable schedule), not 'upload'
      expect(statusRes.json().autoUploadPending).not.toBe('upload');
    });

    it('action does not chain when auto-upload is disabled', async () => {
      setupSpawnMock(0);

      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      // Do NOT enable auto-upload — leave it disabled

      await autoApp.inject({ method: 'POST', url: '/takeout/actions/scan' });
      await tick();

      const statusRes = await autoApp.inject({ method: 'GET', url: '/takeout/action-status' });
      expect(statusRes.json().autoUploadPending).toBeNull();
    });

    it('persisted auto-upload setting is restored on restart', async () => {
      // Write the persisted file directly so loadAutoUpload picks it up
      const filePath = path.join(tempDir, 'auto-upload.json');
      await fs.writeFile(filePath, JSON.stringify({ enabled: true }), 'utf8');

      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      const res = await autoApp.inject({ method: 'GET', url: '/takeout/auto-upload' });
      expect(res.json()).toEqual({ enabled: true });
    });

    it('cleanup-delete completion also sets autoUploadPending to scan', async () => {
      setupSpawnMock(0);

      autoApp = Fastify();
      await registerTakeoutRoutes(autoApp, baseEnv());

      await autoApp.inject({
        method: 'PUT',
        url: '/takeout/auto-upload',
        payload: { enabled: true },
      });

      const res = await autoApp.inject({
        method: 'POST',
        url: '/takeout/actions/cleanup-delete',
      });
      expect(res.statusCode).toBe(202);

      await tick();

      const statusRes = await autoApp.inject({ method: 'GET', url: '/takeout/action-status' });
      expect(statusRes.json().autoUploadPending).toBe('scan');
    });
  });

  // ─── notUploadedReasons in archive history ────────────────────────────────

  it('returns notUploadedReasons with mixed skip reasons and failures', async () => {
    const inputDir = path.join(tempDir, 'input');
    const workDir = path.join(tempDir, 'work');
    const statePath = path.join(tempDir, 'state.json');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(workDir, 'manifest.jsonl'),
      `${JSON.stringify({ destinationKey: 'a.jpg' })}\n`,
    );
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        items: {},
      }),
    );
    await fs.writeFile(
      path.join(workDir, 'archive-state.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        archives: {
          'takeout-mixed.tgz': {
            status: 'failed',
            entryCount: 100,
            uploadedCount: 80,
            skippedCount: 15,
            failedCount: 5,
            skipReasons: {
              already_exists_in_destination: 10,
              already_uploaded_in_state: 3,
              already_skipped_in_state: 2,
            },
            archiveSizeBytes: 500_000_000,
            startedAt: '2025-01-01T01:00:00.000Z',
            completedAt: '2025-01-01T02:00:00.000Z',
            error: '5 item(s) failed in archive upload',
          },
        },
      }),
    );

    const env = baseEnv({ TAKEOUT_INPUT_DIR: inputDir, TAKEOUT_WORK_DIR: workDir, TRANSFER_STATE_PATH: statePath });
    const app = Fastify();
    await registerTakeoutRoutes(app, env);

    const res = await app.inject({ method: 'GET', url: '/takeout/status' });
    const body = res.json();
    expect(res.statusCode).toBe(200);

    const archive = body.archiveHistory[0];
    expect(archive.archiveName).toBe('takeout-mixed.tgz');
    expect(archive.notUploadedReasons).toEqual([
      { code: 'already_exists_in_destination', label: 'Already exists in S3', count: 10 },
      { code: 'already_uploaded_in_state', label: 'Already uploaded in previous run', count: 3 },
      { code: 'already_skipped_in_state', label: 'Already skipped in previous run', count: 2 },
      { code: 'upload_failed', label: 'Upload failed', count: 5 },
    ]);

    await app.close();
  });

  it('returns notUploadedReasons as undefined when archive has no skips or failures', async () => {
    const inputDir = path.join(tempDir, 'input');
    const workDir = path.join(tempDir, 'work');
    const statePath = path.join(tempDir, 'state.json');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(workDir, 'manifest.jsonl'),
      `${JSON.stringify({ destinationKey: 'a.jpg' })}\n`,
    );
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        items: {
          'a.jpg': { status: 'uploaded', attempts: 1, updatedAt: '2025-01-01T00:00:00.000Z' },
        },
      }),
    );
    await fs.writeFile(
      path.join(workDir, 'archive-state.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        archives: {
          'takeout-clean.tgz': {
            status: 'completed',
            entryCount: 50,
            uploadedCount: 50,
            skippedCount: 0,
            failedCount: 0,
            archiveSizeBytes: 200_000_000,
            startedAt: '2025-01-01T01:00:00.000Z',
            completedAt: '2025-01-01T01:05:00.000Z',
          },
        },
      }),
    );

    const env = baseEnv({ TAKEOUT_INPUT_DIR: inputDir, TAKEOUT_WORK_DIR: workDir, TRANSFER_STATE_PATH: statePath });
    const app = Fastify();
    await registerTakeoutRoutes(app, env);

    const res = await app.inject({ method: 'GET', url: '/takeout/status' });
    const body = res.json();
    expect(res.statusCode).toBe(200);

    const archive = body.archiveHistory[0];
    expect(archive.archiveName).toBe('takeout-clean.tgz');
    expect(archive.notUploadedReasons).toBeUndefined();

    await app.close();
  });

  it('returns notUploadedReasons for legacy archives without skipReasons field', async () => {
    const inputDir = path.join(tempDir, 'input');
    const workDir = path.join(tempDir, 'work');
    const statePath = path.join(tempDir, 'state.json');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(workDir, 'manifest.jsonl'),
      `${JSON.stringify({ destinationKey: 'a.jpg' })}\n`,
    );
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        items: {},
      }),
    );
    // Legacy archive-state: has failedCount but no skipReasons field
    await fs.writeFile(
      path.join(workDir, 'archive-state.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        archives: {
          'takeout-legacy.tgz': {
            status: 'failed',
            entryCount: 20,
            uploadedCount: 15,
            skippedCount: 2,
            failedCount: 3,
            archiveSizeBytes: 100_000_000,
            startedAt: '2025-01-01T01:00:00.000Z',
            completedAt: '2025-01-01T01:05:00.000Z',
            error: '3 item(s) failed',
          },
        },
      }),
    );

    const env = baseEnv({ TAKEOUT_INPUT_DIR: inputDir, TAKEOUT_WORK_DIR: workDir, TRANSFER_STATE_PATH: statePath });
    const app = Fastify();
    await registerTakeoutRoutes(app, env);

    const res = await app.inject({ method: 'GET', url: '/takeout/status' });
    const body = res.json();
    expect(res.statusCode).toBe(200);

    const archive = body.archiveHistory[0];
    expect(archive.archiveName).toBe('takeout-legacy.tgz');
    // Legacy archives have no skipReasons, so only failedCount is shown
    expect(archive.notUploadedReasons).toEqual([
      { code: 'upload_failed', label: 'Upload failed', count: 3 },
    ]);

    await app.close();
  });
});

