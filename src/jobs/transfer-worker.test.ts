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

    await runTransferWorkerTask(
      {
        transferJobId: 'job-1',
        sourceProvider: source,
        destProvider: dest,
        items: [{ key: 'a.jpg' }, { key: 'b.jpg' }],
      },
      { onProgress: progressSpy },
    );

    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(progressSpy).toHaveBeenCalledWith('job-1', 0.5);
    expect(progressSpy).toHaveBeenCalledWith('job-1', 1);
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

    await expect(
      runTransferWorkerTask(
        {
          transferJobId: 'job-2',
          sourceProvider: source,
          destProvider: dest,
          items: [{ key: 'x' }],
        },
        { onError },
      ),
    ).rejects.toThrow('download failed');

    expect(onError).toHaveBeenCalledWith('job-2', 'download failed');
  });
});
