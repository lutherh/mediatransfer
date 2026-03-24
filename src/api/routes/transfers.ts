import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { TransferStatus } from '../../generated/prisma/index.js';
import type { JobsService, QueueService } from '../types.js';
import type { CloudProvider } from '../../providers/types.js';
import { apiError } from '../errors.js';
import { buildDestinationKey } from '../transfer-keys.js';

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

const listTransfersQuery = z.object({
  status: z.nativeEnum(TransferStatus).optional(),
  sourceProvider: z.string().min(1).optional(),
  destProvider: z.string().min(1).optional(),
});

const idParamsSchema = z.object({
  id: z.union([
    z.string().uuid(),
    z.string().regex(/^job-[A-Za-z0-9_-]+$/),
  ]),
});

const checkDuplicatesSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    filename: z.string().optional(),
    createTime: z.string().optional(),
  })).min(1).max(500),
});

/**
 * Attempt to enqueue a bulk transfer. On failure, mark the job as FAILED and send 503.
 * Returns the enqueue result on success, or `null` if the error response was sent.
 */
async function tryEnqueue(
  queue: QueueService,
  jobs: JobsService,
  reply: FastifyReply,
  jobId: string,
  params: Parameters<QueueService['enqueueBulk']>[0],
  errorContext: string,
): Promise<Awaited<ReturnType<QueueService['enqueueBulk']>> | null> {
  try {
    return await queue.enqueueBulk(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await jobs.update(jobId, {
      status: TransferStatus.FAILED,
      progress: 0,
      errorMessage: `Failed to ${errorContext}: ${message}`,
    });
    reply.code(503).send({
      ...apiError('QUEUE_UNAVAILABLE', 'Transfer queue is unavailable. Start services and try again.'),
      jobId,
    });
    return null;
  }
}

export async function registerTransferRoutes(
  app: FastifyInstance,
  jobs: JobsService,
  queue: QueueService,
  destProvider?: CloudProvider,
): Promise<void> {
  // ── Duplicate check ─────────────────────────────────────────────────────
  app.post('/transfers/check-duplicates', async (req, reply) => {
    if (!destProvider) {
      return reply.code(503).send(apiError('PROVIDER_UNAVAILABLE', 'Cloud storage provider not available'));
    }
    const { items } = checkDuplicatesSchema.parse(req.body);

    // Check items in parallel batches to avoid sequential latency
    const CONCURRENCY = 10;
    const results: { id: string; exists: boolean; destinationKey: string }[] = [];

    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          const destinationKey = buildDestinationKey(
            item.filename ?? `${item.id}.bin`,
            item.id,
            item.createTime,
          );
          try {
            const existing = await destProvider.list({ prefix: destinationKey, maxResults: 1 });
            const exists = existing.some((obj) => obj.key === destinationKey);
            return { id: item.id, exists, destinationKey };
          } catch {
            // If a single check fails, treat as unknown (not existing) so the
            // transfer can still proceed — worst case it re-uploads one item.
            return { id: item.id, exists: false, destinationKey };
          }
        }),
      );
      results.push(...batchResults);
    }

    const duplicateCount = results.filter((r) => r.exists).length;
    return { items: results, duplicateCount, totalChecked: results.length };
  });

  app.post('/transfers', async (req, reply) => {
    const input = createTransferSchema.parse(req.body);

    const job = await jobs.create({
      sourceProvider: input.sourceProvider,
      destProvider: input.destProvider,
      sourceConfig: input.sourceConfig,
      destConfig: input.destConfig,
      keys: input.keys,
    });

    const enqueueResult = await tryEnqueue(queue, jobs, reply, job.id, {
      transferJobId: job.id,
      sourceProvider: input.sourceProvider,
      destProvider: input.destProvider,
      keys: input.keys,
      prefix: input.prefix,
      sourceConfig: input.sourceConfig,
      destConfig: input.destConfig,
    }, 'enqueue transfer job');
    if (!enqueueResult) return;

    return reply.code(201).send({ job, enqueueResult });
  });

  app.get('/transfers', async (req) => {
    const query = listTransfersQuery.parse(req.query);

    return jobs.list(query);
  });

  app.get('/transfers/:id', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send(apiError('TRANSFER_NOT_FOUND', 'Transfer job not found'));
    }

    const logs = await jobs.listLogs(id);
    return { job, logs };
  });

  app.get('/transfers/:id/logs', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send(apiError('TRANSFER_NOT_FOUND', 'Transfer job not found'));
    }

    const logs = await jobs.listLogs(id);
    return { logs };
  });

  app.post('/transfers/:id/pause', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send(apiError('TRANSFER_NOT_FOUND', 'Transfer job not found'));
    }

    if (job.status !== TransferStatus.PENDING && job.status !== TransferStatus.IN_PROGRESS) {
      return reply.code(409).send({
        ...apiError('TRANSFER_INVALID_STATUS', `Transfer cannot be paused from status ${job.status}`),
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
    const { id } = idParamsSchema.parse(req.params);
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send(apiError('TRANSFER_NOT_FOUND', 'Transfer job not found'));
    }

    if (job.status !== TransferStatus.CANCELLED && job.status !== TransferStatus.FAILED) {
      return reply.code(409).send({
        ...apiError('TRANSFER_INVALID_STATUS', `Transfer can only be resumed from status ${TransferStatus.CANCELLED} or ${TransferStatus.FAILED}`),
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

    const enqueueResult = await tryEnqueue(queue, jobs, reply, job.id, {
      transferJobId: job.id,
      sourceProvider: job.sourceProvider,
      destProvider: job.destProvider,
      keys: remainingKeys,
      sourceConfig: (job.sourceConfig as Record<string, unknown> | null) ?? undefined,
      destConfig: (job.destConfig as Record<string, unknown> | null) ?? undefined,
      startIndex: completedCount,
      totalKeys: total,
    }, 'resume transfer job');
    if (!enqueueResult) return;

    const resumed = await jobs.get(id);

    return {
      message: `Transfer resumed with ${remainingKeys.length} remaining item${remainingKeys.length === 1 ? '' : 's'}`,
      job: resumed,
      enqueueResult,
    };
  });

  app.post('/transfers/:id/retry-item', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = retryItemSchema.parse(req.body);
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send(apiError('TRANSFER_NOT_FOUND', 'Transfer job not found'));
    }

    if (
      job.status !== TransferStatus.CANCELLED &&
      job.status !== TransferStatus.FAILED &&
      job.status !== TransferStatus.IN_PROGRESS
    ) {
      return reply.code(409).send({
        ...apiError('TRANSFER_INVALID_STATUS', `Transfer item can only be retried when transfer is ${TransferStatus.CANCELLED}, ${TransferStatus.FAILED}, or ${TransferStatus.IN_PROGRESS}`),
      });
    }

    if (!job.keys.includes(input.mediaItemId)) {
      return reply.code(404).send({
        ...apiError('TRANSFER_ITEM_NOT_FOUND', `Item ${input.mediaItemId} is not part of transfer ${id}`),
      });
    }

    const logs = await jobs.listLogs(id);
    const { completedKeys, latestStatusByItem } = parseItemLogs(logs);
    if (completedKeys.has(input.mediaItemId)) {
      return reply.code(409).send({
        ...apiError('TRANSFER_ITEM_COMPLETED', `Item ${input.mediaItemId} is already completed`),
      });
    }

    const latestStatus = latestStatusByItem.get(input.mediaItemId);
    if (latestStatus === 'IN_PROGRESS' || latestStatus === 'RETRYING') {
      return reply.code(409).send({
        ...apiError('TRANSFER_ITEM_IN_PROGRESS', `Item ${input.mediaItemId} is already in progress`),
      });
    }

    const total = job.keys.length;
    const completedCount = Math.min(total, completedKeys.size);

    if (job.status !== TransferStatus.IN_PROGRESS) {
      await jobs.update(id, {
        status: TransferStatus.PENDING,
        errorMessage: null,
      });
    }

    const enqueueResult = await tryEnqueue(queue, jobs, reply, job.id, {
      transferJobId: job.id,
      sourceProvider: job.sourceProvider,
      destProvider: job.destProvider,
      keys: [input.mediaItemId],
      sourceConfig: (job.sourceConfig as Record<string, unknown> | null) ?? undefined,
      destConfig: (job.destConfig as Record<string, unknown> | null) ?? undefined,
      startIndex: completedCount,
      totalKeys: total,
    }, 'retry item');
    if (!enqueueResult) return;

    const updated = await jobs.get(id);
    return {
      message: `Retry queued for item ${input.mediaItemId}`,
      job: updated,
      enqueueResult,
    };
  });

  app.post('/transfers/:id/retry-all-items', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send(apiError('TRANSFER_NOT_FOUND', 'Transfer job not found'));
    }

    if (
      job.status !== TransferStatus.CANCELLED &&
      job.status !== TransferStatus.FAILED &&
      job.status !== TransferStatus.IN_PROGRESS
    ) {
      return reply.code(409).send({
        ...apiError('TRANSFER_INVALID_STATUS', `Transfer items can only be queued when transfer is ${TransferStatus.CANCELLED}, ${TransferStatus.FAILED}, or ${TransferStatus.IN_PROGRESS}`),
      });
    }

    const logs = await jobs.listLogs(id);
    const { completedKeys, latestStatusByItem } = parseItemLogs(logs);

    const retryableKeys = job.keys.filter((key) => {
      if (completedKeys.has(key)) {
        return false;
      }

      const latestStatus = latestStatusByItem.get(key);
      return latestStatus !== 'IN_PROGRESS' && latestStatus !== 'RETRYING';
    });

    if (retryableKeys.length === 0) {
      return {
        message: 'No incomplete items available to queue',
        job,
        enqueueResult: {
          enqueuedCount: 0,
          queueJobIds: [],
        },
      };
    }

    const total = job.keys.length;
    const completedCount = Math.min(total, completedKeys.size);

    if (job.status !== TransferStatus.IN_PROGRESS) {
      await jobs.update(id, {
        status: TransferStatus.PENDING,
        errorMessage: null,
      });
    }

    const enqueueResult = await tryEnqueue(queue, jobs, reply, job.id, {
      transferJobId: job.id,
      sourceProvider: job.sourceProvider,
      destProvider: job.destProvider,
      keys: retryableKeys,
      sourceConfig: (job.sourceConfig as Record<string, unknown> | null) ?? undefined,
      destConfig: (job.destConfig as Record<string, unknown> | null) ?? undefined,
      startIndex: completedCount,
      totalKeys: total,
    }, 'queue incomplete items');
    if (!enqueueResult) return;

    const updated = await jobs.get(id);
    return {
      message: `Queued ${retryableKeys.length} incomplete item${retryableKeys.length === 1 ? '' : 's'}`,
      job: updated,
      enqueueResult,
    };
  });

  app.delete('/transfers/:id', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const job = await jobs.get(id);
    if (!job) {
      return reply.code(404).send(apiError('TRANSFER_NOT_FOUND', 'Transfer job not found'));
    }

    await jobs.update(id, { status: TransferStatus.CANCELLED, errorMessage: null });
    await jobs.delete(id);
    return reply.code(204).send();
  });
}

/**
 * Single-pass extraction of both completed-item IDs and per-item latest statuses.
 * Avoids iterating the full log array twice (getCompletedMediaItemIds + getLatestItemStatuses).
 */
function parseItemLogs(logs: Array<{ message: string; meta?: unknown }>): {
  completedKeys: Set<string>;
  latestStatusByItem: Map<string, string>;
} {
  const completedKeys = new Set<string>();
  const latestStatusByItem = new Map<string, string>();

  for (const log of logs) {
    if (!isRecord(log.meta)) {
      continue;
    }

    const mediaItemId = typeof log.meta.mediaItemId === 'string' ? log.meta.mediaItemId : undefined;
    if (!mediaItemId) {
      continue;
    }

    const status = typeof log.meta.status === 'string' ? log.meta.status : undefined;

    if (status) {
      latestStatusByItem.set(mediaItemId, status);
    }

    const isCompletedByStatus = status === 'COMPLETED' || status === 'SKIPPED';
    const isCompletedByMessage =
      log.message.startsWith('Uploaded ') ||
      log.message.startsWith('Skipped existing ');

    if (isCompletedByStatus || isCompletedByMessage) {
      completedKeys.add(mediaItemId);
    }
  }

  return { completedKeys, latestStatusByItem };
}

function getCompletedMediaItemIds(logs: Array<{ message: string; meta?: unknown }>): Set<string> {
  return parseItemLogs(logs).completedKeys;
}

function getLatestItemStatuses(logs: Array<{ meta?: unknown }>): Map<string, string> {
  // Cast is safe: the function only reads .meta which both types share
  return parseItemLogs(logs as Array<{ message: string; meta?: unknown }>).latestStatusByItem;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
