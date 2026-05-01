import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireRunLock, readRunLock, RunLockBusyError } from './run-lock.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-lock-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('run-lock', () => {
  it('acquires when no lock exists and reads it back', async () => {
    const handle = await acquireRunLock(tmpDir, { source: 'cli', command: 'foo' });
    expect(handle.info.pid).toBe(process.pid);
    expect(handle.info.source).toBe('cli');

    const read = await readRunLock(tmpDir);
    expect(read).not.toBeNull();
    expect(read?.pid).toBe(process.pid);

    await handle.release();
    expect(await readRunLock(tmpDir)).toBeNull();
  });

  it('throws RunLockBusyError when a live lock already exists', async () => {
    const first = await acquireRunLock(tmpDir, { source: 'cli', command: 'foo' });
    await expect(
      acquireRunLock(tmpDir, { source: 'api', command: 'bar' }),
    ).rejects.toBeInstanceOf(RunLockBusyError);
    await first.release();
  });

  it('reclaims a stale lock whose PID is dead and heartbeat is old', async () => {
    const lockFile = path.join(tmpDir, '.takeout-run.lock');
    // Dead PID + heartbeat older than the 5-minute staleness window.
    const oldHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: 2_147_000_000,
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        source: 'cli',
        command: 'old',
        lastSeenAt: oldHeartbeat,
      }),
    );

    const handle = await acquireRunLock(tmpDir, { source: 'api', command: 'new' });
    expect(handle.info.pid).toBe(process.pid);
    await handle.release();
  });

  it('treats a recent heartbeat as alive even when PID is unknown (cross-namespace)', async () => {
    const lockFile = path.join(tmpDir, '.takeout-run.lock');
    // Foreign PID we can't see, but lastSeenAt is fresh — must NOT reclaim.
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: 2_147_000_000,
        startedAt: new Date().toISOString(),
        source: 'cli',
        command: 'foreign',
        lastSeenAt: new Date().toISOString(),
      }),
    );

    await expect(
      acquireRunLock(tmpDir, { source: 'api', command: 'new' }),
    ).rejects.toBeInstanceOf(RunLockBusyError);

    const read = await readRunLock(tmpDir);
    expect(read).not.toBeNull();
    expect(read?.command).toBe('foreign');
  });

  it('release is idempotent and only deletes our own lock', async () => {
    const handle = await acquireRunLock(tmpDir, { source: 'cli', command: 'foo' });
    await handle.release();
    await handle.release();
    expect(await readRunLock(tmpDir)).toBeNull();
  });

  it('heartbeat updates lastSeenAt without blocking', async () => {
    const handle = await acquireRunLock(tmpDir, { source: 'cli', command: 'foo' });
    const before = (await readRunLock(tmpDir))!.lastSeenAt;
    await new Promise((r) => setTimeout(r, 5));
    await handle.heartbeat();
    const after = (await readRunLock(tmpDir))!.lastSeenAt;
    expect(after).not.toBeUndefined();
    expect(after).not.toBe(before);
    await handle.release();
  });
});
