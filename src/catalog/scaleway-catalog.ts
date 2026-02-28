import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  resolveScalewayEndpoint,
  resolveScalewaySigningRegion,
} from '../providers/scaleway.js';

export type CatalogItem = {
  key: string;
  encodedKey: string;
  size: number;
  lastModified: string;
  capturedAt: string;
  mediaType: 'image' | 'video' | 'other';
  sectionDate: string;
};

export type CatalogPage = {
  items: CatalogItem[];
  nextToken?: string;
};

export type CatalogObject = {
  stream: Readable;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  contentLength?: number;
};

export type CatalogStats = {
  totalFiles: number;
  totalBytes: number;
  imageCount: number;
  videoCount: number;
  oldestDate: string | null;
  newestDate: string | null;
};

export type DeleteResult = {
  deleted: string[];
  failed: { key: string; error: string }[];
};

export type MoveResult = {
  moved: { from: string; to: string }[];
  failed: { key: string; error: string }[];
};

export type Album = {
  id: string;
  name: string;
  keys: string[];
  createdAt: string;
  updatedAt: string;
  coverKey?: string;
};

export type AlbumsManifest = {
  albums: Album[];
};

export type CatalogService = {
  listPage(input?: {
    max?: number;
    token?: string;
    prefix?: string;
  }): Promise<CatalogPage>;
  listAll(prefix?: string): Promise<CatalogItem[]>;
  getObject(encodedKey: string): Promise<CatalogObject>;
  getStats(): Promise<CatalogStats>;
  deleteObjects(encodedKeys: string[]): Promise<DeleteResult>;
  moveObject(encodedKey: string, newDatePrefix: string): Promise<{ from: string; to: string }>;
  getAlbums(): Promise<AlbumsManifest>;
  saveAlbums(manifest: AlbumsManifest): Promise<void>;
};

export type ScalewayCatalogConfig = {
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix?: string;
};

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'dng', 'tif', 'tiff',
]);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'm4v', '3gp', 'mkv', 'webm']);

const S3_REQUEST_TIMEOUT_MS = 30_000;
const STATS_CACHE_TTL_MS = 5 * 60_000;

export class ScalewayCatalogService implements CatalogService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private statsCache: { data: CatalogStats; expiresAt: number } | null = null;

  constructor(config: ScalewayCatalogConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? '';
    this.client =
      client ??
      new S3Client({
        region: resolveScalewaySigningRegion(config.region),
        endpoint: resolveScalewayEndpoint(config.region),
        credentials: {
          accessKeyId: config.accessKey,
          secretAccessKey: config.secretKey,
        },
        forcePathStyle: true,
      });
  }

  async listPage(input?: { max?: number; token?: string; prefix?: string }): Promise<CatalogPage> {
    const max = clamp(input?.max ?? 90, 1, 200);
    const prefix = this.fullPrefix(input?.prefix);

    const items: CatalogItem[] = [];
    let continuationToken = input?.token;
    let hasMore = true;

    while (items.length < max && hasMore) {
      const listMax = Math.min(1000, Math.max(max, 200));
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix || undefined,
          ContinuationToken: continuationToken,
          MaxKeys: listMax,
        }),
        { abortSignal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS) },
      );

      const mediaItems = (result.Contents ?? [])
        .filter((item) => Boolean(item.Key && item.Size !== undefined && item.LastModified))
        .map((item) => {
          const rawKey = item.Key as string;
          const key = this.stripPrefix(rawKey);
          const fallbackDate = item.LastModified as Date;
          const capturedAtDate = inferCapturedAt(key, fallbackDate);
          const sectionDate = toSectionDate(capturedAtDate);
          return {
            key,
            encodedKey: encodeKey(key),
            size: Number(item.Size ?? 0),
            lastModified: fallbackDate.toISOString(),
            capturedAt: capturedAtDate.toISOString(),
            mediaType: inferMediaType(key),
            sectionDate,
          } satisfies CatalogItem;
        })
        .filter((item) => item.mediaType === 'image' || item.mediaType === 'video');

      items.push(...mediaItems);

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
      hasMore = Boolean(continuationToken);

      if (!hasMore) {
        break;
      }
    }

    // Items returned in S3 lexicographic (key) order.
    // Do NOT sort or truncate here — the continuation token corresponds to the
    // last S3 position fetched.  Sorting+truncating would discard items between
    // the truncation point and the token, silently losing data on subsequent pages.
    // The frontend sorts globally via compareItems().

    return {
      items,
      nextToken: continuationToken,
    };
  }

  async getObject(encodedKey: string): Promise<CatalogObject> {
    const decodedKey = decodeKey(encodedKey);
    const fullKey = this.withPrefix(decodedKey);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
      }),
    );

    if (!response.Body) {
      throw new Error(`Object has empty body: ${decodedKey}`);
    }

    const stream =
      response.Body instanceof Readable
        ? response.Body
        : Readable.fromWeb(response.Body as ReadableStream<Uint8Array>);

    return {
      stream,
      contentType: response.ContentType ?? inferContentType(decodedKey),
      etag: response.ETag,
      lastModified: response.LastModified?.toISOString(),
      contentLength: response.ContentLength,
    };
  }

  async getStats(): Promise<CatalogStats> {
    if (this.statsCache && Date.now() < this.statsCache.expiresAt) {
      return this.statsCache.data;
    }

    let totalFiles = 0;
    let totalBytes = 0;
    let imageCount = 0;
    let videoCount = 0;
    let oldest: Date | null = null;
    let newest: Date | null = null;
    let continuationToken: string | undefined;

    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix ? `${this.prefix}/` : undefined,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
        { abortSignal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS) },
      );

      for (const obj of result.Contents ?? []) {
        if (!obj.Key || obj.Size === undefined) continue;
        const key = this.stripPrefix(obj.Key);
        const type = inferMediaType(key);
        if (type !== 'image' && type !== 'video') continue;

        totalFiles++;
        totalBytes += Number(obj.Size);
        if (type === 'image') imageCount++;
        else videoCount++;

        const capturedAt = inferCapturedAt(key, obj.LastModified ?? new Date());
        if (!oldest || capturedAt < oldest) oldest = capturedAt;
        if (!newest || capturedAt > newest) newest = capturedAt;
      }

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    const stats: CatalogStats = {
      totalFiles,
      totalBytes,
      imageCount,
      videoCount,
      oldestDate: oldest?.toISOString() ?? null,
      newestDate: newest?.toISOString() ?? null,
    };

    this.statsCache = { data: stats, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
    return stats;
  }

  async listAll(prefix?: string): Promise<CatalogItem[]> {
    const items: CatalogItem[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.fullPrefix(prefix),
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
        { abortSignal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS) },
      );

      const mediaItems = (result.Contents ?? [])
        .filter((item) => Boolean(item.Key && item.Size !== undefined && item.LastModified))
        .map((item) => {
          const rawKey = item.Key as string;
          const key = this.stripPrefix(rawKey);
          const fallbackDate = item.LastModified as Date;
          const capturedAtDate = inferCapturedAt(key, fallbackDate);
          const sectionDate = toSectionDate(capturedAtDate);
          return {
            key,
            encodedKey: encodeKey(key),
            size: Number(item.Size ?? 0),
            lastModified: fallbackDate.toISOString(),
            capturedAt: capturedAtDate.toISOString(),
            mediaType: inferMediaType(key),
            sectionDate,
          } satisfies CatalogItem;
        })
        .filter((item) => item.mediaType === 'image' || item.mediaType === 'video');

      items.push(...mediaItems);
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return items;
  }

  async deleteObjects(encodedKeys: string[]): Promise<DeleteResult> {
    const deleted: string[] = [];
    const failed: { key: string; error: string }[] = [];

    // S3 DeleteObjects supports batches of up to 1000
    const BATCH_SIZE = 1000;
    for (let i = 0; i < encodedKeys.length; i += BATCH_SIZE) {
      const batch = encodedKeys.slice(i, i + BATCH_SIZE);
      const objects = batch.map((ek) => {
        const key = decodeKey(ek);
        return { Key: this.withPrefix(key) };
      });

      try {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: false },
          }),
          { abortSignal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS) },
        );

        for (const d of result.Deleted ?? []) {
          if (d.Key) deleted.push(this.stripPrefix(d.Key));
        }
        for (const e of result.Errors ?? []) {
          failed.push({
            key: e.Key ? this.stripPrefix(e.Key) : 'unknown',
            error: e.Message ?? 'Unknown error',
          });
        }
      } catch (err) {
        // If the whole batch fails, record each key as failed
        for (const ek of batch) {
          failed.push({ key: decodeKey(ek), error: String(err) });
        }
      }
    }

    // Invalidate stats cache after deletion
    this.statsCache = null;
    return { deleted, failed };
  }

  async moveObject(encodedKey: string, newDatePrefix: string): Promise<{ from: string; to: string }> {
    const oldKey = decodeKey(encodedKey);
    const filename = oldKey.split('/').pop() ?? oldKey;
    // newDatePrefix should be like "2020/03/15"
    const newKey = `${newDatePrefix}/${filename}`;
    const fullOldKey = this.withPrefix(oldKey);
    const fullNewKey = this.withPrefix(newKey);

    // Copy to new location
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${fullOldKey}`,
        Key: fullNewKey,
      }),
      { abortSignal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS) },
    );

    // Delete original
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: fullOldKey,
      }),
      { abortSignal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS) },
    );

    // Invalidate stats cache
    this.statsCache = null;
    return { from: oldKey, to: newKey };
  }

  async getAlbums(): Promise<AlbumsManifest> {
    const key = this.withPrefix('_albums.json');
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS) },
      );
      if (!result.Body) return { albums: [] };
      const body = await streamToString(result.Body);
      return JSON.parse(body) as AlbumsManifest;
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'NoSuchKey' || (err as any).$metadata?.httpStatusCode === 404)) {
        return { albums: [] };
      }
      throw err;
    }
  }

  async saveAlbums(manifest: AlbumsManifest): Promise<void> {
    const key = this.withPrefix('_albums.json');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: 'application/json',
      }),
      { abortSignal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS) },
    );
  }

  private fullPrefix(extra?: string): string {
    if (this.prefix && extra) {
      return `${this.prefix}/${extra}`;
    }
    if (this.prefix) {
      return `${this.prefix}/`;
    }
    return extra ?? '';
  }

  private withPrefix(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private stripPrefix(key: string): string {
    if (!this.prefix) {
      return key;
    }
    const prefixed = `${this.prefix}/`;
    return key.startsWith(prefixed) ? key.slice(prefixed.length) : key;
  }
}

export function encodeKey(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

export function decodeKey(encodedKey: string): string {
  try {
    return Buffer.from(encodedKey, 'base64url').toString('utf8');
  } catch {
    throw new Error('Invalid media key encoding');
  }
}

function inferMediaType(key: string): 'image' | 'video' | 'other' {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return 'video';
  }
  return 'other';
}

function inferCapturedAt(key: string, fallback: Date): Date {
  const fromPath = /(?:^|\/)((?:19|20)\d{2})\/(\d{2})\/(\d{2})(?:\/|$)/.exec(key);
  const filename = key.split('/').pop() ?? key;

  const fromFileUnderscore = /((?:19|20)\d{2})(\d{2})(\d{2})[\sT_-]?(\d{2})(\d{2})(\d{2})/.exec(filename);
  if (fromFileUnderscore) {
    const parsed = asUtcDate(
      fromFileUnderscore[1],
      fromFileUnderscore[2],
      fromFileUnderscore[3],
      fromFileUnderscore[4],
      fromFileUnderscore[5],
      fromFileUnderscore[6],
    );
    if (parsed) {
      return parsed;
    }
  }

  const fromFileDashed = /((?:19|20)\d{2})-(\d{2})-(\d{2})[ T_.-]?(\d{2})[.:_-]?(\d{2})[.:_-]?(\d{2})/.exec(filename);
  if (fromFileDashed) {
    const parsed = asUtcDate(
      fromFileDashed[1],
      fromFileDashed[2],
      fromFileDashed[3],
      fromFileDashed[4],
      fromFileDashed[5],
      fromFileDashed[6],
    );
    if (parsed) {
      return parsed;
    }
  }

  const fromFileDateOnly = /((?:19|20)\d{2})(\d{2})(\d{2})/.exec(filename);
  if (fromFileDateOnly) {
    const parsed = asUtcDate(
      fromFileDateOnly[1],
      fromFileDateOnly[2],
      fromFileDateOnly[3],
      '00',
      '00',
      '00',
    );
    if (parsed) {
      return parsed;
    }
  }

  if (fromPath) {
    const parsed = asUtcDate(fromPath[1], fromPath[2], fromPath[3], '00', '00', '00');
    if (parsed) {
      return parsed;
    }
  }

  return fallback;
}

function asUtcDate(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
): Date | undefined {
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}

function toSectionDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function inferContentType(key: string): string | undefined {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'avif':
      return 'image/avif';
    case 'dng':
      return 'image/x-adobe-dng';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'avi':
      return 'video/x-msvideo';
    case 'm4v':
      return 'video/x-m4v';
    case '3gp':
      return 'video/3gpp';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
    default:
      return undefined;
  }
}

async function streamToString(body: unknown): Promise<string> {
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  // AWS SDK v3 may return a ReadableStream (web)
  if (typeof (body as any)?.transformToString === 'function') {
    return (body as any).transformToString('utf-8');
  }
  return String(body);
}