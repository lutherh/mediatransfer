import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Create a configured Pino logger instance.
 *
 * - In development/test: uses pino-pretty for human-readable output.
 * - In production: outputs structured JSON (default Pino behaviour).
 *
 * @param env - Partial env config; needs at least NODE_ENV and LOG_LEVEL.
 * @returns A Pino Logger instance.
 */
export function createLogger(
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>,
): Logger {
  const isDev = env.NODE_ENV !== 'production';

  const options: LoggerOptions = {
    name: 'mediatransfer',
    level: env.LOG_LEVEL,
    ...(isDev && {
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
