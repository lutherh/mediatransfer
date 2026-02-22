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

    let enqueueResult;
    try {
      enqueueResult = await queue.enqueueBulk({
        transferJobId: job.id,
        sourceProvider: input.sourceProvider,
        destProvider: input.destProvider,
        keys: input.keys,
        prefix: input.prefix,
        sourceConfig: input.sourceConfig,
        destConfig: input.destConfig,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await jobs.update(job.id, {
        status: TransferStatus.FAILED,
        progress: 0,
        errorMessage: `Failed to enqueue transfer job: ${message}`,
      });

      return reply.code(503).send({
        error: 'Transfer queue is unavailable. Start services and try again.',
        jobId: job.id,
      });
    }

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

    const logs = await jobs.listLogs(id);
    return { job, logs };
  });

  app.get('/transfers/:id/logs', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send({ error: 'Transfer job not found' });
    }

    const logs = await jobs.listLogs(id);
    return { logs };
  });

  app.post('/transfers/:id/pause', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send({ error: 'Transfer job not found' });
    }

    if (job.status !== TransferStatus.PENDING && job.status !== TransferStatus.IN_PROGRESS) {
      return reply.code(409).send({
        error: `Transfer cannot be paused from status ${job.status}`,
      });
    }

    const updated = await jobs.update(id, {
      status: TransferStatus.CANCELLED,
      errorMessage: 'Paused by user',
    });

    return {
      message: 'Transfer paused',
      job: updated,
    };
  });

  app.post('/transfers/:id/resume', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send({ error: 'Transfer job not found' });
    }

    if (job.status !== TransferStatus.CANCELLED) {
      return reply.code(409).send({
        error: `Transfer can only be resumed from status ${TransferStatus.CANCELLED}`,
      });
    }

    const total = job.keys.length;
    const completedCount = Math.max(0, Math.min(total, Math.floor(job.progress * total)));
    const remainingKeys = job.keys.slice(completedCount);

    if (remainingKeys.length === 0) {
      const completed = await jobs.update(id, {
        status: TransferStatus.COMPLETED,
        progress: 1,
        errorMessage: null,
      });

      return {
        message: 'Transfer already complete',
        job: completed,
        enqueueResult: {
          enqueuedCount: 0,
          queueJobIds: [],
        },
      };
    }

    await jobs.update(id, {
      status: TransferStatus.PENDING,
      errorMessage: null,
    });

    let enqueueResult;
    try {
      enqueueResult = await queue.enqueueBulk({
        transferJobId: job.id,
        sourceProvider: job.sourceProvider,
        destProvider: job.destProvider,
        keys: remainingKeys,
        sourceConfig: (job.sourceConfig as Record<string, unknown> | null) ?? undefined,
        destConfig: (job.destConfig as Record<string, unknown> | null) ?? undefined,
        startIndex: completedCount,
        totalKeys: total,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await jobs.update(job.id, {
        status: TransferStatus.FAILED,
        errorMessage: `Failed to resume transfer job: ${message}`,
      });

      return reply.code(503).send({
        error: 'Transfer queue is unavailable. Start services and try again.',
        jobId: job.id,
      });
    }

    const resumed = await jobs.get(id);

    return {
      message: `Transfer resumed with ${remainingKeys.length} remaining item${remainingKeys.length === 1 ? '' : 's'}`,
      job: resumed,
      enqueueResult,
    };
  });

  app.delete('/transfers/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await jobs.update(id, { status: TransferStatus.CANCELLED, errorMessage: null });
    await jobs.delete(id);
    return reply.code(204).send();
  });
}
