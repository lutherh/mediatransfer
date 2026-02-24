import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { sha256Stream, sha256Buffer } from './hash.js';
import { createHash } from 'node:crypto';

describe('sha256Buffer', () => {
  it('returns hex-encoded SHA-256 of a buffer', () => {
    const data = Buffer.from('hello world');
    const expected = createHash('sha256').update(data).digest('hex');
    expect(sha256Buffer(data)).toBe(expected);
  });

  it('returns consistent hashes for identical input', () => {
    const a = sha256Buffer(Buffer.from('test'));
    const b = sha256Buffer(Buffer.from('test'));
    expect(a).toBe(b);
  });

  it('returns different hashes for different input', () => {
    const a = sha256Buffer(Buffer.from('photo1'));
    const b = sha256Buffer(Buffer.from('photo2'));
    expect(a).not.toBe(b);
  });

  it('produces a 64-character hex string', () => {
    const hash = sha256Buffer(Buffer.from('data'));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('sha256Stream', () => {
  it('returns hex-encoded SHA-256 of a stream', async () => {
    const data = Buffer.from('hello world');
    const stream = Readable.from([data]);
    const expected = createHash('sha256').update(data).digest('hex');
    expect(await sha256Stream(stream)).toBe(expected);
  });

  it('handles multi-chunk streams', async () => {
    const chunks = [Buffer.from('chunk1'), Buffer.from('chunk2'), Buffer.from('chunk3')];
    const stream = Readable.from(chunks);
    const expected = createHash('sha256')
      .update(Buffer.concat(chunks))
      .digest('hex');
    expect(await sha256Stream(stream)).toBe(expected);
  });

  it('matches sha256Buffer for same data', async () => {
    const data = Buffer.from('identical-content');
    const bufferHash = sha256Buffer(data);
    const streamHash = await sha256Stream(Readable.from([data]));
    expect(streamHash).toBe(bufferHash);
  });

  it('rejects on stream error', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('read failure'));
      },
    });
    await expect(sha256Stream(stream)).rejects.toThrow('read failure');
  });
});
