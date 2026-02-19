import path from 'node:path';
import { loadEnv, type Env } from '../config/env.js';

export type TakeoutConfig = {
  inputDir: string;
  workDir: string;
  statePath: string;
  uploadConcurrency: number;
  uploadRetryCount: number;
};

/**
 * Load typed Takeout migration configuration.
 * Paths are resolved to absolute paths from the current working directory.
 */
export function loadTakeoutConfig(env?: Env): TakeoutConfig {
  const source = env ?? loadEnv();

  return {
    inputDir: path.resolve(source.TAKEOUT_INPUT_DIR),
    workDir: path.resolve(source.TAKEOUT_WORK_DIR),
    statePath: path.resolve(source.TRANSFER_STATE_PATH),
    uploadConcurrency: source.UPLOAD_CONCURRENCY,
    uploadRetryCount: source.UPLOAD_RETRY_COUNT,
  };
}
