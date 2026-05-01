import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  ScalewayProvider,
  resolveScalewayEndpoint,
  resolveScalewaySigningRegion,
  validateScalewayConfig,
  createScalewayProvider,
  type ScalewayConfig,
} from './scaleway.js';
import type { ProviderConfig } from './types.js';

// ── Mock @aws-sdk/lib-storage ──────────────────────────────────

const mockUploadDone = vi.fn().mockResolvedValue({});
let lastUploadParams: unknown = null;
interface MockUploadInstance {
  on: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  done: typeof mockUploadDone;
}
let lastMockUpload: MockUploadInstance | null = null;

vi.mock('@aws-sdk/lib-storage', () => {
  class MockUpload {
    on = vi.fn();
    abort = vi.fn().mockResolvedValue(undefined);
    done = mockUploadDone;
    constructor(params: unknown) {
      lastUploadParams = params;
      lastMockUpload = this as unknown as MockUploadInstance;
    }
    // Real `Upload` from @aws-sdk/lib-storage extends EventEmitter and
    // exposes an `abort()` method. The stall watchdog in
    // ScalewayProvider.upload() calls both, so the mock must satisfy them.
  }
  return { Upload: MockUpload };
});

// ── Mock S3Client ──────────────────────────────────────────────

function createMockS3Client() {
  return {
    send: vi.fn(),
  } as unknown as S3Client;
}

function validConfig(overrides?: Partial<ScalewayConfig>): ScalewayConfig {
  return {
    provider: 'scaleway',
    region: 'fr-par',
    bucket: 'my-bucket',
    accessKey: 'SCWXXXXXXXXXXXXXXXXX',
    secretKey: 'secret-key-value',
    ...overrides,
  };
}

// ── resolveScalewayEndpoint ────────────────────────────────────

describe('resolveScalewayEndpoint', () => {
  it('should resolve fr-par to the correct endpoint', () => {
    expect(resolveScalewayEndpoint('fr-par')).toBe('https://s3.fr-par.scw.cloud');
  });

  it('should resolve nl-ams to the correct endpoint', () => {
    expect(resolveScalewayEndpoint('nl-ams')).toBe('https://s3.nl-ams.scw.cloud');
  });

  it('should resolve pl-waw to the correct endpoint', () => {
    expect(resolveScalewayEndpoint('pl-waw')).toBe('https://s3.pl-waw.scw.cloud');
  });

  it('should be case-insensitive', () => {
    expect(resolveScalewayEndpoint('FR-PAR')).toBe('https://s3.fr-par.scw.cloud');
  });

  it('should accept a full HTTPS URL as-is', () => {
    const url = 'https://s3.custom-region.scw.cloud';
    expect(resolveScalewayEndpoint(url)).toBe(url);
  });

  it('should accept a full HTTP URL as-is', () => {
    const url = 'http://localhost:9000';
    expect(resolveScalewayEndpoint(url)).toBe(url);
  });

  it('should return undefined for an unknown region string (lets AWS SDK resolve endpoint)', () => {
    expect(resolveScalewayEndpoint('us-east-1')).toBeUndefined();
  });
});

// ── resolveScalewaySigningRegion ───────────────────────────────

describe('resolveScalewaySigningRegion', () => {
  it('should return region code when code is provided', () => {
    expect(resolveScalewaySigningRegion('nl-ams')).toBe('nl-ams');
  });

  it('should derive region from Scaleway endpoint URL', () => {
    expect(resolveScalewaySigningRegion('https://s3.nl-ams.scw.cloud')).toBe('nl-ams');
  });

  it('should fall back to hostname for non-Scaleway endpoint URL', () => {
    expect(resolveScalewaySigningRegion('https://example.com')).toBe('example.com');
  });
});

// ── validateScalewayConfig ─────────────────────────────────────

describe('validateScalewayConfig', () => {
  it('should accept a valid config', () => {
    const config: ProviderConfig = {
      provider: 'scaleway',
      region: 'fr-par',
      bucket: 'photos',
      accessKey: 'AK',
      secretKey: 'SK',
    };
    const result = validateScalewayConfig(config);
    expect(result.region).toBe('fr-par');
    expect(result.bucket).toBe('photos');
  });

  it('should set prefix to undefined when not provided', () => {
    const config: ProviderConfig = {
      provider: 'scaleway',
      region: 'fr-par',
      bucket: 'b',
      accessKey: 'AK',
      secretKey: 'SK',
    };
    expect(validateScalewayConfig(config).prefix).toBeUndefined();
  });

  it('should accept an optional prefix', () => {
    const config: ProviderConfig = {
      provider: 'scaleway',
      region: 'fr-par',
      bucket: 'b',
      accessKey: 'AK',
      secretKey: 'SK',
      prefix: 'media/photos',
    };
    expect(validateScalewayConfig(config).prefix).toBe('media/photos');
  });

  it.each(['region', 'bucket', 'accessKey', 'secretKey'])(
    'should throw when "%s" is missing',
    (field) => {
      const config: ProviderConfig = {
        provider: 'scaleway',
        region: 'fr-par',
        bucket: 'b',
        accessKey: 'AK',
        secretKey: 'SK',
      };
      delete (config as Record<string, unknown>)[field];
      expect(() => validateScalewayConfig(config)).toThrow(
        new RegExp(`"${field}" is required`),
      );
    },
  );
});

// ── ScalewayProvider ───────────────────────────────────────────

describe('ScalewayProvider', () => {
  let mockClient: ReturnType<typeof createMockS3Client>;

  beforeEach(() => {
    mockClient = createMockS3Client();
    mockUploadDone.mockClear();
    lastUploadParams = null;
  });

  function createProvider(overrides?: Partial<ScalewayConfig>) {
    return new ScalewayProvider(validConfig(overrides), mockClient);
  }

  // ── name ──────────────────────────────────────────────

  it('should have the correct name', () => {
    const provider = createProvider();
    expect(provider.name).toBe('Scaleway Object Storage');
  });

  // ── list ──────────────────────────────────────────────

  describe('list', () => {
    it('should list objects from the bucket', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({
        Contents: [
          { Key: 'photo1.jpg', Size: 1024, LastModified: new Date('2026-01-01') },
          { Key: 'photo2.jpg', Size: 2048, LastModified: new Date('2026-01-02') },
        ],
        IsTruncated: false,
      });

      const provider = createProvider();
      const result = await provider.list();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        key: 'photo1.jpg',
        size: 1024,
        lastModified: new Date('2026-01-01'),
        contentType: undefined,
      });
    });

    it('should apply prefix from options', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({ Contents: [], IsTruncated: false });

      const provider = createProvider();
      await provider.list({ prefix: 'photos/' });

      const input = send.mock.calls[0][0].input;
      expect(input.Prefix).toBe('photos/');
    });

    it('should combine provider prefix with list prefix', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({ Contents: [], IsTruncated: false });

      const provider = createProvider({ prefix: 'media' });
      await provider.list({ prefix: '2026/' });

      const input = send.mock.calls[0][0].input;
      expect(input.Prefix).toBe('media/2026/');
    });

    it('should strip provider prefix from returned keys', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({
        Contents: [
          { Key: 'media/photo1.jpg', Size: 100, LastModified: new Date() },
        ],
        IsTruncated: false,
      });

      const provider = createProvider({ prefix: 'media' });
      const result = await provider.list();

      expect(result[0].key).toBe('photo1.jpg');
    });

    it('should handle pagination', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;

      // First page
      send.mockResolvedValueOnce({
        Contents: [{ Key: 'a.jpg', Size: 1, LastModified: new Date() }],
        IsTruncated: true,
        NextContinuationToken: 'token-2',
      });

      // Second page
      send.mockResolvedValueOnce({
        Contents: [{ Key: 'b.jpg', Size: 2, LastModified: new Date() }],
        IsTruncated: false,
      });

      const provider = createProvider();
      const result = await provider.list();

      expect(result).toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('should respect maxResults', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({
        Contents: [
          { Key: 'a.jpg', Size: 1, LastModified: new Date() },
          { Key: 'b.jpg', Size: 2, LastModified: new Date() },
          { Key: 'c.jpg', Size: 3, LastModified: new Date() },
        ],
        IsTruncated: false,
      });

      const provider = createProvider();
      const result = await provider.list({ maxResults: 2 });

      expect(result).toHaveLength(2);
    });

    it('should return empty array when bucket is empty', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({ Contents: undefined, IsTruncated: false });

      const provider = createProvider();
      const result = await provider.list();

      expect(result).toEqual([]);
    });
  });

  // ── download ──────────────────────────────────────────

  describe('download', () => {
    it('should return a readable stream for the given key', async () => {
      const bodyStream = Readable.from(Buffer.from('file-content'));
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({ Body: bodyStream });

      const provider = createProvider();
      const result = await provider.download('photo.jpg');

      expect(result).toBeInstanceOf(Readable);

      const input = send.mock.calls[0][0].input;
      expect(input.Bucket).toBe('my-bucket');
      expect(input.Key).toBe('photo.jpg');
    });

    it('should prepend prefix to the download key', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({ Body: Readable.from(Buffer.from('x')) });

      const provider = createProvider({ prefix: 'media' });
      await provider.download('photo.jpg');

      const input = send.mock.calls[0][0].input;
      expect(input.Key).toBe('media/photo.jpg');
    });

    it('should throw when response body is empty', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({ Body: undefined });

      const provider = createProvider();
      await expect(provider.download('missing.jpg')).rejects.toThrow(
        /Empty response body/,
      );
    });
  });

  // ── upload ────────────────────────────────────────────

  describe('upload', () => {
    it('should upload a stream to the correct key', async () => {
      const provider = createProvider();
      const stream = Readable.from(Buffer.from('upload-data'));

      await provider.upload('dest/photo.jpg', stream, 'image/jpeg');

      expect(mockUploadDone).toHaveBeenCalled();
      const params = lastUploadParams as Record<string, unknown>;
      const s3Params = params.params as Record<string, unknown>;
      expect(s3Params.Bucket).toBe('my-bucket');
      expect(s3Params.Key).toBe('dest/photo.jpg');
      expect(s3Params.ContentType).toBe('image/jpeg');
    });

    it('should prepend prefix to the upload key', async () => {
      const provider = createProvider({ prefix: 'backup' });
      const stream = Readable.from(Buffer.from('data'));

      await provider.upload('photo.jpg', stream);

      const params = lastUploadParams as Record<string, unknown>;
      const s3Params = params.params as Record<string, unknown>;
      expect(s3Params.Key).toBe('backup/photo.jpg');
    });
  });

  // ── delete ────────────────────────────────────────────

  describe('delete', () => {
    it('should delete the object with the correct key', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({});

      const provider = createProvider();
      await provider.delete('photo.jpg');

      const input = send.mock.calls[0][0].input;
      expect(input.Bucket).toBe('my-bucket');
      expect(input.Key).toBe('photo.jpg');
    });

    it('should prepend prefix to the delete key', async () => {
      const send = mockClient.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValue({});

      const provider = createProvider({ prefix: 'media' });
      await provider.delete('photo.jpg');

      const input = send.mock.calls[0][0].input;
      expect(input.Key).toBe('media/photo.jpg');
    });
  });
});

// ── createScalewayProvider factory ────────────────────────────

describe('createScalewayProvider', () => {
  it('should create a ScalewayProvider from valid config', () => {
    const provider = createScalewayProvider({
      provider: 'scaleway',
      region: 'fr-par',
      bucket: 'photos',
      accessKey: 'AK',
      secretKey: 'SK',
    });
    expect(provider.name).toBe('Scaleway Object Storage');
  });

  it('should throw for invalid config', () => {
    expect(() =>
      createScalewayProvider({ provider: 'scaleway' }),
    ).toThrow(/"region" is required/);
  });
});

// ── upload stall watchdog ──────────────────────────────────────
//
// ScalewayProvider.upload() installs a stall watchdog that samples
// bytesObserved every STALL_CHECK_INTERVAL_MS (30s) and calls
// upload.abort() if no socket-level bytes flowed for STALL_TIMEOUT_MS
// (5 min). These tests drive that behaviour using fake timers and a
// controllable `done()` deferred so we can hold the upload in flight
// while inspecting the watchdog.

describe('upload stall watchdog', () => {
  let mockClient: ReturnType<typeof createMockS3Client>;
  let resolveDone: (() => void) | null = null;
  let rejectDone: ((err: unknown) => void) | null = null;

  function makeDeferredDone(): void {
    mockUploadDone.mockImplementationOnce(
      () =>
        new Promise<void>((res, rej) => {
          resolveDone = (): void => res();
          rejectDone = rej;
        }),
    );
  }

  function createProvider(overrides?: Partial<ScalewayConfig>): ScalewayProvider {
    return new ScalewayProvider(validConfig(overrides), mockClient);
  }

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    mockClient = createMockS3Client();
    lastMockUpload = null;
    lastUploadParams = null;
    resolveDone = null;
    rejectDone = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore default behaviour for tests in other files / blocks.
    mockUploadDone.mockReset();
    mockUploadDone.mockResolvedValue({});
  });

  it('does not abort when stream emits data within the stall window', async () => {
    makeDeferredDone();
    const provider = createProvider();
    const stream = new Readable({ read() {} });
    const uploadPromise = provider.upload('keep-alive.bin', stream);

    // Push 64 KiB every simulated minute for 6 minutes (well past the
    // 5-minute stall threshold). Because each push resets the watchdog
    // via the 30s sampling interval, abort must not fire.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      stream.push(Buffer.alloc(64 * 1024));
      // Flush the 'data' emission scheduled by Readable.push().
      await Promise.resolve();
      await Promise.resolve();
    }

    resolveDone!();
    await uploadPromise;

    expect(lastMockUpload!.abort).not.toHaveBeenCalled();
  });

  it('aborts upload when stream is silent past STALL_TIMEOUT_MS', async () => {
    makeDeferredDone();
    const provider = createProvider();
    const stream = new Readable({ read() {} });
    const uploadPromise = provider.upload('silent.bin', stream);
    // Attach the rejection handler immediately — `await advanceTimers...`
    // synchronously rejects done() before we get a chance to await
    // uploadPromise, which would otherwise surface as a transient
    // unhandled rejection in the test runner.
    const settled = uploadPromise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await Promise.resolve();

    // Mirror real lib-storage semantics: abort() rejects done() so the
    // upload promise settles and the watchdog interval gets cleared.
    lastMockUpload!.abort.mockImplementationOnce(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      rejectDone!(err);
    });

    // Advance 6 minutes — first stall detection fires at the 30s tick
    // after t = 5 min (i.e. t = 5m30s); abort must be called exactly
    // once because the abort path settles done() and the finally clears
    // the interval before any subsequent tick can re-trigger.
    await vi.advanceTimersByTimeAsync(360_000);

    expect(lastMockUpload!.abort).toHaveBeenCalledTimes(1);
    const result = await settled;
    expect(result.ok).toBe(false);
    expect((result as { err: Error }).err).toBeInstanceOf(Error);
    expect((result as { err: Error }).err.message).toMatch(/aborted/);
  });

  it('does not abort when bytes flow within the stall window', async () => {
    makeDeferredDone();
    const provider = createProvider();
    const stream = new Readable({ read() {} });
    const uploadPromise = provider.upload('flow.bin', stream);
    await Promise.resolve();

    // 4 minutes of silence (still under 5-minute threshold).
    await vi.advanceTimersByTimeAsync(240_000);
    stream.push(Buffer.alloc(64 * 1024));
    await Promise.resolve();
    await Promise.resolve();
    // Let at least one 30s sampling tick observe the new bytes and
    // reset lastProgressAt.
    await vi.advanceTimersByTimeAsync(30_000);
    // Another 4 minutes — total elapsed since reset is < 5 min.
    await vi.advanceTimersByTimeAsync(240_000);

    expect(lastMockUpload!.abort).not.toHaveBeenCalled();

    resolveDone!();
    await uploadPromise;
  });

  it('swallows errors thrown by upload.abort() during a stall', async () => {
    makeDeferredDone();
    const provider = createProvider();
    const stream = new Readable({ read() {} });
    const uploadPromise = provider.upload('boom.bin', stream);
    await Promise.resolve();

    // abort() itself rejects — the watchdog uses `.catch()` so this must
    // not surface as an unhandled rejection or throw out of upload().
    lastMockUpload!.abort.mockRejectedValueOnce(new Error('boom'));

    // Trigger the stall (advance well past STALL_TIMEOUT_MS).
    await vi.advanceTimersByTimeAsync(360_000);

    expect(lastMockUpload!.abort).toHaveBeenCalled();

    // Settle done() so the outer upload promise resolves cleanly. If the
    // abort rejection had escaped, this await would reject too.
    resolveDone!();
    await expect(uploadPromise).resolves.toBeUndefined();
  });

  it('clears the watchdog interval on successful upload', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    // Default fast-resolve path: done() resolves on the next microtask,
    // upload() returns, finally{} clears the interval.
    mockUploadDone.mockResolvedValueOnce({} as never);

    const provider = createProvider();
    const stream = new Readable({ read() {} });
    await provider.upload('quick.bin', stream);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const intervalId = setIntervalSpy.mock.results[0]!.value;
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);

    // After clearing, advancing time must not produce any abort call —
    // proves the interval is gone, not just that abort happened to be
    // skipped by the `completed` guard.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(lastMockUpload!.abort).not.toHaveBeenCalled();
  });
});
