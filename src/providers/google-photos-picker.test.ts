import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuth2Client } from 'google-auth-library';
import { GooglePhotosPickerClient, type Fetcher } from './google-photos-picker.js';
import type { GoogleTokens } from './google-photos-auth.js';

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

const validTokens: GoogleTokens = {
  accessToken: 'picker-access-token',
  refreshToken: 'picker-refresh-token',
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

function textResponse(body: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(JSON.parse(body)),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('GooglePhotosPickerClient', () => {
  let fetcher: ReturnType<typeof vi.fn>;
  let client: GooglePhotosPickerClient;

  beforeEach(() => {
    fetcher = vi.fn();
    client = new GooglePhotosPickerClient(mockClient, validTokens, fetcher as Fetcher);
  });

  it('creates a picker session', async () => {
    fetcher.mockResolvedValue(
      jsonResponse({
        id: 'sessions/abc123',
        pickerUri: 'https://photos.google.com/picker/sessions/abc123',
        mediaItemsSet: false,
        pollingConfig: { pollInterval: '3s', timeoutIn: '120s' },
      }),
    );

    const session = await client.createSession();

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://photospicker.googleapis.com/v1/sessions');
    expect(init.method).toBe('POST');
    expect(session.id).toBe('sessions/abc123');
    expect(session.mediaItemsSet).toBe(false);
  });

  it('creates session with requestId query parameter', async () => {
    fetcher.mockResolvedValue(
      jsonResponse({
        id: 'sessions/req',
        pickerUri: 'https://photos.google.com/picker/sessions/req',
        mediaItemsSet: false,
      }),
    );

    await client.createSession('11111111-1111-4111-8111-111111111111');
    const [url] = fetcher.mock.calls[0];
    expect(url).toContain('requestId=11111111-1111-4111-8111-111111111111');
  });

  it('gets a picker session', async () => {
    fetcher.mockResolvedValue(
      jsonResponse({
        id: 'sessions/get1',
        mediaItemsSet: true,
      }),
    );

    const result = await client.getSession('sessions/get1');
    expect(result.mediaItemsSet).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://photospicker.googleapis.com/v1/sessions/sessions%2Fget1',
    );
  });

  it('deletes a picker session', async () => {
    fetcher.mockResolvedValue(jsonResponse({}, 204));
    await client.deleteSession('sessions/del1');

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://photospicker.googleapis.com/v1/sessions/sessions%2Fdel1');
    expect(init.method).toBe('DELETE');
  });

  it('lists picked media items', async () => {
    fetcher.mockResolvedValue(
      jsonResponse({
        mediaItems: [
          {
            id: 'media/1',
            mediaFile: {
              baseUrl: 'https://lh3.googleusercontent.com/item1',
              mimeType: 'image/jpeg',
              filename: 'IMG_0001.jpg',
              createTime: '2026-01-01T00:00:00Z',
            },
          },
        ],
      }),
    );

    const page = await client.listPickedMediaItems('sessions/abc');
    const [url] = fetcher.mock.calls[0];

    expect(url).toContain('/mediaItems?');
    expect(url).toContain('sessionId=sessions%2Fabc');
    expect(page.mediaItems).toHaveLength(1);
    expect(page.mediaItems[0].id).toBe('media/1');
    expect(page.mediaItems[0].filename).toBe('IMG_0001.jpg');
  });

  it('gets picked media item by id', async () => {
    fetcher.mockResolvedValue(
      jsonResponse({
        id: 'media/2',
        mediaFile: {
          baseUrl: 'https://lh3.googleusercontent.com/item2',
          mimeType: 'video/mp4',
          filename: 'VID_0002.mp4',
          createTime: '2026-01-02T00:00:00Z',
        },
      }),
    );

    const item = await client.getPickedMediaItem('sessions/abc', 'media/2');
    const [url] = fetcher.mock.calls[0];

    expect(url).toContain('/mediaItems/media%2F2?');
    expect(url).toContain('sessionId=sessions%2Fabc');
    expect(item.mimeType).toBe('video/mp4');
  });

  it('maps createTime from fallback fields when mediaFile.createTime is missing', async () => {
    fetcher.mockResolvedValue(
      jsonResponse({
        mediaItems: [
          {
            id: 'media/3',
            createTime: '2025-12-13T10:20:30Z',
            mediaFile: {
              baseUrl: 'https://lh3.googleusercontent.com/item3',
              mimeType: 'image/heic',
              filename: 'IMG_6163.HEIC',
            },
          },
        ],
      }),
    );

    const page = await client.listPickedMediaItems('sessions/abc');
    expect(page.mediaItems[0].createTime).toBe('2025-12-13T10:20:30Z');
  });

  it('throws API errors with response body', async () => {
    fetcher.mockResolvedValue(
      textResponse('{"error":{"message":"forbidden"}}', 403),
    );

    await expect(client.getSession('sessions/fail')).rejects.toThrow(
      'Google Photos Picker API error 403',
    );
  });

  it('throws on invalid session response', async () => {
    fetcher.mockResolvedValue(jsonResponse({ id: 'sessions/only-id' }));
    await expect(client.createSession()).rejects.toThrow(
      'Invalid Picker session response: missing pickerUri',
    );
  });
});
