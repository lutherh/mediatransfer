import { vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { writeFileAtomic } from './fs-atomic.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-atomic-test-'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function listTmpSiblings(dir: string, basename: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((e) => e.startsWith(`${basename}.`) && e.endsWith('.tmp'));
}

describe('writeFileAtomic', () => {
  it('writes a string payload that can be read back identically', async () => {
    const target = path.join(sandbox, 'hello.txt');
    await writeFileAtomic(target, 'hello world');
    expect(await fs.readFile(target, 'utf8')).toBe('hello world');
  });

  it('writes a Uint8Array payload byte-for-byte', async () => {
    const target = path.join(sandbox, 'bin.dat');
    const payload = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    await writeFileAtomic(target, payload);
    const buf = await fs.readFile(target);
    expect(Array.from(buf)).toEqual(Array.from(payload));
  });

  it('creates parent directories if they do not exist', async () => {
    const target = path.join(sandbox, 'a', 'b', 'c', 'nested.txt');
    await writeFileAtomic(target, 'nested');
    expect(await fs.readFile(target, 'utf8')).toBe('nested');
  });

  it('handles concurrent writes without throwing or leaving *.tmp siblings', async () => {
    const target = path.join(sandbox, 'race.txt');
    const payloadA = 'payload-A'.repeat(100);
    const payloadB = 'payload-B'.repeat(100);

    await Promise.all([
      writeFileAtomic(target, payloadA),
      writeFileAtomic(target, payloadB),
    ]);

    const final = await fs.readFile(target, 'utf8');
    expect([payloadA, payloadB]).toContain(final);

    const leftovers = await listTmpSiblings(sandbox, 'race.txt');
    expect(leftovers).toEqual([]);
  });

  it('cleans up the tmp file when rename fails permanently', async () => {
    const target = path.join(sandbox, 'rofs.txt');
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValue(
      Object.assign(new Error('read-only fs'), { code: 'EROFS' }),
    );

    await expect(writeFileAtomic(target, 'never lands')).rejects.toMatchObject({
      code: 'EROFS',
    });

    expect(renameSpy).toHaveBeenCalledTimes(1);
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const leftovers = await listTmpSiblings(sandbox, 'rofs.txt');
    expect(leftovers).toEqual([]);
  });

  it('retries rename on EPERM and eventually succeeds', async () => {
    vi.useFakeTimers();

    const target = path.join(sandbox, 'eperm.txt');
    const realRename = fs.rename.bind(fs);

    let calls = 0;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls <= 2) {
        throw Object.assign(new Error('locked by AV'), { code: 'EPERM' });
      }
      return realRename(from as string, to as string);
    });

    const promise = writeFileAtomic(target, 'eventually written');

    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    for (let i = 0; i < 20 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }

    await promise;

    expect(renameSpy).toHaveBeenCalledTimes(3);
    expect(await fs.readFile(target, 'utf8')).toBe('eventually written');

    const leftovers = await listTmpSiblings(sandbox, 'eperm.txt');
    expect(leftovers).toEqual([]);
  });
});
