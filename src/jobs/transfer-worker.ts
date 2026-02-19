import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CloudProvider } from '../providers/types.js';

export type TransferItemTask = {
  key: string;
  contentType?: string;
};

export type TransferWorkerTask = {
  transferJobId: string;
  sourceProvider: CloudProvider;
  destProvider: CloudProvider;
  items: TransferItemTask[];
};

export type TransferWorkerHooks = {
  onJobStart?: (jobId: string) => Promise<void>;
  onProgress?: (jobId: string, progress: number) => Promise<void>;
  onError?: (jobId: string, error: string) => Promise<void>;
  onComplete?: (jobId: string) => Promise<void>;
};

export async function runTransferWorkerTask(
  task: TransferWorkerTask,
  hooks: TransferWorkerHooks = {},
): Promise<void> {
  const total = task.items.length;

  if (hooks.onJobStart) {
    await hooks.onJobStart(task.transferJobId);
  }

  if (total === 0) {
    if (hooks.onProgress) await hooks.onProgress(task.transferJobId, 1);
    if (hooks.onComplete) await hooks.onComplete(task.transferJobId);
    return;
  }

  try {
    let completed = 0;

    for (const item of task.items) {
      const source = await task.sourceProvider.download(item.key);
      const uploadStream = new PassThrough();

      const uploadPromise = task.destProvider.upload(item.key, uploadStream, item.contentType);
      await pipeline(source as Readable, uploadStream);
      await uploadPromise;

      completed += 1;
      if (hooks.onProgress) {
        await hooks.onProgress(task.transferJobId, completed / total);
      }
    }

    if (hooks.onComplete) {
      await hooks.onComplete(task.transferJobId);
    }
  } catch (error) {
    if (hooks.onError) {
      await hooks.onError(
        task.transferJobId,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}
