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
  createTransferQueue,
  createTransferWorker,
  enqueueTransferJob,
} from './queue.js';

describe('jobs/queue', () => {
  it('creates transfer queue with expected name', () => {
    const queue = createTransferQueue({} as any);
    expect(queue.name).toBe(TRANSFER_QUEUE_NAME);
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
});
