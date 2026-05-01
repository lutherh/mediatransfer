import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config/env.js';
import { createApiServer } from './api/index.js';
import { disconnectPrisma } from './db/index.js';
import { getLogger } from './utils/logger.js';
import { ensureCaffeinate } from './utils/caffeinate.js';

const log = getLogger().child({ module: 'index' });

export async function main(): Promise<void> {
  // Suppress macOS sleep for the lifetime of the API process. No-op in
  // Linux containers and when MEDIATRANSFER_CAFFEINATE=0.
  ensureCaffeinate();
  const env = loadEnv();

  if (env.NODE_ENV === 'production' && !env.API_AUTH_TOKEN) {
    throw new Error('API_AUTH_TOKEN is required in production');
  }

  const corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  // Warn if any origin contains wildcards (matched as substrings / regex by @fastify/cors).
  // These relax SOP protection and should be narrowed in production.
  const wildcardOrigins = corsAllowedOrigins.filter((o) => /[*?]/.test(o));
  if (wildcardOrigins.length > 0 && env.NODE_ENV === 'production') {
    log.warn(
      { wildcardOrigins },
      '[cors] wildcard pattern(s) in CORS_ALLOWED_ORIGINS — narrow to explicit origins for production',
    );
  }

  const app = await createApiServer({
    enableSwagger: env.NODE_ENV !== 'production',
    apiAuthToken: env.API_AUTH_TOKEN,
    corsAllowedOrigins,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, '[shutdown] signal received — closing gracefully');

    // Hard deadline: force-exit after 15s to avoid hanging
    const forceTimer = setTimeout(() => {
      log.error('[shutdown] Timeout — forcing exit');
      process.exit(1);
    }, 15_000);
    forceTimer.unref();

    try {
      await app.close();
      await disconnectPrisma();
    } catch (err) {
      log.error({ err }, '[shutdown] Error during cleanup');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, '[unhandledRejection]');
  });

  await app.listen({ port: env.PORT, host: env.HOST });
}

const currentPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentPath === invokedPath) {
  main().catch((err) => {
    log.error({ err }, 'Fatal startup error');
    process.exit(1);
  });
}
