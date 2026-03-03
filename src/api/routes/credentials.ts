import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CredentialsService } from '../types.js';

const createCredentialSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  config: z.string().min(1),
});

export async function registerCredentialsRoutes(
  app: FastifyInstance,
  service: CredentialsService,
): Promise<void> {
  app.post('/credentials', async (req, reply) => {
    const input = createCredentialSchema.parse(req.body);
    const created = await service.create(input);
    return reply.code(201).send({
      id: created.id,
      name: created.name,
      provider: created.provider,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
  });

  app.get('/credentials', async (req) => {
    const provider = (req.query as { provider?: string } | undefined)?.provider;
    const items = await service.list(provider);
    return items.map((item) => ({
      id: item.id,
      name: item.name,
      provider: item.provider,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
  });

  const idParamSchema = z.object({ id: z.string().min(1) });

  app.delete('/credentials/:id', async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    await service.delete(id);
    return reply.code(204).send();
  });
}
