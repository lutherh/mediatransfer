import type { OAuth2Client } from 'google-auth-library';
import {
  getValidAccessToken,
  isTokenExpired,
  type GoogleTokens,
} from './google-photos-auth.js';

const PICKER_API_BASE = 'https://photospicker.googleapis.com/v1';

export type PickerPollingConfig = {
  pollInterval?: string;
  timeoutIn?: string;
};

export type PickerSession = {
  id: string;
  pickerUri?: string;
  mediaItemsSet: boolean;
  pollingConfig?: PickerPollingConfig;
};

export type PickedMediaItem = {
  id: string;
  mimeType?: string;
  filename?: string;
  createTime?: string;
  baseUrl?: string;
};

export type PickedMediaItemsPage = {
  mediaItems: PickedMediaItem[];
  nextPageToken?: string;
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class GooglePhotosPickerClient {
  private readonly client: OAuth2Client;
  private tokens: GoogleTokens;
  private readonly fetcher: Fetcher;

  constructor(client: OAuth2Client, tokens: GoogleTokens, fetcher?: Fetcher) {
    this.client = client;
    this.tokens = tokens;
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis);
  }

  private async getAccessToken(): Promise<string> {
    if (isTokenExpired(this.tokens)) {
      this.tokens = await getValidAccessToken(this.client);
    }

    return this.tokens.accessToken;
  }

  private async apiRequest(
    path: string,
    init?: RequestInit,
  ): Promise<unknown> {
    const token = await this.getAccessToken();
    const response = await this.fetcher(`${PICKER_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Photos Picker API error ${response.status}: ${body}`);
    }

    if (response.status === 204) {
      return {};
    }

    return response.json();
  }

  async createSession(requestId?: string): Promise<PickerSession> {
    const query = requestId
      ? `?requestId=${encodeURIComponent(requestId)}`
      : '';

    const data = (await this.apiRequest(`/sessions${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })) as Partial<PickerSession>;

    return parseCreateSession(data);
  }

  async getSession(sessionId: string): Promise<PickerSession> {
    const data = (await this.apiRequest(`/sessions/${encodeURIComponent(sessionId)}`)) as Partial<PickerSession>;
    return parseSession(data);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.apiRequest(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  async listPickedMediaItems(
    sessionId: string,
    pageToken?: string,
    pageSize = 100,
  ): Promise<PickedMediaItemsPage> {
    const params = new URLSearchParams({
      sessionId,
      pageSize: String(pageSize),
    });

    if (pageToken) params.set('pageToken', pageToken);

    const data = (await this.apiRequest(`/mediaItems?${params.toString()}`)) as {
      mediaItems?: Array<Record<string, unknown>>;
      nextPageToken?: string;
    };

    return {
      mediaItems: (data.mediaItems ?? []).map(parseMediaItem),
      nextPageToken: data.nextPageToken,
    };
  }

  async getPickedMediaItem(
    sessionId: string,
    mediaItemId: string,
  ): Promise<PickedMediaItem> {
    const params = new URLSearchParams({ sessionId });
    const data = (await this.apiRequest(
      `/mediaItems/${encodeURIComponent(mediaItemId)}?${params.toString()}`,
    )) as Record<string, unknown>;

    return parseMediaItem(data);
  }
}

function parseSession(raw: Partial<PickerSession>): PickerSession {
  if (!raw.id) {
    throw new Error('Invalid Picker session response');
  }

  return {
    id: raw.id,
    pickerUri: raw.pickerUri,
    mediaItemsSet: Boolean(raw.mediaItemsSet),
    pollingConfig: raw.pollingConfig,
  };
}

function parseCreateSession(raw: Partial<PickerSession>): PickerSession {
  const session = parseSession(raw);
  if (!session.pickerUri) {
    throw new Error('Invalid Picker session response: missing pickerUri');
  }
  return session;
}

function parseMediaItem(raw: Record<string, unknown>): PickedMediaItem {
  const mediaFile = (raw.mediaFile ?? {}) as Record<string, unknown>;
  const mediaMetadata = (raw.mediaMetadata ?? {}) as Record<string, unknown>;

  return {
    id: String(raw.id ?? ''),
    mimeType: asString(mediaFile.mimeType),
    filename: asString(mediaFile.filename),
    createTime:
      asString(mediaFile.createTime) ??
      asString(raw.createTime) ??
      asString(mediaMetadata.creationTime),
    baseUrl: asString(mediaFile.baseUrl),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
