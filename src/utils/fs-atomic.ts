import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { getLogger } from './logger.js';

const log = getLogger().child({ module: 'fs-atomic' });

/** Number of times to retry the rename on EPERM/EACCES (Windows AV / indexers). */
const MAX_RENAME_RETRIES = 5;

/**
 * Write `data` to `filePath` atomically: write to a sibling tmp file, then
 * `rename` it into place. A crash mid-write leaves either the previous
 * version of the file intact, or no file at all — never a truncated mix.
 *
 * The tmp path is suffixed with a per-call random token so two concurrent
 * writes against the same target don't race on the same tmp file. The
 * later writer wins the final rename; neither leaves a half-written file.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const token = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const tmpPath = `${filePath}.${token}.tmp`;
  await fs.writeFile(tmpPath, data);

  for (let attempt = 0; attempt < MAX_RENAME_RETRIES; attempt++) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (err: unknown) {
      const isRetryable =
        err instanceof Error &&
        'code' in err &&
        ((err as NodeJS.ErrnoException).code === 'EPERM' ||
          (err as NodeJS.ErrnoException).code === 'EACCES');
      if (!isRetryable || attempt === MAX_RENAME_RETRIES - 1) {
        // Best-effort cleanup — if rename failed permanently, don't leave
        // the tmp file lying around.
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }
      const delayMs = 200 * (attempt + 1);
      log.warn(
        { delayMs, attempt: attempt + 1, maxRetries: MAX_RENAME_RETRIES, filePath },
        '[fs-atomic] rename EPERM/EACCES, retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
