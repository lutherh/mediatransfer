import { Queue, Worker, type JobsOptions, type QueueOptions, type WorkerOptions } from 'bullmq';

export const TRANSFER_QUEUE_NAME = 'transfer-jobs';
export const TRANSFER_DLQ_NAME = 'transfer-jobs-dlq';

export type TransferJobPayload = {
  transferJobId: string;
  sourceProvider: string;
  destProvider: string;
  keys: string[];
  sourceConfig?: Record<string, unknown>;
  destConfig?: Record<string, unknown>;
  startIndex?: number;
  totalKeys?: number;
};

export type TransferDeadLetterPayload = TransferJobPayload & {
  error: string;
  failedAt: string;
  attemptsMade: number;
};

export type CreateTransferWorkerOptions = WorkerOptions & {
  deadLetterQueue?: Queue<TransferDeadLetterPayload>;
};

export function createTransferQueue(connection: unknown, options?: QueueOptions) {
  return new Queue<TransferJobPayload>(TRANSFER_QUEUE_NAME, {
    connection: connection as any,
    ...(options ?? {}),
  });
}

export function createTransferWorker(
  connection: unknown,
  processor: (payload: TransferJobPayload) => Promise<void>,
  options?: CreateTransferWorkerOptions,
): Worker<TransferJobPayload> {
  const deadLetterQueue = options?.deadLetterQueue;
  const { deadLetterQueue: _ignoredDeadLetterQueue, ...workerOptions } = options ?? {};

  return new Worker<TransferJobPayload>(
    TRANSFER_QUEUE_NAME,
    async (job) => {
      try {
        await processor(job.data);
      } catch (error) {
        const attemptsMade = (job.attemptsMade ?? 0) + 1;
        const maxAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;

        if (deadLetterQueue && attemptsMade >= maxAttempts) {
          await enqueueDeadLetterJob(deadLetterQueue, {
            ...job.data,
            error: error instanceof Error ? error.message : String(error),
            failedAt: new Date().toISOString(),
            attemptsMade,
          });
        }

        throw error;
      }
    },
    {
      connection: connection as any,
      concurrency: 2,
      ...(workerOptions ?? {}),
    },
  );
}

export function createTransferDeadLetterQueue(connection: unknown, options?: QueueOptions) {
  return new Queue<TransferDeadLetterPayload>(TRANSFER_DLQ_NAME, {
    connection: connection as any,
    ...(options ?? {}),
  });
}

export async function enqueueTransferJob(
  queue: Queue<TransferJobPayload>,
  payload: TransferJobPayload,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add('transfer-file-batch', payload, {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    ...(options ?? {}),
  });

  return String(job.id);
}

export async function enqueueDeadLetterJob(
  queue: Queue<TransferDeadLetterPayload>,
  payload: TransferDeadLetterPayload,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add('dead-letter-transfer-batch', payload, {
    removeOnComplete: 5000,
    removeOnFail: 20000,
    attempts: 1,
    ...(options ?? {}),
  });

  return String(job.id);
}
