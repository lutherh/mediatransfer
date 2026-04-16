import 'dotenv/config';
import { z } from 'zod';

/** Treat empty strings from dotenv (e.g. `VAR=`) as undefined so optional fields pass validation. */
const emptyToUndefined = z.string().transform((v) => (v.trim() === '' ? undefined : v));
const optionalString = emptyToUndefined.pipe(z.string().min(1).optional());
/**
 * Schema for all environment variables used by MediaTransfer.
 * Parsed and validated at startup — app will fail fast if config is invalid.
 */
const envSchema = z.object({
  // Node
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : undefined;
    })
    .pipe(z.string().min(16).optional()),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173'),

  // PostgreSQL
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }),

  // Redis
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // Encryption
  ENCRYPTION_SECRET: z.string().min(16, {
    message: 'ENCRYPTION_SECRET must be at least 16 characters',
  }).refine(
    (val) => !['change-me-to-a-random-secret', 'change-me'].includes(val.toLowerCase()),
    { message: 'ENCRYPTION_SECRET is still set to the default placeholder. Generate a real secret.' },
  ),

  // S3-compatible Object Storage (Scaleway, AWS, Backblaze B2, Cloudflare R2, …)
  SCW_ACCESS_KEY: optionalString,
  SCW_SECRET_KEY: optionalString,
  SCW_REGION: z.string().min(1).default('fr-par'),
  SCW_BUCKET: optionalString,
  SCW_PREFIX: emptyToUndefined.pipe(z.string().optional()),
  SCW_STORAGE_CLASS: z.string().min(1).default('ONEZONE_IA'),
  /** Explicit endpoint URL override — required for non-Scaleway providers (e.g. https://s3.amazonaws.com) */
  SCW_ENDPOINT_URL: emptyToUndefined.pipe(z.string().url().optional()),
  /** Set to "false" to use virtual-hosted-style requests (required for AWS S3). Defaults to "true". */
  SCW_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  SCW_S3_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(300_000),
  SCW_S3_LIST_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(5),

  // Thumbnail disk cache (optional — set to empty string to disable)
  THUMB_CACHE_DIR: z.string().default('./data/thumbs'),

  // Google Photos OAuth2 (optional — only needed when using Google Photos provider)
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:5173/auth/google/callback'),
  GOOGLE_REFRESH_TOKEN: optionalString,
  GOOGLE_ACCESS_TOKEN: optionalString,
  GOOGLE_TOKEN_EXPIRY_DATE: z.coerce.number().optional(),
  GOOGLE_BATCH_STATE_PATH: z.string().min(1).default('./data/takeout/google-api-state.json'),
  GOOGLE_BATCH_TEMP_DIR: z.string().min(1).default('./data/takeout/work/google-api-batches'),

  // Google Takeout migration settings (full-library path)
  TAKEOUT_INPUT_DIR: z.string().min(1).default('./data/takeout/input'),
  TAKEOUT_WORK_DIR: z.string().min(1).default('./data/takeout/work'),
  TAKEOUT_ARCHIVE_DIR: optionalString,
  TRANSFER_STATE_PATH: z.string().min(1).default('./data/takeout/state.json'),
  UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  UPLOAD_RETRY_COUNT: z.coerce.number().int().min(0).max(20).default(5),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  /**
   * Per-job in-flight item concurrency inside a single transfer worker run.
   * Controls how many picker-media-item downloads+uploads proceed in parallel
   * within one transfer job. Independent of WORKER_CONCURRENCY (which controls
   * how many jobs run concurrently).
   */
  TRANSFER_ITEM_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
});

export type Env = z.infer<typeof envSchema>;

/** Cached result for `loadEnv()` with no overrides. */
let cachedEnv: Env | undefined;

/**
 * Parse and validate environment variables.
 * Results are cached when called without overrides (the common case).
 *
 * @param overrides - Optional partial env for testing. Merged on top of process.env. Bypasses cache.
 * @returns Validated, typed environment config.
 * @throws ZodError if validation fails.
 */
export function loadEnv(overrides?: Record<string, string | undefined>): Env {
  if (overrides) {
    return envSchema.parse(overrides);
  }
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
  }
  return cachedEnv;
}

/** Clear the cached env (useful for tests that mutate `process.env`). */
export function clearEnvCache(): void {
  cachedEnv = undefined;
}
