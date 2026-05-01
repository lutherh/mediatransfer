import { spawn, type ChildProcess } from 'node:child_process';
import { getLogger } from './logger.js';

const log = getLogger().child({ module: 'caffeinate' });

let activeChild: ChildProcess | null = null;

/**
 * Keep the macOS host awake for the lifetime of the current Node process.
 *
 * Long-running takeout pipelines (24–48 h) must not be interrupted by display
 * sleep, idle sleep, or system sleep — laptops will otherwise stale the
 * cross-process run lock and trigger spurious "external run" reclaims.
 *
 * Implementation: spawn `caffeinate -dimsu -w <pid>` so the assertion is
 * scoped to *this* Node process. When Node exits (clean or crash), launchd
 * reaps caffeinate via `-w` and the system returns to normal sleep policy.
 *
 * - No-op on non-macOS (Linux containers don't sleep).
 * - No-op if `caffeinate` isn't on PATH (skeletal macOS images, CI runners).
 * - No-op if `MEDIATRANSFER_CAFFEINATE=0` (escape hatch).
 * - Idempotent: a second call within the same process is a no-op.
 *
 * Returns a release function that kills the helper early if you really want
 * to give the system permission to sleep before Node exits. In practice
 * almost no caller needs this — letting `-w` clean up on exit is enough.
 */
export function ensureCaffeinate(): () => void {
  if (process.platform !== 'darwin') return () => {};
  if (process.env.MEDIATRANSFER_CAFFEINATE === '0') {
    log.debug('disabled via MEDIATRANSFER_CAFFEINATE=0');
    return () => {};
  }
  if (activeChild && !activeChild.killed) {
    return releaseActive;
  }

  try {
    // -d  prevent display sleep
    // -i  prevent idle sleep
    // -m  prevent disk sleep
    // -s  prevent system sleep on AC power
    // -u  declare a user-active assertion (also wakes the display briefly)
    // -w <pid>  exit when the watched PID exits
    const child = spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: false,
    });

    child.once('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = caffeinate not installed (rare on macOS, but possible).
      // Treat any spawn failure as "best-effort skipped" and don't crash.
      if (err.code === 'ENOENT') {
        log.debug('caffeinate binary not found on PATH — skipping');
      } else {
        log.warn({ err }, 'caffeinate failed to start — continuing without it');
      }
      activeChild = null;
    });

    child.once('exit', (code, signal) => {
      log.debug({ code, signal }, 'caffeinate exited');
      if (activeChild === child) activeChild = null;
    });

    // Don't keep the Node event loop alive on caffeinate's behalf.
    child.unref();

    activeChild = child;
    log.info({ pid: child.pid, watchPid: process.pid }, 'caffeinate attached — laptop sleep suppressed for this run');
  } catch (err) {
    log.warn({ err }, 'failed to spawn caffeinate — continuing without it');
  }

  return releaseActive;
}

function releaseActive(): void {
  const child = activeChild;
  if (!child || child.killed) return;
  activeChild = null;
  try {
    child.kill('SIGTERM');
  } catch {
    // best-effort; child may have already exited via -w
  }
}
