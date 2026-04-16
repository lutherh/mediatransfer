import type { FastifyInstance } from 'fastify';
import { getPrismaClient } from '../db/index.js';

const HEALTH_DB_TIMEOUT_MS = 5_000;

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /** Shallow health — always 200 if the process is up (used by Docker healthcheck). */
  app.get('/health', async () => ({ ok: true }));

  /** Deep health — verifies DB connectivity. Use for monitoring/alerting. */
  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, 'ok' | string> = {};
    try {
      // Parameterized tagged-template query (no string interpolation).
      // Bounded by a timeout so a hung DB cannot stall the event loop.
      const probe = getPrismaClient().$queryRaw`SELECT 1`;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('database health check timed out')), HEALTH_DB_TIMEOUT_MS),
      );
      await Promise.race([probe, timeout]);
      checks.database = 'ok';
    } catch (err) {
      checks.database = (err as Error).message;
    }
    const allOk = Object.values(checks).every((v) => v === 'ok');
    return reply.status(allOk ? 200 : 503).send({ ok: allOk, checks });
  });
}
