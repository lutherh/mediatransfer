import 'dotenv/config';
import { z } from 'zod';

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
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173'),

  // PostgreSQL
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }),

  // Redis
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // Encryption
  ENCRYPTION_SECRET: z.string().min(16, {
    message: 'ENCRYPTION_SECRET must be at least 16 characters',
  }),

  // Scaleway Object Storage (optional — only needed when using Scaleway provider)
  SCW_ACCESS_KEY: z.string().min(1).optional(),
  SCW_SECRET_KEY: z.string().min(1).optional(),
  SCW_REGION: z.string().min(1).default('fr-par'),
  SCW_BUCKET: z.string().min(1).optional(),
  SCW_PREFIX: z.string().optional(),

  // Google Photos OAuth2 (optional — only needed when using Google Photos provider)
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:5173/auth/google/callback'),
  GOOGLE_REFRESH_TOKEN: z.string().min(1).optional(),
  GOOGLE_ACCESS_TOKEN: z.string().min(1).optional(),
  GOOGLE_TOKEN_EXPIRY_DATE: z.coerce.number().optional(),
  GOOGLE_BATCH_STATE_PATH: z.string().min(1).default('./data/takeout/google-api-state.json'),
  GOOGLE_BATCH_TEMP_DIR: z.string().min(1).default('./data/takeout/work/google-api-batches'),

  // Google Takeout migration settings (full-library path)
  TAKEOUT_INPUT_DIR: z.string().min(1).default('./data/takeout/input'),
  TAKEOUT_WORK_DIR: z.string().min(1).default('./data/takeout/work'),
  TRANSFER_STATE_PATH: z.string().min(1).default('./data/takeout/state.json'),
  UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  UPLOAD_RETRY_COUNT: z.coerce.number().int().min(0).max(20).default(5),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables.
 * @param overrides - Optional partial env for testing. Merged on top of process.env.
 * @returns Validated, typed environment config.
 * @throws ZodError if validation fails.
 */
export function loadEnv(overrides?: Record<string, string | undefined>): Env {
  const source = overrides ?? process.env;
  return envSchema.parse(source);
}
