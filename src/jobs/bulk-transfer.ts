import type { Queue } from 'bullmq';
import type { TransferJobPayload } from './queue.js';
import { enqueueTransferJob } from './queue.js';

export type BulkTransferInput = {
  transferJobId: string;
  sourceProvider: string;
  destProvider: string;
  keys?: string[];
  prefix?: string;
  sourceConfig?: Record<string, unknown>;
  destConfig?: Record<string, unknown>;
  startIndex?: number;
  totalKeys?: number;
};

export type BulkTransferResult = {
  enqueuedCount: number;
  queueJobIds: string[];
};

export async function enqueueBulkTransfer(
  queue: Queue<TransferJobPayload>,
  input: BulkTransferInput,
): Promise<BulkTransferResult> {
  const keys = normalizeKeys(input.keys, input.prefix);
  const jobIds: string[] = [];

  if (keys.length === 0) {
    return {
      enqueuedCount: 0,
      queueJobIds: [],
    };
  }

  const id = await enqueueTransferJob(queue, {
    transferJobId: input.transferJobId,
    sourceProvider: input.sourceProvider,
    destProvider: input.destProvider,
    keys,
    sourceConfig: input.sourceConfig,
    destConfig: input.destConfig,
    startIndex: input.startIndex,
    totalKeys: input.totalKeys,
  });

  jobIds.push(id);

  return {
    enqueuedCount: keys.length,
    queueJobIds: jobIds,
  };
}

function normalizeKeys(keys?: string[], prefix?: string): string[] {
  if (keys && keys.length > 0) {
    return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
  }

  if (prefix && prefix.trim().length > 0) {
    return [prefix.trim()];
  }

  return [];
}
