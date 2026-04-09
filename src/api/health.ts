import type { FastifyInstance } from 'fastify';
import { getPrismaClient } from '../db/index.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /** Shallow health — always 200 if the process is up (used by Docker healthcheck). */
  app.get('/health', async () => ({ ok: true }));

  /** Deep health — verifies DB connectivity. Use for monitoring/alerting. */
  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, 'ok' | string> = {};
    try {
      await getPrismaClient().$queryRawUnsafe('SELECT 1');
      checks.database = 'ok';
    } catch (err) {
      checks.database = (err as Error).message;
    }
    const allOk = Object.values(checks).every((v) => v === 'ok');
    return reply.status(allOk ? 200 : 503).send({ ok: allOk, checks });
  });
}
