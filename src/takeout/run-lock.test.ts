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
    const handle = await acquireRunLock(tmpDir, {
      source: 'cli',
      command: 'foo',
      runToken: 'token-123',
    });
    expect(handle.info.pid).toBe(process.pid);
    expect(handle.info.source).toBe('cli');
    expect(handle.info.instanceId).toEqual(expect.any(String));
    expect(handle.info.runToken).toBe('token-123');

    const read = await readRunLock(tmpDir);
    expect(read).not.toBeNull();
    expect(read?.pid).toBe(process.pid);
    expect(read?.instanceId).toBe(handle.info.instanceId);
    expect(read?.runToken).toBe('token-123');

    await handle.release();
    expect(await readRunLock(tmpDir)).toBeNull();
  });

  it('fails closed on corrupt lock JSON without deleting the file', async () => {
    const lockFile = path.join(tmpDir, '.takeout-run.lock');
    await fs.writeFile(lockFile, '{not-json', 'utf8');

    await expect(readRunLock(tmpDir)).rejects.toThrow('takeout run lock is unreadable');
    await expect(
      acquireRunLock(tmpDir, { source: 'api', command: 'new' }),
    ).rejects.toThrow('takeout run lock is unreadable');
    await expect(fs.readFile(lockFile, 'utf8')).resolves.toBe('{not-json');
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
    const leftoverTmpFiles = (await fs.readdir(tmpDir)).filter(
      (name) => name.startsWith('.takeout-run.lock.') && name.endsWith('.tmp'),
    );
    expect(leftoverTmpFiles).toEqual([]);
    await handle.release();
  });

  it('heartbeat and release leave a successor lock intact', async () => {
    const lockFile = path.join(tmpDir, '.takeout-run.lock');
    const handle = await acquireRunLock(tmpDir, { source: 'cli', command: 'first' });
    const original = (await readRunLock(tmpDir))!;
    const successorLastSeen = new Date(Date.now() + 1_000).toISOString();
    const successor = {
      ...original,
      command: 'successor',
      instanceId: 'successor-instance',
      runToken: 'successor-token',
      lastSeenAt: successorLastSeen,
    };
    await fs.writeFile(lockFile, JSON.stringify(successor, null, 2), 'utf8');

    await handle.heartbeat();

    const afterHeartbeat = JSON.parse(await fs.readFile(lockFile, 'utf8')) as typeof successor;
    expect(afterHeartbeat).toMatchObject({
      command: 'successor',
      instanceId: 'successor-instance',
      runToken: 'successor-token',
      lastSeenAt: successorLastSeen,
    });
    const leftoverTmpFiles = (await fs.readdir(tmpDir)).filter(
      (name) => name.startsWith('.takeout-run.lock.') && name.endsWith('.tmp'),
    );
    expect(leftoverTmpFiles).toEqual([]);

    await handle.release();

    const afterRelease = JSON.parse(await fs.readFile(lockFile, 'utf8')) as typeof successor;
    expect(afterRelease).toMatchObject({
      command: 'successor',
      instanceId: 'successor-instance',
      runToken: 'successor-token',
    });
  });
});
