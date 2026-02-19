import { describe, it, expect, vi } from 'vitest';
import { enqueueBulkTransfer } from './bulk-transfer.js';

function createQueueMock() {
  return {
    add: vi.fn().mockImplementation((_name, payload) => Promise.resolve({ id: payload.keys[0] })),
  } as any;
}

describe('jobs/bulk-transfer', () => {
  it('enqueues one queue job per key', async () => {
    const queue = createQueueMock();

    const result = await enqueueBulkTransfer(queue, {
      transferJobId: 'job-1',
      sourceProvider: 'src',
      destProvider: 'dst',
      keys: ['b.jpg', 'a.jpg', 'a.jpg'],
    });

    expect(result.enqueuedCount).toBe(2);
    expect(result.queueJobIds).toEqual(['a.jpg', 'b.jpg']);
  });

  it('supports prefix fallback when keys are absent', async () => {
    const queue = createQueueMock();

    const result = await enqueueBulkTransfer(queue, {
      transferJobId: 'job-2',
      sourceProvider: 'src',
      destProvider: 'dst',
      prefix: '2025/12',
    });

    expect(result.enqueuedCount).toBe(1);
    expect(result.queueJobIds).toEqual(['2025/12']);
  });
});
