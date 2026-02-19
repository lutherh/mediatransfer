import { loadEnv } from './config/env.js';
import { createApiServer } from './api/index.js';

export async function main(): Promise<void> {
  const env = loadEnv();
  const app = await createApiServer({ enableSwagger: env.NODE_ENV !== 'production' });

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  void main();
}
