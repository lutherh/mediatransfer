import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadService } from '../types.js';
import { registerUploadRoutes } from './uploads.js';

vi.mock('../../utils/exif.js', () => ({
  extractExifMetadata: vi.fn(async () => ({
    capturedAt: new Date('2024-05-10T12:00:00.000Z'),
    width: 100,
    height: 80,
  })),
  inferDateFromFilename: vi.fn(() => null),
}));

function buildMultipartBody(filename: string, content: string, boundary: string): Buffer {
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([
    Buffer.from(head, 'utf8'),
    Buffer.from(content, 'utf8'),
    Buffer.from(tail, 'utf8'),
  ]);
}

function createUploadService(): UploadService {
  return {
    findByHash: vi.fn(async () => null),
    createMediaItem: vi.fn(async (input) => ({
      id: 'media-1',
      filename: input.filename,
      s3Key: input.s3Key,
      sha256: input.sha256,
      size: input.size,
      contentType: input.contentType,
      width: input.width ?? null,
      height: input.height ?? null,
      capturedAt: input.capturedAt ?? null,
      source: input.source,
      uploadedAt: new Date('2025-01-01T00:00:00.000Z'),
    })),
    listMediaItems: vi.fn(async () => []),
    countMediaItems: vi.fn(async () => 3),
    uploadToStorage: vi.fn(async (_key: string, stream: Readable) => {
      stream.resume();
      await new Promise<void>((resolve, reject) => {
        stream.once('end', () => resolve());
        stream.once('error', reject);
      });
    }),
  };
}

describe('upload routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 503 for uploads endpoints when service is unavailable', async () => {
    const app = Fastify();
    await registerUploadRoutes(app, undefined);

    const postRes = await app.inject({ method: 'POST', url: '/uploads' });
    const listRes = await app.inject({ method: 'GET', url: '/uploads' });
    const statsRes = await app.inject({ method: 'GET', url: '/uploads/stats' });

    expect(postRes.statusCode).toBe(503);
    expect(listRes.statusCode).toBe(503);
    expect(statsRes.statusCode).toBe(503);

    await app.close();
  });

  it('uploads multipart file and returns uploaded summary', async () => {
    const uploads = createUploadService();
    const app = Fastify();
    await registerUploadRoutes(app, uploads);

    const boundary = '----mediatransfer-boundary';
    const payload = buildMultipartBody('photo.jpg', 'image-content', boundary);

    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      payload,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({ total: 1, uploaded: 1, duplicates: 0, errors: 0 });
    expect(uploads.findByHash).toHaveBeenCalledOnce();
    expect(uploads.uploadToStorage).toHaveBeenCalledOnce();
    expect(uploads.createMediaItem).toHaveBeenCalledOnce();

    await app.close();
  });

  it('returns duplicate result when file hash already exists', async () => {
    const uploads = createUploadService();
    vi.mocked(uploads.findByHash).mockResolvedValueOnce({
      id: 'existing-1',
      filename: 'existing.jpg',
      s3Key: '2024/05/10/existing.jpg',
      sha256: 'abc',
      size: 10,
      contentType: 'image/jpeg',
      width: null,
      height: null,
      capturedAt: null,
      source: 'upload',
      uploadedAt: new Date('2025-01-01T00:00:00.000Z'),
    });

    const app = Fastify();
    await registerUploadRoutes(app, uploads);

    const boundary = '----mediatransfer-duplicate';
    const payload = buildMultipartBody('photo.jpg', 'duplicate-content', boundary);

    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      payload,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({ total: 1, uploaded: 0, duplicates: 1, errors: 0 });
    expect(uploads.uploadToStorage).not.toHaveBeenCalled();
    expect(uploads.createMediaItem).not.toHaveBeenCalled();

    await app.close();
  });

  it('lists and paginates uploaded items', async () => {
    const uploads = createUploadService();
    const app = Fastify();
    await registerUploadRoutes(app, uploads);

    const res = await app.inject({
      method: 'GET',
      url: '/uploads?limit=999&offset=-5&source=upload',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(200);
    expect(res.json().offset).toBe(0);
    expect(uploads.listMediaItems).toHaveBeenCalledWith({ source: 'upload' }, 200, 0);
    expect(uploads.countMediaItems).toHaveBeenCalled();

    await app.close();
  });
});
