import { describe, it, expect, vi } from 'vitest';

const mockAdd = vi.fn().mockResolvedValue({ id: '123' });

vi.mock('bullmq', () => {
  const QueueCtor = vi.fn(function QueueCtor(this: unknown, name: string, opts: unknown) {
    return { name, opts, add: mockAdd };
  });
  const WorkerCtor = vi.fn(function WorkerCtor(
    this: unknown,
    name: string,
    processor: unknown,
    opts: unknown,
  ) {
    return { name, processor, opts };
  });

  return {
    Queue: QueueCtor,
    Worker: WorkerCtor,
  };
});

import {
  TRANSFER_QUEUE_NAME,
  TRANSFER_DLQ_NAME,
  createTransferQueue,
  createTransferDeadLetterQueue,
  createTransferWorker,
  enqueueTransferJob,
  enqueueDeadLetterJob,
} from './queue.js';

describe('jobs/queue', () => {
  it('creates transfer queue with expected name', () => {
    const queue = createTransferQueue({} as any);
    expect(queue.name).toBe(TRANSFER_QUEUE_NAME);
  });

  it('creates dead-letter queue with expected name', () => {
    const queue = createTransferDeadLetterQueue({} as any);
    expect(queue.name).toBe(TRANSFER_DLQ_NAME);
  });

  it('creates transfer worker and wraps payload processor', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    const worker = createTransferWorker({} as any, processor);

    expect(worker.name).toBe(TRANSFER_QUEUE_NAME);

    await worker.processor({ data: { transferJobId: 'j1', sourceProvider: 'a', destProvider: 'b', keys: [] } });
    expect(processor).toHaveBeenCalledWith({ transferJobId: 'j1', sourceProvider: 'a', destProvider: 'b', keys: [] });
  });

  it('enqueues transfer job and returns queue job id', async () => {
    const queue = createTransferQueue({} as any);
    const id = await enqueueTransferJob(queue as any, {
      transferJobId: 'j1',
      sourceProvider: 'src',
      destProvider: 'dst',
      keys: ['a.jpg'],
    });

    expect(id).toBe('123');
    expect(mockAdd).toHaveBeenCalled();
  });

  it('enqueues dead-letter job and returns queue job id', async () => {
    const queue = createTransferDeadLetterQueue({} as any);
    const id = await enqueueDeadLetterJob(queue as any, {
      transferJobId: 'j1',
      sourceProvider: 'src',
      destProvider: 'dst',
      keys: ['a.jpg'],
      error: 'network timeout',
      failedAt: '2026-02-20T16:00:00.000Z',
      attemptsMade: 5,
    });

    expect(id).toBe('123');
    expect(mockAdd).toHaveBeenCalled();
  });

  it('routes permanently failed jobs to dead-letter queue', async () => {
    const processor = vi.fn().mockRejectedValue(new Error('fatal error'));
    const deadLetterQueue = {
      add: vi.fn().mockResolvedValue({ id: 'dlq-1' }),
    } as any;

    const worker = createTransferWorker({} as any, processor, { deadLetterQueue });

    await expect(
      worker.processor({
        data: {
          transferJobId: 'j1',
          sourceProvider: 'src',
          destProvider: 'dst',
          keys: ['a.jpg'],
        },
        attemptsMade: 4,
        opts: { attempts: 5 },
      }),
    ).rejects.toThrow('fatal error');

    expect(deadLetterQueue.add).toHaveBeenCalledWith(
      'dead-letter-transfer-batch',
      expect.objectContaining({
        transferJobId: 'j1',
        error: 'fatal error',
        attemptsMade: 5,
      }),
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it('does not route non-final failed attempts to dead-letter queue', async () => {
    const processor = vi.fn().mockRejectedValue(new Error('retry me'));
    const deadLetterQueue = {
      add: vi.fn().mockResolvedValue({ id: 'dlq-2' }),
    } as any;

    const worker = createTransferWorker({} as any, processor, { deadLetterQueue });

    await expect(
      worker.processor({
        data: {
          transferJobId: 'j2',
          sourceProvider: 'src',
          destProvider: 'dst',
          keys: ['b.jpg'],
        },
        attemptsMade: 1,
        opts: { attempts: 5 },
      }),
    ).rejects.toThrow('retry me');

    expect(deadLetterQueue.add).not.toHaveBeenCalled();
  });
});
