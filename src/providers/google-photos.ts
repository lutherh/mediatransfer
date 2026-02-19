import { Readable } from 'node:stream';
import type { OAuth2Client } from 'google-auth-library';
import type {
  PhotosProvider,
  Album,
  MediaItem,
  ListMediaItemsOptions,
  MediaItemsPage,
  AlbumsPage,
} from './photos-types.js';
import { getValidAccessToken, isTokenExpired, type GoogleTokens } from './google-photos-auth.js';

// ── API base URL ────────────────────────────────────────────────

const API_BASE = 'https://photoslibrary.googleapis.com/v1';

// ── Raw API response shapes ─────────────────────────────────────

/** Raw album from the Google Photos API. */
type RawAlbum = {
  id: string;
  title: string;
  mediaItemsCount?: string; // API returns as string
  coverPhotoBaseUrl?: string;
};

/** Raw media item from the Google Photos API. */
type RawMediaItem = {
  id: string;
  filename: string;
  mimeType: string;
  mediaMetadata: {
    creationTime: string;
    width: string;
    height: string;
    photo?: Record<string, unknown>;
    video?: Record<string, unknown>;
  };
  baseUrl: string;
};

// ── Fetcher type (for dependency injection / testing) ───────────

/**
 * A fetch-like function. Defaults to global `fetch` but can be
 * replaced in tests with a mock.
 */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

// ── Provider implementation ─────────────────────────────────────

export class GooglePhotosProvider implements PhotosProvider {
  readonly name = 'Google Photos';

  private readonly client: OAuth2Client;
  private tokens: GoogleTokens;
  private readonly fetcher: Fetcher;

  constructor(client: OAuth2Client, tokens: GoogleTokens, fetcher?: Fetcher) {
    this.client = client;
    this.tokens = tokens;
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis);
  }

  // ── Auth helpers ────────────────────────────────────────

  /**
   * Get a valid access token, refreshing if expired.
   */
  private async getAccessToken(): Promise<string> {
    if (isTokenExpired(this.tokens)) {
      this.tokens = await getValidAccessToken(this.client);
    }
    return this.tokens.accessToken;
  }

  /**
   * Make an authenticated GET request to the Google Photos API.
   */
  private async apiGet(path: string): Promise<unknown> {
    const token = await this.getAccessToken();
    const response = await this.fetcher(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Google Photos API error ${response.status}: ${body}`,
      );
    }

    return response.json();
  }

  /**
   * Make an authenticated POST request to the Google Photos API.
   */
  private async apiPost(path: string, body: unknown): Promise<unknown> {
    const token = await this.getAccessToken();
    const response = await this.fetcher(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Google Photos API error ${response.status}: ${text}`,
      );
    }

    return response.json();
  }

  // ── PhotosProvider implementation ──────────────────────

  async listAlbums(pageToken?: string): Promise<AlbumsPage> {
    const params = new URLSearchParams({ pageSize: '50' });
    if (pageToken) params.set('pageToken', pageToken);

    const data = (await this.apiGet(`/albums?${params.toString()}`)) as {
      albums?: RawAlbum[];
      nextPageToken?: string;
    };

    return {
      albums: (data.albums ?? []).map(parseAlbum),
      nextPageToken: data.nextPageToken,
    };
  }

  async listMediaItems(options?: ListMediaItemsOptions): Promise<MediaItemsPage> {
    const pageSize = Math.min(options?.maxResults ?? 100, 100); // API max is 100

    if (options?.albumId) {
      // Album-scoped search uses POST /mediaItems:search
      const body: Record<string, unknown> = {
        albumId: options.albumId,
        pageSize,
      };
      if (options?.pageToken) body.pageToken = options.pageToken;

      const data = (await this.apiPost('/mediaItems:search', body)) as {
        mediaItems?: RawMediaItem[];
        nextPageToken?: string;
      };

      return {
        items: (data.mediaItems ?? []).map(parseMediaItem),
        nextPageToken: data.nextPageToken,
      };
    }

    // Library-wide listing uses GET /mediaItems
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (options?.pageToken) params.set('pageToken', options.pageToken);

    const data = (await this.apiGet(`/mediaItems?${params.toString()}`)) as {
      mediaItems?: RawMediaItem[];
      nextPageToken?: string;
    };

    return {
      items: (data.mediaItems ?? []).map(parseMediaItem),
      nextPageToken: data.nextPageToken,
    };
  }

  async getMediaItem(id: string): Promise<MediaItem> {
    const data = (await this.apiGet(`/mediaItems/${id}`)) as RawMediaItem;
    return parseMediaItem(data);
  }

  async downloadMedia(mediaItemId: string): Promise<Readable> {
    const item = await this.getMediaItem(mediaItemId);

    // For videos, append =dv for download; for images, append =d for original
    const isVideo = item.mimeType.startsWith('video/');
    const downloadUrl = isVideo
      ? `${item.baseUrl}=dv`
      : `${item.baseUrl}=d`;

    const token = await this.getAccessToken();
    const response = await this.fetcher(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download media "${mediaItemId}": HTTP ${response.status}`,
      );
    }

    if (!response.body) {
      throw new Error(`Empty response body for media "${mediaItemId}"`);
    }

    // Convert the web ReadableStream to a Node.js Readable
    return Readable.fromWeb(response.body);
  }
}

// ── Parsers ─────────────────────────────────────────────────────

function parseAlbum(raw: RawAlbum): Album {
  return {
    id: raw.id,
    title: raw.title,
    mediaItemsCount: Number(raw.mediaItemsCount ?? '0'),
    coverPhotoBaseUrl: raw.coverPhotoBaseUrl,
  };
}

function parseMediaItem(raw: RawMediaItem): MediaItem {
  return {
    id: raw.id,
    filename: raw.filename,
    mimeType: raw.mimeType,
    createdAt: new Date(raw.mediaMetadata.creationTime),
    width: Number(raw.mediaMetadata.width),
    height: Number(raw.mediaMetadata.height),
    baseUrl: raw.baseUrl,
  };
}
