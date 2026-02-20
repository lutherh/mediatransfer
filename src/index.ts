import { loadEnv } from './config/env.js';
import { createApiServer } from './api/index.js';

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
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.PORT, host: env.HOST });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  void main();
}
