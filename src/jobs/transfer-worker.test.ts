import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { runTransferWorkerTask } from './transfer-worker.js';
import type { CloudProvider } from '../providers/types.js';

function providerWithData(data: string, uploadSpy: ReturnType<typeof vi.fn>): CloudProvider {
  return {
    name: 'mock',
    async list() { return []; },
    async download() { return Readable.from([data]); },
    async upload(key, stream) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      new uploadSpy(key, Buffer.concat(chunks).toString('utf8'));
    },
    async delete() {},
  };
}

describe('jobs/transfer-worker', () => {
  it('transfers all items and emits progress', async () => {
    const uploadSpy = vi.fn();
    const source = providerWithData('hello', vi.fn());
    const dest = providerWithData('', uploadSpy);

    const progressSpy = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.fn().mockResolvedValue(undefined);

    await runTransferWorkerTask(
      {
        transferJobId: 'job-1',
        sourceProvider: source,
        destProvider: dest,
        items: [{ key: 'a.jpg' }, { key: 'b.jpg' }],
      },
      { onProgress: progressSpy, onLog: logSpy },
    );

    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(progressSpy).toHaveBeenCalledWith('job-1', 0.5);
    expect(progressSpy).toHaveBeenCalledWith('job-1', 1);
    expect(logSpy).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ level: 'INFO', message: 'Transfer job started' }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ level: 'INFO', message: 'Transfer job completed' }),
    );
  });

  it('calls onError and rethrows on failure', async () => {
    const source: CloudProvider = {
      name: 'src',
      async list() { return []; },
      async download() { throw new Error('download failed'); },
      async upload() {},
      async delete() {},
    };

    const dest: CloudProvider = {
      name: 'dst',
      async list() { return []; },
      async download() { return Readable.from([]); },
      async upload() {},
      async delete() {},
    };

    const onError = vi.fn().mockResolvedValue(undefined);
    const onLog = vi.fn().mockResolvedValue(undefined);

    await expect(
      runTransferWorkerTask(
        {
          transferJobId: 'job-2',
          sourceProvider: source,
          destProvider: dest,
          items: [{ key: 'x' }],
        },
        { onError, onLog },
      ),
    ).rejects.toThrow('download failed');

    expect(onError).toHaveBeenCalledWith('job-2', 'download failed');
    expect(onLog).toHaveBeenCalledWith(
      'job-2',
      expect.objectContaining({ level: 'ERROR', message: 'Transfer job failed' }),
    );
  });

  it('retries transient provider failures with backoff strategy', async () => {
    const source: CloudProvider = {
      name: 'google-photos',
      async list() { return []; },
      download: vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValue(Readable.from(['hello'])),
      async upload() {},
      async delete() {},
    };

    const uploadSpy = vi.fn();
    const dest: CloudProvider = {
      name: 'scaleway',
      async list() { return []; },
      async download() { return Readable.from([]); },
      async upload(key, stream) {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        uploadSpy(key, Buffer.concat(chunks).toString('utf8'));
      },
      async delete() {},
    };

    const retryDelay = vi.fn().mockResolvedValue(undefined);
    const onLog = vi.fn().mockResolvedValue(undefined);

    await runTransferWorkerTask(
      {
        transferJobId: 'job-3',
        sourceProvider: source,
        destProvider: dest,
        items: [{ key: 'retry.jpg' }],
      },
      { retryDelay, onLog },
    );

    expect(source.download).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledWith('retry.jpg', 'hello');
    expect(onLog).toHaveBeenCalledWith(
      'job-3',
      expect.objectContaining({ level: 'WARN', message: 'Retrying transfer item' }),
    );
  });

  it('retries on structured system error codes (ECONNRESET)', async () => {
    const econnresetError = Object.assign(new Error('syscall failed'), { code: 'ECONNRESET' });
    const source: CloudProvider = {
      name: 'google-photos',
      async list() { return []; },
      download: vi
        .fn()
        .mockRejectedValueOnce(econnresetError)
        .mockResolvedValue(Readable.from(['ok'])),
      async upload() {},
      async delete() {},
    };

    const dest: CloudProvider = {
      name: 'scaleway',
      async list() { return []; },
      async download() { return Readable.from([]); },
      async upload() {},
      async delete() {},
    };

    const retryDelay = vi.fn().mockResolvedValue(undefined);

    await runTransferWorkerTask(
      {
        transferJobId: 'job-code',
        sourceProvider: source,
        destProvider: dest,
        items: [{ key: 'f.jpg' }],
      },
      { retryDelay },
    );

    expect(source.download).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledTimes(1);
  });

  it('retries on AWS SDK 429 (rate limit) via $metadata', async () => {
    const rateLimitError = Object.assign(new Error('Too Many Requests'), {
      $metadata: { httpStatusCode: 429 },
    });
    const source: CloudProvider = {
      name: 'scaleway-s3',
      async list() { return []; },
      download: vi
        .fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue(Readable.from(['data'])),
      async upload() {},
      async delete() {},
    };

    const dest: CloudProvider = {
      name: 'scaleway',
      async list() { return []; },
      async download() { return Readable.from([]); },
      async upload() {},
      async delete() {},
    };

    const retryDelay = vi.fn().mockResolvedValue(undefined);

    await runTransferWorkerTask(
      {
        transferJobId: 'job-429',
        sourceProvider: source,
        destProvider: dest,
        items: [{ key: 'r.jpg' }],
      },
      { retryDelay },
    );

    expect(source.download).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledTimes(1);
  });

  it('transfers items concurrently when concurrency > 1', async () => {
    // Track the order of start / end events to prove overlapping execution
    const events: string[] = [];
    const uploadSpy = vi.fn();

    const source: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download(key) {
        events.push(`start:${key}`);
        // Simulate network latency to allow overlapping
        await new Promise((r) => setTimeout(r, 20));
        events.push(`end:${key}`);
        return Readable.from(['data']);
      },
      async upload() {},
      async delete() {},
    };

    const dest: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download() { return Readable.from([]); },
      async upload(key, stream) {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        uploadSpy(key);
      },
      async delete() {},
    };

    await runTransferWorkerTask(
      {
        transferJobId: 'job-concurrent',
        sourceProvider: source,
        destProvider: dest,
        items: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }],
        concurrency: 4,
      },
      {},
    );

    expect(uploadSpy).toHaveBeenCalledTimes(4);

    // With concurrency=4, all 4 downloads should start before any finishes.
    // events should look like: start:a, start:b, start:c, start:d, end:a, ...
    const starts = events.filter((e) => e.startsWith('start:'));
    const firstEnd = events.findIndex((e) => e.startsWith('end:'));
    // At least 2 starts should occur before the first end
    expect(firstEnd).toBeGreaterThanOrEqual(2);
    expect(starts.length).toBe(4);
  });

  it('respects concurrency limit and does not exceed it', async () => {
    let active = 0;
    let maxActive = 0;

    const source: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return Readable.from(['data']);
      },
      async upload() {},
      async delete() {},
    };

    const dest: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download() { return Readable.from([]); },
      async upload(_key, stream) {
        for await (const _chunk of stream) { /* drain */ }
      },
      async delete() {},
    };

    await runTransferWorkerTask(
      {
        transferJobId: 'job-limit',
        sourceProvider: source,
        destProvider: dest,
        items: Array.from({ length: 10 }, (_, i) => ({ key: `item-${i}` })),
        concurrency: 3,
      },
      {},
    );

    // With concurrency=3, we should never have more than 3 active downloads
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThanOrEqual(2); // at least *some* parallelism
  });

  it('defaults to sequential execution when concurrency is not set', async () => {
    const events: string[] = [];

    const source: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download(key) {
        events.push(`start:${key}`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`end:${key}`);
        return Readable.from(['data']);
      },
      async upload() {},
      async delete() {},
    };

    const dest: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download() { return Readable.from([]); },
      async upload(_key, stream) {
        for await (const _chunk of stream) { /* drain */ }
      },
      async delete() {},
    };

    await runTransferWorkerTask(
      {
        transferJobId: 'job-seq',
        sourceProvider: source,
        destProvider: dest,
        items: [{ key: 'x' }, { key: 'y' }],
        // no concurrency field — defaults to 1
      },
      {},
    );

    // Sequential: start:x, end:x, start:y, end:y
    expect(events).toEqual(['start:x', 'end:x', 'start:y', 'end:y']);
  });

  it('reports correct progress with concurrent transfers', async () => {
    const source: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download() {
        await new Promise((r) => setTimeout(r, 5));
        return Readable.from(['data']);
      },
      async upload() {},
      async delete() {},
    };

    const dest: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download() { return Readable.from([]); },
      async upload(_key, stream) {
        for await (const _chunk of stream) { /* drain */ }
      },
      async delete() {},
    };

    const progressSpy = vi.fn().mockResolvedValue(undefined);

    await runTransferWorkerTask(
      {
        transferJobId: 'job-prog',
        sourceProvider: source,
        destProvider: dest,
        items: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
        concurrency: 2,
      },
      { onProgress: progressSpy },
    );

    // progress should be called 3 times (once per completed item)
    expect(progressSpy).toHaveBeenCalledTimes(3);
    // Final call should be progress = 1
    const lastCallProgress = progressSpy.mock.calls[progressSpy.mock.calls.length - 1][1];
    expect(lastCallProgress).toBe(1);
    // All progress values should be monotonically increasing
    const values = progressSpy.mock.calls.map((c: [string, number]) => c[1]);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });

  it('aborts remaining items in batch when one fails (non-retryable)', async () => {
    const source: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download(key) {
        if (key === 'bad') throw new Error('permanent failure');
        return Readable.from(['data']);
      },
      async upload() {},
      async delete() {},
    };

    const dest: CloudProvider = {
      name: 'mock',
      async list() { return []; },
      async download() { return Readable.from([]); },
      async upload(_key, stream) {
        for await (const _chunk of stream) { /* drain */ }
      },
      async delete() {},
    };

    const onError = vi.fn().mockResolvedValue(undefined);

    await expect(
      runTransferWorkerTask(
        {
          transferJobId: 'job-fail',
          sourceProvider: source,
          destProvider: dest,
          items: [{ key: 'good1' }, { key: 'bad' }, { key: 'good2' }],
          concurrency: 1,
        },
        { onError },
      ),
    ).rejects.toThrow('permanent failure');

    expect(onError).toHaveBeenCalledWith('job-fail', 'permanent failure');
  });
});
