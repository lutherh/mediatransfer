import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Create a configured Pino logger instance.
 *
 * - In development: uses pino-pretty for human-readable output.
 * - In test/production: outputs structured JSON (default Pino behaviour).
 *
 * @param env - Partial env config; needs at least NODE_ENV and LOG_LEVEL.
 * @returns A Pino Logger instance.
 */
export function createLogger(
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>,
): Logger {
  const usePrettyTransport = env.NODE_ENV === 'development';

  const options: LoggerOptions = {
    name: 'mediatransfer',
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        // Env-like object keys that may get logged during startup/debug
        '*.SCW_SECRET_KEY',
        '*.SCW_ACCESS_KEY',
        '*.GOOGLE_CLIENT_SECRET',
        '*.GOOGLE_REFRESH_TOKEN',
        '*.GOOGLE_ACCESS_TOKEN',
        '*.GOOGLE_PASSWORD',
        '*.IMMICH_API_KEY',
        '*.API_AUTH_TOKEN',
        '*.ENCRYPTION_SECRET',
        '*.DATABASE_URL',
        // Generic payload keys
        '*.secretKey',
        '*.accessKey',
        '*.clientSecret',
        '*.refreshToken',
        '*.accessToken',
        '*.apiKey',
        '*.password',
        '*.token',
        'headers.authorization',
        'headers["x-api-key"]',
      ],
      censor: '[REDACTED]',
    },
    ...(usePrettyTransport && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    }),
  };

  return pino(options);
}

const VALID_NODE_ENV = ['development', 'production', 'test'] as const;
const VALID_LOG_LEVEL = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

type ValidNodeEnv = (typeof VALID_NODE_ENV)[number];
type ValidLogLevel = (typeof VALID_LOG_LEVEL)[number];

let sharedLogger: Logger | undefined;

/**
 * Returns a shared, lazily-initialised Pino logger configured from
 * `process.env.NODE_ENV` and `process.env.LOG_LEVEL`. Modules can wrap this in
 * a child logger via `getLogger().child({ module: 'foo' })`.
 */
export function getLogger(): Logger {
  if (sharedLogger) return sharedLogger;
  const nodeEnv = (VALID_NODE_ENV as readonly string[]).includes(process.env.NODE_ENV ?? '')
    ? (process.env.NODE_ENV as ValidNodeEnv)
    : 'production';
  const logLevel = (VALID_LOG_LEVEL as readonly string[]).includes(process.env.LOG_LEVEL ?? '')
    ? (process.env.LOG_LEVEL as ValidLogLevel)
    : 'info';
  sharedLogger = createLogger({ NODE_ENV: nodeEnv, LOG_LEVEL: logLevel });
  return sharedLogger;
}
