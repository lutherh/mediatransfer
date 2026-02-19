import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProvidersService } from '../types.js';

const providerConfigSchema = z.record(z.string(), z.unknown());

export async function registerProviderRoutes(
  app: FastifyInstance,
  service: ProvidersService,
): Promise<void> {
  app.get('/providers', async () => {
    return {
      providers: service.listNames(),
    };
  });

  app.post('/providers/:name/test', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const config = providerConfigSchema.parse((req.body as { config?: unknown } | undefined)?.config ?? {});

    const result = await service.testConnection(name, config);
    if (!result.ok) {
      return reply.code(400).send(result);
    }

    return result;
  });

  app.post('/providers/:name/list', async (req) => {
    const name = (req.params as { name: string }).name;
    const body = req.body as { config?: unknown; prefix?: string; maxResults?: number } | undefined;

    const config = providerConfigSchema.parse(body?.config ?? {});
    const items = await service.listObjects(name, config, {
      prefix: body?.prefix,
      maxResults: body?.maxResults,
    });

    return { items };
  });
}
