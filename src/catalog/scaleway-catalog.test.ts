import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ScalewayCatalogService, decodeKey, encodeKey } from './scaleway-catalog.js';

describe('scaleway catalog service', () => {
  it('encodes and decodes keys symmetrically', () => {
    const key = 'photos/by-hash/00/24/00243b6e3e8e28a78e11ce7a8f78a0253eadb1f70794f7b3e338164ca9c700af.HEIC';
    const encoded = encodeKey(key);

    expect(decodeKey(encoded)).toBe(key);
  });

  it('falls back content type from extension when object metadata is missing', async () => {
    const send = vi.fn(async () => ({
      Body: Readable.from([Buffer.from('ok')]),
      ContentType: undefined,
    }));

    const service = new ScalewayCatalogService(
      {
        region: 'nl-ams',
        bucket: 'media',
        accessKey: 'access',
        secretKey: 'secret',
      },
      { send } as any,
    );

    const media = await service.getObject(encodeKey('2026/02/20/photo.HEIC'));

    expect(media.contentType).toBe('image/heic');
  });

  it('keeps storage content type when provided', async () => {
    const send = vi.fn(async () => ({
      Body: Readable.from([Buffer.from('ok')]),
      ContentType: 'image/jpeg',
    }));

    const service = new ScalewayCatalogService(
      {
        region: 'nl-ams',
        bucket: 'media',
        accessKey: 'access',
        secretKey: 'secret',
      },
      { send } as any,
    );

    const media = await service.getObject(encodeKey('2026/02/20/photo.jpg'));

    expect(media.contentType).toBe('image/jpeg');
  });
});
