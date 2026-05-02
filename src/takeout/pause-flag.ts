/**
 * Cross-process graceful-pause flag for takeout runs.
 *
 * The API process and the long-running CLI process (`scripts/takeout-process.ts`)
 * do not share memory and the CLI is started outside the API's child-process
 * tree when the user runs an "overnight" job. To request a graceful pause we
 * use a small file in the work directory — the CLI polls for it at the start
 * of each archive iteration and exits cleanly between archives, leaving
 * `archive-state.json` in a fully-resumable state.
 *
 * Design notes:
 *   - Existence is the signal; payload is informational only (timestamp,
 *     optional reason). Readers MUST NOT rely on parseable contents.
 *   - The CLI clears the flag on startup so a stale flag from a previous run
 *     does not cause an immediate no-op exit.
 *   - The flag lives next to `.takeout-run.lock` in the work directory.
 *   - Atomicity is not required: writers race-tolerantly call `requestPause`,
 *     and the loser's payload is the same shape.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const PAUSE_FLAG_FILE = '.takeout-pause.flag';

export interface PauseFlagInfo {
  pausedAt: string;
  reason: string | null;
}

export function pauseFlagPath(workDir: string): string {
  return path.join(workDir, PAUSE_FLAG_FILE);
}

/** Returns true when a pause has been requested. */
export async function isPauseRequested(workDir: string): Promise<boolean> {
  try {
    await fs.access(pauseFlagPath(workDir));
    return true;
  } catch {
    return false;
  }
}

/** Best-effort read of the pause flag payload. Returns `null` when absent or unreadable. */
export async function readPauseFlag(workDir: string): Promise<PauseFlagInfo | null> {
  try {
    const raw = await fs.readFile(pauseFlagPath(workDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PauseFlagInfo>;
    return {
      pausedAt: typeof parsed.pausedAt === 'string' ? parsed.pausedAt : new Date().toISOString(),
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Treat unreadable/corrupt flag the same as "set" — caller can still
    // check existence with isPauseRequested(). Returning a synthetic
    // record avoids returning null when the file is present but malformed.
    return { pausedAt: new Date().toISOString(), reason: null };
  }
}

/** Write the pause flag. Creates the work directory if missing. Idempotent. */
export async function requestPause(workDir: string, reason?: string): Promise<void> {
  await fs.mkdir(workDir, { recursive: true });
  const payload: PauseFlagInfo = {
    pausedAt: new Date().toISOString(),
    reason: reason ?? null,
  };
  await fs.writeFile(pauseFlagPath(workDir), JSON.stringify(payload, null, 2), 'utf8');
}

/** Best-effort delete the pause flag. Idempotent. */
export async function clearPauseFlag(workDir: string): Promise<void> {
  await fs.rm(pauseFlagPath(workDir), { force: true });
}
