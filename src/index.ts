import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config/env.js';
import { createApiServer } from './api/index.js';
import { disconnectPrisma } from './db/index.js';

export async function main(): Promise<void> {
  const env = loadEnv();

  if (env.NODE_ENV === 'production' && !env.API_AUTH_TOKEN) {
    throw new Error('API_AUTH_TOKEN is required in production');
  }

  const corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const app = await createApiServer({
    enableSwagger: env.NODE_ENV !== 'production',
    apiAuthToken: env.API_AUTH_TOKEN,
    corsAllowedOrigins,
  });

  const shutdown = async (): Promise<void> => {
    try {
      await app.close();
      await disconnectPrisma();
    } catch (err) {
      console.error('Shutdown error', err);
      process.exit(1);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.PORT, host: env.HOST });
}

const currentPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentPath === invokedPath) {
  void main();
}
