import path from 'node:path';
import { loadEnv, type Env } from '../config/env.js';

export type TakeoutConfig = {
  inputDir: string;
  workDir: string;
  /** Optional directory on a secondary drive where .tgz archives are moved after upload. */
  archiveDir?: string;
  statePath: string;
  uploadConcurrency: number;
  uploadRetryCount: number;
};

// ── Overridable paths ─────────────────────────────────────────────────────────

/**
 * Defines which TakeoutConfig path fields can be overridden from the UI or CLI.
 * Each entry maps a short name → env var key + CLI flag + config field.
 * To make a new path overridable, just add an entry here.
 */
export const OVERRIDABLE_PATHS = {
  inputDir:    { envKey: 'TAKEOUT_INPUT_DIR' as const,    cliFlag: '--input-dir',   label: 'Input' },
  workDir:     { envKey: 'TAKEOUT_WORK_DIR' as const,    cliFlag: '--work-dir',    label: 'Work' },
  archiveDir:  { envKey: 'TAKEOUT_ARCHIVE_DIR' as const, cliFlag: '--archive-dir', label: 'Archive' },
} as const;

/** The names that can be used as override keys (e.g. 'inputDir' | 'workDir'). */
export type OverridablePathName = keyof typeof OVERRIDABLE_PATHS;

/** A partial set of path overrides keyed by config field name. */
export type TakeoutPathOverrides = Partial<Record<OverridablePathName, string>>;

/** @deprecated — Use TakeoutPathOverrides instead. */
export type TakeoutConfigOverrides = TakeoutPathOverrides;

type RequiredPathName = Exclude<OverridablePathName, 'archiveDir'>;

/**
 * Parse CLI arguments for all overridable path flags.
 * Returns a TakeoutPathOverrides with values found in argv.
 *
 * @example
 *   const overrides = parseTakeoutPathArgs(process.argv.slice(2));
 *   const config = loadTakeoutConfig(undefined, overrides);
 */
export function parseTakeoutPathArgs(argv: string[]): TakeoutPathOverrides {
  const overrides: TakeoutPathOverrides = {};
  for (const [name, def] of Object.entries(OVERRIDABLE_PATHS)) {
    const idx = argv.indexOf(def.cliFlag);
    if (idx >= 0 && idx + 1 < argv.length) {
      overrides[name as OverridablePathName] = argv[idx + 1];
    }
  }
  return overrides;
}

/**
 * Load typed Takeout migration configuration.
 * Paths are resolved to absolute paths from the current working directory.
 *
 * @param env - Optional pre-loaded environment config.
 * @param overrides - Optional overrides for specific config fields (e.g. inputDir from CLI).
 */
export function loadTakeoutConfig(env?: Env, overrides?: TakeoutPathOverrides): TakeoutConfig {
  const source = env ?? loadEnv();

  function resolvePath(name: RequiredPathName): string {
    const override = overrides?.[name];
    if (override) return path.resolve(override);
    return path.resolve(source[OVERRIDABLE_PATHS[name].envKey]);
  }

  const archiveDir = overrides?.archiveDir
    ? path.resolve(overrides.archiveDir)
    : source.TAKEOUT_ARCHIVE_DIR
      ? path.resolve(source.TAKEOUT_ARCHIVE_DIR)
      : undefined;

  return {
    inputDir: resolvePath('inputDir'),
    workDir: resolvePath('workDir'),
    archiveDir,
    statePath: path.resolve(source.TRANSFER_STATE_PATH),
    uploadConcurrency: source.UPLOAD_CONCURRENCY,
    uploadRetryCount: source.UPLOAD_RETRY_COUNT,
  };
}
