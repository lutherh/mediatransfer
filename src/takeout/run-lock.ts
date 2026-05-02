/**
 * Cross-process advisory lock for takeout runs.
 *
 * Both the overnight CLI (`scripts/takeout-process.ts`) and the API
 * (`src/api/routes/takeout.ts`) write to the same JSON state files
 * (`state.json`, `archive-state.json`, `manifest.jsonl`). Without a
 * cross-process mutex they race on read-modify-write and the loser's
 * checkpoint is silently lost on `rename`.
 *
 * This module provides a simple PID-based lockfile. Acquire is best-effort
 * exclusive (`O_EXCL`); the lock is treated as stale if the recorded PID is
 * no longer alive. Both writers MUST acquire before mutating state.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export type RunLockSource = 'cli' | 'api';

export interface RunLockInfo {
  pid: number;
  startedAt: string;
  source: RunLockSource;
  command: string;
  /** Unique holder id; protects release/heartbeat against PID reuse. */
  instanceId?: string;
  /** Optional token propagated by the API to identify its own descendant CLI. */
  runToken?: string;
  /** Wall clock time the lock was last refreshed; populated by `heartbeat()`. */
  lastSeenAt?: string;
}

export interface RunLockHandle {
  info: RunLockInfo;
  /** Best-effort delete the lockfile. Idempotent. */
  release(): Promise<void>;
  /** Update `lastSeenAt` to indicate the holder is still progressing. */
  heartbeat(): Promise<void>;
}

const LOCK_FILE = '.takeout-run.lock';
/**
 * If the holder hasn't refreshed `lastSeenAt` within this window, treat the
 * lock as stale and reclaim it. The CLI heartbeats every 30s, so 5 min is
 * comfortably above the worst-case GC pause / disk stall. Used in addition
 * to a same-namespace PID liveness check (which alone is unreliable when
 * the API runs in Docker against a host CLI — PID namespaces differ).
 */
const HEARTBEAT_STALE_MS = 5 * 60_000;

function lockPath(workDir: string): string {
  return path.join(workDir, LOCK_FILE);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

function isSameLockHolder(a: RunLockInfo, b: RunLockInfo): boolean {
  if (a.instanceId && b.instanceId) return a.instanceId === b.instanceId;
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 only checks whether we can deliver a signal (process exists).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but owned by another user.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * Decide whether a lock record represents a still-running holder.
 *
 * Liveness signals (any one suffices):
 *   1. The PID is alive in the current process namespace (best signal when
 *      both lock holder and reader run on the same kernel).
 *   2. `lastSeenAt` was updated within `HEARTBEAT_STALE_MS`. This is the
 *      authoritative cross-namespace signal: a Dockerized API can't see
 *      host PIDs, but it can see file mtimes via the bind-mounted volume.
 *
 * Without both signals the lock is presumed stale and may be reclaimed.
 */
function isLockHolderAlive(info: RunLockInfo): boolean {
  if (isProcessAlive(info.pid)) return true;
  if (info.lastSeenAt) {
    const age = Date.now() - new Date(info.lastSeenAt).getTime();
    if (Number.isFinite(age) && age < HEARTBEAT_STALE_MS) return true;
  }
  return false;
}

/**
 * Read and validate the current run lock, if any. Returns `null` when the
 * file is absent or the recorded PID is dead (and removes the stale file).
 */
export async function readRunLock(workDir: string): Promise<RunLockInfo | null> {
  const file = lockPath(workDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: RunLockInfo;
  try {
    parsed = JSON.parse(raw) as RunLockInfo;
  } catch (err) {
    // Corrupted lock means the lock state is unknown. Fail closed: do not
    // delete it and do not allow a writer to start. A future valid heartbeat
    // can repair the file; otherwise an operator can remove it explicitly.
    const error = new Error(`takeout run lock is unreadable: ${file}`);
    error.cause = err;
    throw error;
  }
  if (!isLockHolderAlive(parsed)) {
    await fs.rm(file, { force: true });
    return null;
  }
  return parsed;
}

export class RunLockBusyError extends Error {
  readonly existing: RunLockInfo;
  constructor(existing: RunLockInfo) {
    super(
      `takeout run lock held by ${existing.source} pid=${existing.pid} (since ${existing.startedAt})`,
    );
    this.name = 'RunLockBusyError';
    this.existing = existing;
  }
}

/**
 * Acquire the run lock exclusively. Throws `RunLockBusyError` if another
 * live process holds it. Stale locks are silently reclaimed.
 */
export async function acquireRunLock(
  workDir: string,
  details: { source: RunLockSource; command: string; runToken?: string },
): Promise<RunLockHandle> {
  await fs.mkdir(workDir, { recursive: true });
  const file = lockPath(workDir);

  // Check & clean stale lock first; readRunLock removes dead-PID files.
  const existing = await readRunLock(workDir);
  if (existing) {
    throw new RunLockBusyError(existing);
  }

  const info: RunLockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    instanceId: crypto.randomUUID(),
    runToken: details.runToken,
    source: details.source,
    command: details.command,
    lastSeenAt: new Date().toISOString(),
  };
  // O_EXCL guarantees we don't trample a lock that appeared between the
  // readRunLock check and the create. wx = O_WRONLY | O_CREAT | O_EXCL.
  try {
    await fs.writeFile(file, JSON.stringify(info, null, 2), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const racing = await readRunLock(workDir);
      if (racing) throw new RunLockBusyError(racing);
      // Stale lock that readRunLock just cleaned — retry once.
      await fs.writeFile(file, JSON.stringify(info, null, 2), { flag: 'wx' });
    } else {
      throw err;
    }
  }

  let released = false;
  return {
    info,
    async release() {
      if (released) return;
      released = true;
      // Only delete the lock if it's still ours; another process may have
      // reclaimed a stale lock under us.
      try {
        const current = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(current) as RunLockInfo;
        if (isSameLockHolder(parsed, info)) {
          await fs.rm(file, { force: true });
        }
      } catch {
        // ignore — lock already gone or unreadable.
      }
    },
    async heartbeat() {
      if (released) return;
      const updated: RunLockInfo = { ...info, lastSeenAt: new Date().toISOString() };
      try {
        const current = JSON.parse(await fs.readFile(file, 'utf8')) as RunLockInfo;
        if (isSameLockHolder(current, info)) {
          await writeJsonAtomic(file, updated);
        }
      } catch {
        // best-effort
      }
    },
  };
}
