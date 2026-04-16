import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('@aws-sdk/lib-storage', () => {
  class MockUpload {
    constructor(params: unknown) {
      lastUploadParams = params;
    }
    done = mockUploadDone;
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
