import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CloudProvider } from '../providers/types.js';
import type { LogLevel } from '../generated/prisma/client.js';

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
  onLog?: (jobId: string, entry: { level: LogLevel; message: string; meta?: Record<string, unknown> }) => Promise<void>;
  retryDelay?: (delayMs: number) => Promise<void>;
};

type RetryStrategy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

async function emitLog(
  hooks: TransferWorkerHooks,
  jobId: string,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  if (!hooks.onLog) {
    return;
  }

  await hooks.onLog(jobId, { level, message, meta });
}

function getRetryStrategy(providerName: string): RetryStrategy {
  const name = providerName.toLowerCase();

  if (name.includes('google')) {
    return { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 3000 };
  }

  if (name.includes('scaleway') || name.includes('s3')) {
    return { maxAttempts: 4, baseDelayMs: 400, maxDelayMs: 4000 };
  }

  return { maxAttempts: 3, baseDelayMs: 350, maxDelayMs: 2500 };
}

function isRetryableError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('rate limit') ||
    message.includes('temporar') ||
    message.includes('throttle')
  );
}

function computeRetryDelay(strategy: RetryStrategy, attempt: number): number {
  const exponential = Math.min(strategy.baseDelayMs * (2 ** (attempt - 1)), strategy.maxDelayMs);
  const jitter = Math.floor(Math.random() * Math.max(50, Math.floor(strategy.baseDelayMs * 0.2)));
  return Math.min(exponential + jitter, strategy.maxDelayMs);
}

async function defaultDelay(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function transferItemWithRetry(
  task: TransferWorkerTask,
  item: TransferItemTask,
  hooks: TransferWorkerHooks,
): Promise<void> {
  const sourceStrategy = getRetryStrategy(task.sourceProvider.name);
  const destStrategy = getRetryStrategy(task.destProvider.name);
  const maxAttempts = Math.max(sourceStrategy.maxAttempts, destStrategy.maxAttempts);
  const merged: RetryStrategy = {
    maxAttempts,
    baseDelayMs: Math.max(sourceStrategy.baseDelayMs, destStrategy.baseDelayMs),
    maxDelayMs: Math.max(sourceStrategy.maxDelayMs, destStrategy.maxDelayMs),
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= merged.maxAttempts; attempt += 1) {
    try {
      const source = await task.sourceProvider.download(item.key);
      const uploadStream = new PassThrough();

      const uploadPromise = task.destProvider.upload(item.key, uploadStream, item.contentType);
      await pipeline(source as Readable, uploadStream);
      await uploadPromise;
      return;
    } catch (error) {
      lastError = error;
      const canRetry = attempt < merged.maxAttempts && isRetryableError(error);

      if (!canRetry) {
        throw error;
      }

      const delayMs = computeRetryDelay(merged, attempt);
      await emitLog(hooks, task.transferJobId, 'WARN', 'Retrying transfer item', {
        key: item.key,
        attempt,
        maxAttempts: merged.maxAttempts,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });

      await (hooks.retryDelay ?? defaultDelay)(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runTransferWorkerTask(
  task: TransferWorkerTask,
  hooks: TransferWorkerHooks = {},
): Promise<void> {
  const total = task.items.length;

  if (hooks.onJobStart) {
    await hooks.onJobStart(task.transferJobId);
  }

  await emitLog(hooks, task.transferJobId, 'INFO', 'Transfer job started', {
    totalItems: total,
  });

  if (total === 0) {
    if (hooks.onProgress) await hooks.onProgress(task.transferJobId, 1);
    await emitLog(hooks, task.transferJobId, 'INFO', 'Transfer job completed', {
      totalItems: 0,
      progress: 1,
    });
    if (hooks.onComplete) await hooks.onComplete(task.transferJobId);
    return;
  }

  try {
    let completed = 0;

    for (const item of task.items) {
      await transferItemWithRetry(task, item, hooks);

      completed += 1;
      const progress = completed / total;

      if (hooks.onProgress) {
        await hooks.onProgress(task.transferJobId, progress);
      }

      await emitLog(hooks, task.transferJobId, 'INFO', 'Transferred item', {
        key: item.key,
        completed,
        total,
        progress,
      });
    }

    await emitLog(hooks, task.transferJobId, 'INFO', 'Transfer job completed', {
      totalItems: total,
      progress: 1,
    });

    if (hooks.onComplete) {
      await hooks.onComplete(task.transferJobId);
    }
  } catch (error) {
    await emitLog(
      hooks,
      task.transferJobId,
      'ERROR',
      'Transfer job failed',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );

    if (hooks.onError) {
      await hooks.onError(
        task.transferJobId,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}
