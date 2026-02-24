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

const retryItemSchema = z.object({
  mediaItemId: z.string().min(1),
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

    if (job.status !== TransferStatus.CANCELLED && job.status !== TransferStatus.FAILED) {
      return reply.code(409).send({
        error: `Transfer can only be resumed from status ${TransferStatus.CANCELLED} or ${TransferStatus.FAILED}`,
      });
    }

    const total = job.keys.length;
    const logs = await jobs.listLogs(id);
    const completedKeys = getCompletedMediaItemIds(logs);
    const completedCount = Math.min(total, completedKeys.size);
    const remainingKeys = job.keys.filter((key) => !completedKeys.has(key));

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

  app.post('/transfers/:id/retry-item', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const input = retryItemSchema.parse(req.body);
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send({ error: 'Transfer job not found' });
    }

    if (job.status !== TransferStatus.CANCELLED && job.status !== TransferStatus.FAILED) {
      return reply.code(409).send({
        error: `Transfer item can only be retried when transfer is ${TransferStatus.CANCELLED} or ${TransferStatus.FAILED}`,
      });
    }

    if (!job.keys.includes(input.mediaItemId)) {
      return reply.code(404).send({
        error: `Item ${input.mediaItemId} is not part of transfer ${id}`,
      });
    }

    const logs = await jobs.listLogs(id);
    const completedKeys = getCompletedMediaItemIds(logs);
    if (completedKeys.has(input.mediaItemId)) {
      return reply.code(409).send({
        error: `Item ${input.mediaItemId} is already completed`,
      });
    }

    const total = job.keys.length;
    const completedCount = Math.min(total, completedKeys.size);

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
        keys: [input.mediaItemId],
        sourceConfig: (job.sourceConfig as Record<string, unknown> | null) ?? undefined,
        destConfig: (job.destConfig as Record<string, unknown> | null) ?? undefined,
        startIndex: completedCount,
        totalKeys: total,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await jobs.update(job.id, {
        status: TransferStatus.FAILED,
        errorMessage: `Failed to retry item: ${message}`,
      });

      return reply.code(503).send({
        error: 'Transfer queue is unavailable. Start services and try again.',
        jobId: job.id,
      });
    }

    const updated = await jobs.get(id);
    return {
      message: `Retry queued for item ${input.mediaItemId}`,
      job: updated,
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

function getCompletedMediaItemIds(logs: Array<{ message: string; meta?: unknown }>): Set<string> {
  const completed = new Set<string>();

  for (const log of logs) {
    if (!isRecord(log.meta)) {
      continue;
    }

    const mediaItemId = typeof log.meta.mediaItemId === 'string' ? log.meta.mediaItemId : undefined;
    if (!mediaItemId) {
      continue;
    }

    const status = typeof log.meta.status === 'string' ? log.meta.status : undefined;
    const isCompletedByStatus = status === 'COMPLETED' || status === 'SKIPPED';
    const isCompletedByMessage =
      log.message.startsWith('Uploaded ') ||
      log.message.startsWith('Skipped existing ');

    if (isCompletedByStatus || isCompletedByMessage) {
      completed.add(mediaItemId);
    }
  }

  return completed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
