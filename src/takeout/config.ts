import path from 'node:path';
import { loadEnv, type Env } from '../config/env.js';

export type TakeoutConfig = {
  inputDir: string;
  workDir: string;
  statePath: string;
  uploadConcurrency: number;
  uploadRetryCount: number;
};

export type TakeoutConfigOverrides = {
  /** Override the input directory (instead of TAKEOUT_INPUT_DIR env var). */
  inputDir?: string;
};

/**
 * Load typed Takeout migration configuration.
 * Paths are resolved to absolute paths from the current working directory.
 *
 * @param env - Optional pre-loaded environment config.
 * @param overrides - Optional overrides for specific config fields (e.g. inputDir from CLI).
 */
export function loadTakeoutConfig(env?: Env, overrides?: TakeoutConfigOverrides): TakeoutConfig {
  const source = env ?? loadEnv();

  return {
    inputDir: overrides?.inputDir ? path.resolve(overrides.inputDir) : path.resolve(source.TAKEOUT_INPUT_DIR),
    workDir: path.resolve(source.TAKEOUT_WORK_DIR),
    statePath: path.resolve(source.TRANSFER_STATE_PATH),
    uploadConcurrency: source.UPLOAD_CONCURRENCY,
    uploadRetryCount: source.UPLOAD_RETRY_COUNT,
  };
}
