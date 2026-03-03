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

export type DuplicateGroup = {
  /** The (size, etag) fingerprint shared by all items in this group. */
  fingerprint: string;
  /** Number of bytes each item occupies. */
  size: number;
  /** The key chosen to keep (best date-path structure). */
  keepKey: string;
  /** Keys that are duplicates and safe to remove. */
  duplicateKeys: string[];
};

export type DeduplicateResult = {
  /** Groups that were detected as duplicates. */
  groups: DuplicateGroup[];
  /** Total duplicate files removed (or to be removed in dry-run). */
  totalDuplicates: number;
  /** Total bytes freed (or to be freed in dry-run). */
  bytesFreed: number;
  /** Deletion results (only present when dryRun=false). */
  deleteResult?: DeleteResult;
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
  /** Fetch up to `maxBytes` of an object as a Buffer (for EXIF parsing etc.). */
  getObjectBuffer(encodedKey: string, maxBytes?: number): Promise<{ buffer: Buffer; contentType?: string; contentLength?: number }>;
  getStats(): Promise<CatalogStats>;
  deleteObjects(encodedKeys: string[]): Promise<DeleteResult>;
  moveObject(encodedKey: string, newDatePrefix: string): Promise<{ from: string; to: string }>;
  getAlbums(): Promise<AlbumsManifest>;
  saveAlbums(manifest: AlbumsManifest): Promise<void>;
  /** Scan all objects and return groups of duplicates (same size + ETag). */
  findDuplicates(onProgress?: (listed: number) => void): Promise<DuplicateGroup[]>;
  /** Find and remove duplicates. Pass dryRun=true to preview without deleting. */
  deduplicateObjects(options?: { dryRun?: boolean }): Promise<DeduplicateResult>;
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

  async getObjectBuffer(
    encodedKey: string,
    maxBytes = 65536,
  ): Promise<{ buffer: Buffer; contentType?: string; contentLength?: number }> {
    const decodedKey = decodeKey(encodedKey);
    const fullKey = this.withPrefix(decodedKey);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        Range: `bytes=0-${maxBytes - 1}`,
      }),
      { abortSignal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS) },
    );

    if (!response.Body) {
      throw new Error(`Object has empty body: ${decodedKey}`);
    }

    const stream =
      response.Body instanceof Readable
        ? response.Body
        : Readable.fromWeb(response.Body as ReadableStream<Uint8Array>);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return {
      buffer: Buffer.concat(chunks),
      contentType: response.ContentType ?? inferContentType(decodedKey),
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

  async findDuplicates(onProgress?: (listed: number) => void): Promise<DuplicateGroup[]> {
    // Phase 1: list all objects, capturing size + ETag
    const objects: { key: string; size: number; etag: string }[] = [];
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
        if (!obj.Key || obj.Size === undefined || !obj.ETag) continue;
        const key = this.stripPrefix(obj.Key);
        const type = inferMediaType(key);
        if (type !== 'image' && type !== 'video') continue;
        objects.push({
          key,
          size: Number(obj.Size),
          etag: normalizeEtag(obj.ETag),
        });
      }

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
      onProgress?.(objects.length);
    } while (continuationToken);

    // Phase 2: group by (size, etag) — identical content fingerprint
    return buildDuplicateGroups(objects);
  }

  async deduplicateObjects(options?: { dryRun?: boolean }): Promise<DeduplicateResult> {
    const dryRun = options?.dryRun ?? true;
    const groups = await this.findDuplicates();

    const totalDuplicates = groups.reduce((sum, g) => sum + g.duplicateKeys.length, 0);
    const bytesFreed = groups.reduce((sum, g) => sum + g.duplicateKeys.length * g.size, 0);

    if (dryRun || totalDuplicates === 0) {
      return { groups, totalDuplicates, bytesFreed };
    }

    // Collect all duplicate keys to delete
    const encodedKeysToDelete = groups.flatMap((g) =>
      g.duplicateKeys.map((k) => encodeKey(k)),
    );

    const deleteResult = await this.deleteObjects(encodedKeysToDelete);
    return { groups, totalDuplicates, bytesFreed, deleteResult };
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
  } catch (err) {
    console.debug('[catalog] Invalid encoded media key', { encodedKey, err });
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

// ── ETag normalization ──────────────────────────────────────────

function normalizeEtag(etag: string | undefined): string {
  if (!etag) return '';
  return etag.replace(/"/g, '').trim();
}

// ── Duplicate detection ─────────────────────────────────────────

/**
 * Score a key for "keep" priority.  Higher = better candidate to keep.
 *
 * Prefers:
 *  1. Keys with a proper YYYY/MM/DD date path   (+10)
 *  2. Keys that are shorter (less nesting noise) (+5 minus depth penalty)
 *  3. Deterministic tiebreak via lexicographic order
 */
export function scoreKeyForKeep(key: string): number {
  let score = 0;
  // Proper date path like 2020/03/15/
  if (/^((?:19|20)\d{2})\/(\d{2})\/(\d{2})\//.test(key)) {
    score += 10;
  }
  // Penalise deep nesting
  const depth = (key.match(/\//g) ?? []).length;
  score -= depth;
  return score;
}

/**
 * Given a flat list of objects (key, size, etag), group by (size, etag)
 * and return only groups with more than one item — i.e. duplicates.
 * Within each group, pick the best key to keep and mark the rest as duplicates.
 */
export function buildDuplicateGroups(
  objects: { key: string; size: number; etag: string }[],
): DuplicateGroup[] {
  const map = new Map<string, { key: string; size: number }[]>();

  for (const obj of objects) {
    const fp = `${obj.size}:${obj.etag}`;
    const list = map.get(fp);
    if (list) {
      list.push({ key: obj.key, size: obj.size });
    } else {
      map.set(fp, [{ key: obj.key, size: obj.size }]);
    }
  }

  const groups: DuplicateGroup[] = [];

  for (const [fingerprint, items] of map) {
    if (items.length < 2) continue;

    // Sort: highest score first, then lexicographic for determinism
    items.sort((a, b) => {
      const scoreDiff = scoreKeyForKeep(b.key) - scoreKeyForKeep(a.key);
      if (scoreDiff !== 0) return scoreDiff;
      return a.key.localeCompare(b.key);
    });

    const keepKey = items[0]!.key;
    const duplicateKeys = items.slice(1).map((i) => i.key);

    groups.push({
      fingerprint,
      size: items[0]!.size,
      keepKey,
      duplicateKeys,
    });
  }

  // Sort groups by bytes wasted descending for easy prioritisation
  groups.sort((a, b) => b.duplicateKeys.length * b.size - a.duplicateKeys.length * a.size);
  return groups;
}