import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { OAuth2Client } from 'google-auth-library';
import { GooglePhotosProvider, type Fetcher } from './google-photos.js';
import type { GoogleTokens } from './google-photos-auth.js';

// ── Mock auth module ────────────────────────────────────────────

vi.mock('./google-photos-auth.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTokenExpired: vi.fn().mockReturnValue(false),
    getValidAccessToken: vi.fn().mockResolvedValue({
      accessToken: 'refreshed-token',
      refreshToken: 'refresh',
      expiryDate: Date.now() + 3600_000,
    }),
  };
});

// ── Helpers ─────────────────────────────────────────────────────

const validTokens: GoogleTokens = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  expiryDate: Date.now() + 3600_000,
};

const mockClient = {} as OAuth2Client;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function streamResponse(data: string, status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    body: stream,
    headers: new Headers(),
    text: () => Promise.resolve(data),
  } as unknown as Response;
}

const rawAlbum = (id: string, title: string, count: string) => ({
  id,
  title,
  mediaItemsCount: count,
  coverPhotoBaseUrl: `https://photos.google.com/cover/${id}`,
});

const rawMediaItem = (id: string, filename: string, mime = 'image/jpeg') => ({
  id,
  filename,
  mimeType: mime,
  mediaMetadata: {
    creationTime: '2026-01-15T10:30:00Z',
    width: '4032',
    height: '3024',
  },
  baseUrl: `https://photos.google.com/media/${id}`,
});

// ── Tests ───────────────────────────────────────────────────────

describe('GooglePhotosProvider', () => {
  let fetcher: ReturnType<typeof vi.fn>;
  let provider: GooglePhotosProvider;

  beforeEach(() => {
    fetcher = vi.fn();
    provider = new GooglePhotosProvider(mockClient, validTokens, fetcher as Fetcher);
  });

  it('should have the correct name', () => {
    expect(provider.name).toBe('Google Photos');
  });

  // ── listAlbums ────────────────────────────────────────

  describe('listAlbums', () => {
    it('should fetch albums from the API', async () => {
      fetcher.mockResolvedValue(
        jsonResponse({
          albums: [rawAlbum('a1', 'Vacation', '42'), rawAlbum('a2', 'Family', '10')],
          nextPageToken: undefined,
        }),
      );

      const result = await provider.listAlbums();

      expect(fetcher).toHaveBeenCalledOnce();
      const [url, opts] = fetcher.mock.calls[0];
      expect(url).toContain('/albums?');
      expect(opts.headers.Authorization).toBe('Bearer test-access-token');

      expect(result.albums).toHaveLength(2);
      expect(result.albums[0]).toEqual({
        id: 'a1',
        title: 'Vacation',
        mediaItemsCount: 42,
        coverPhotoBaseUrl: 'https://photos.google.com/cover/a1',
      });
      expect(result.nextPageToken).toBeUndefined();
    });

    it('should pass pageToken for pagination', async () => {
      fetcher.mockResolvedValue(jsonResponse({ albums: [] }));

      await provider.listAlbums('next-page-tok');

      const [url] = fetcher.mock.calls[0];
      expect(url).toContain('pageToken=next-page-tok');
    });

    it('should return empty array when no albums exist', async () => {
      fetcher.mockResolvedValue(jsonResponse({}));

      const result = await provider.listAlbums();
      expect(result.albums).toEqual([]);
    });

    it('should propagate API errors', async () => {
      fetcher.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));

      await expect(provider.listAlbums()).rejects.toThrow(
        /Google Photos API error 401/,
      );
    });
  });

  // ── listMediaItems ────────────────────────────────────

  describe('listMediaItems', () => {
    it('should list all media items with GET when no albumId', async () => {
      fetcher.mockResolvedValue(
        jsonResponse({
          mediaItems: [rawMediaItem('m1', 'IMG_001.jpg')],
          nextPageToken: 'tok2',
        }),
      );

      const result = await provider.listMediaItems();

      const [url, opts] = fetcher.mock.calls[0];
      expect(url).toContain('/mediaItems?');
      expect(opts.headers.Authorization).toBe('Bearer test-access-token');

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('m1');
      expect(result.items[0].filename).toBe('IMG_001.jpg');
      expect(result.items[0].width).toBe(4032);
      expect(result.items[0].height).toBe(3024);
      expect(result.items[0].createdAt).toEqual(new Date('2026-01-15T10:30:00Z'));
      expect(result.nextPageToken).toBe('tok2');
    });

    it('should use POST /mediaItems:search when albumId is provided', async () => {
      fetcher.mockResolvedValue(
        jsonResponse({ mediaItems: [rawMediaItem('m2', 'IMG_002.jpg')] }),
      );

      await provider.listMediaItems({ albumId: 'album-123' });

      const [url, opts] = fetcher.mock.calls[0];
      expect(url).toContain('/mediaItems:search');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body as string);
      expect(body.albumId).toBe('album-123');
    });

    it('should respect maxResults (capped at 100)', async () => {
      fetcher.mockResolvedValue(jsonResponse({ mediaItems: [] }));

      await provider.listMediaItems({ maxResults: 200 });

      const [url] = fetcher.mock.calls[0];
      expect(url).toContain('pageSize=100');
    });

    it('should pass pageToken for pagination', async () => {
      fetcher.mockResolvedValue(jsonResponse({ mediaItems: [] }));

      await provider.listMediaItems({ pageToken: 'page2' });

      const [url] = fetcher.mock.calls[0];
      expect(url).toContain('pageToken=page2');
    });

    it('should return empty items when API returns no mediaItems', async () => {
      fetcher.mockResolvedValue(jsonResponse({}));

      const result = await provider.listMediaItems();
      expect(result.items).toEqual([]);
    });
  });

  // ── getMediaItem ──────────────────────────────────────

  describe('getMediaItem', () => {
    it('should fetch a single media item by ID', async () => {
      fetcher.mockResolvedValue(
        jsonResponse(rawMediaItem('m1', 'photo.jpg')),
      );

      const item = await provider.getMediaItem('m1');

      const [url] = fetcher.mock.calls[0];
      expect(url).toContain('/mediaItems/m1');
      expect(item.id).toBe('m1');
      expect(item.mimeType).toBe('image/jpeg');
    });

    it('should throw on API error', async () => {
      fetcher.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));

      await expect(provider.getMediaItem('bad-id')).rejects.toThrow(
        /Google Photos API error 404/,
      );
    });
  });

  // ── downloadMedia ─────────────────────────────────────

  describe('downloadMedia', () => {
    it('should download an image with =d suffix', async () => {
      // First call: getMediaItem
      fetcher.mockResolvedValueOnce(
        jsonResponse(rawMediaItem('m1', 'photo.jpg', 'image/jpeg')),
      );
      // Second call: download
      fetcher.mockResolvedValueOnce(streamResponse('binary-image-data'));

      const stream = await provider.downloadMedia('m1');
      expect(stream).toBeInstanceOf(Readable);

      // Verify the download URL used =d for images
      const [downloadUrl] = fetcher.mock.calls[1];
      expect(downloadUrl).toBe('https://photos.google.com/media/m1=d');
    });

    it('should download a video with =dv suffix', async () => {
      fetcher.mockResolvedValueOnce(
        jsonResponse(rawMediaItem('v1', 'video.mp4', 'video/mp4')),
      );
      fetcher.mockResolvedValueOnce(streamResponse('binary-video-data'));

      await provider.downloadMedia('v1');

      const [downloadUrl] = fetcher.mock.calls[1];
      expect(downloadUrl).toBe('https://photos.google.com/media/v1=dv');
    });

    it('should throw when download response is not ok', async () => {
      fetcher.mockResolvedValueOnce(
        jsonResponse(rawMediaItem('m1', 'photo.jpg')),
      );
      fetcher.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      } as unknown as Response);

      await expect(provider.downloadMedia('m1')).rejects.toThrow(
        /Failed to download media "m1": HTTP 403/,
      );
    });

    it('should throw when download response body is empty', async () => {
      fetcher.mockResolvedValueOnce(
        jsonResponse(rawMediaItem('m1', 'photo.jpg')),
      );
      fetcher.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
      } as unknown as Response);

      await expect(provider.downloadMedia('m1')).rejects.toThrow(
        /Empty response body/,
      );
    });
  });

  // ── Token refresh ─────────────────────────────────────

  describe('token refresh', () => {
    it('should use existing token when not expired', async () => {
      const { isTokenExpired } = await import('./google-photos-auth.js');
      (isTokenExpired as ReturnType<typeof vi.fn>).mockReturnValue(false);

      fetcher.mockResolvedValue(jsonResponse({ albums: [] }));

      await provider.listAlbums();

      const [, opts] = fetcher.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer test-access-token');
    });

    it('should refresh token when expired', async () => {
      const { isTokenExpired } = await import('./google-photos-auth.js');
      (isTokenExpired as ReturnType<typeof vi.fn>).mockReturnValue(true);

      fetcher.mockResolvedValue(jsonResponse({ albums: [] }));

      await provider.listAlbums();

      const [, opts] = fetcher.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer refreshed-token');
    });
  });
});
