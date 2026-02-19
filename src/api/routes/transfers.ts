import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TransferStatus } from '../../generated/prisma/client.js';
import type { JobsService, QueueService } from '../types.js';

const createTransferSchema = z.object({
  sourceProvider: z.string().min(1),
  destProvider: z.string().min(1),
  sourceConfig: z.record(z.string(), z.unknown()).optional(),
  destConfig: z.record(z.string(), z.unknown()).optional(),
  keys: z.array(z.string()).optional(),
  prefix: z.string().optional(),
});

export async function registerTransferRoutes(
  app: FastifyInstance,
  jobs: JobsService,
  queue: QueueService,
): Promise<void> {
  app.post('/transfers', async (req, reply) => {
    const input = createTransferSchema.parse(req.body);

    const job = await jobs.create({
      sourceProvider: input.sourceProvider,
      destProvider: input.destProvider,
      sourceConfig: input.sourceConfig,
      destConfig: input.destConfig,
      keys: input.keys,
    });

    const enqueueResult = await queue.enqueueBulk({
      transferJobId: job.id,
      sourceProvider: input.sourceProvider,
      destProvider: input.destProvider,
      keys: input.keys,
      prefix: input.prefix,
      sourceConfig: input.sourceConfig,
      destConfig: input.destConfig,
    });

    return reply.code(201).send({ job, enqueueResult });
  });

  app.get('/transfers', async (req) => {
    const query = req.query as {
      status?: TransferStatus;
      sourceProvider?: string;
      destProvider?: string;
    };

    return jobs.list(query);
  });

  app.get('/transfers/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send({ error: 'Transfer job not found' });
    }

    return { job, logs: [] };
  });

  app.delete('/transfers/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await jobs.update(id, { status: TransferStatus.CANCELLED, errorMessage: null });
    await jobs.delete(id);
    return reply.code(204).send();
  });
}
