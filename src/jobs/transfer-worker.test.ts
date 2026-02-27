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
});
