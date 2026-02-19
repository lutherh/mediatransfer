import { Queue, Worker, type JobsOptions, type QueueOptions, type WorkerOptions } from 'bullmq';

export const TRANSFER_QUEUE_NAME = 'transfer-jobs';

export type TransferJobPayload = {
  transferJobId: string;
  sourceProvider: string;
  destProvider: string;
  keys: string[];
  sourceConfig?: Record<string, unknown>;
  destConfig?: Record<string, unknown>;
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
  options?: WorkerOptions,
): Worker<TransferJobPayload> {
  return new Worker<TransferJobPayload>(
    TRANSFER_QUEUE_NAME,
    async (job) => processor(job.data),
    {
      connection: connection as any,
      concurrency: 2,
      ...(options ?? {}),
    },
  );
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
