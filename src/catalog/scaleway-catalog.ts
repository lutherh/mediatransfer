import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import sharp from 'sharp';
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

/**
 * Allowed thumbnail size presets.
 *   • `small`  – 256px longest edge, JPEG q80 (~15-30 KB) – grid tiles
 *   • `large`  – 1920px longest edge, JPEG q85 (~200-400 KB) – lightbox preview
 */
export type ThumbnailSize = 'small' | 'large';

export type ThumbnailResult = {
  buffer: Buffer;
  contentType: string;
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
    sort?: 'asc' | 'desc';
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
  /** Generate a resized thumbnail for the given media key. Returns JPEG buffer. */
  getThumbnail(encodedKey: string, size: ThumbnailSize): Promise<ThumbnailResult>;
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
  /** Per-request timeout for S3 operations in milliseconds. */
  s3RequestTimeoutMs?: number;
  /** Max retries for ListObjectsV2 page requests. */
  s3ListMaxRetries?: number;
};

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'dng', 'tif', 'tiff',
]);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'm4v', '3gp', 'mkv', 'webm']);

const DEFAULT_S3_REQUEST_TIMEOUT_MS = 300_000;
const STATS_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_PAGE_RETRIES = 5;

// ── Thumbnail configuration ─────────────────────────────────────────────────

const THUMB_SIZES: Record<ThumbnailSize, { maxDimension: number; quality: number }> = {
  small: { maxDimension: 256, quality: 80 },
  large: { maxDimension: 1920, quality: 85 },
};
const THUMB_CACHE_MAX_ENTRIES = 500;
const THUMB_CACHE_TTL_MS = 30 * 60_000; // 30 minutes

type ThumbCacheEntry = { buffer: Buffer; contentType: string; expiresAt: number };

/**
 * Simple in-memory LRU cache for generated thumbnails. Evicts oldest entry
 * when the cache exceeds THUMB_CACHE_MAX_ENTRIES or when entries expire.
 */
class ThumbnailCache {
  private readonly map = new Map<string, ThumbCacheEntry>();

  get(key: string): ThumbCacheEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most-recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: ThumbCacheEntry): void {
    if (this.map.size >= THUMB_CACHE_MAX_ENTRIES) {
      // Evict oldest (first key)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, entry);
  }
}

/** Retry wrapper for S3 ListObjectsV2 — retries transient / timeout errors with linear backoff. */
async function s3ListWithRetry(
  client: S3Client,
  params: ConstructorParameters<typeof ListObjectsV2Command>[0],
  options: { timeoutMs: number; maxRetries: number },
): Promise<ListObjectsV2CommandOutput> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.maxRetries; attempt++) {
    try {
      return await client.send(
        new ListObjectsV2Command(params),
        { abortSignal: AbortSignal.timeout(options.timeoutMs) },
      );
    } catch (err) {
      lastError = err;
      if (attempt < options.maxRetries - 1) {
        const delay = Math.min(1000 * 2 ** attempt, 15_000); // 1s, 2s, 4s, 8s exponential backoff
        console.warn(
          `[catalog] S3 list page failed (attempt ${attempt + 1}/${options.maxRetries}), retrying in ${delay}ms`,
          err,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export class ScalewayCatalogService implements CatalogService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly s3RequestTimeoutMs: number;
  private readonly s3ListMaxRetries: number;
  private statsCache: { data: CatalogStats; expiresAt: number } | null = null;
  private readonly thumbCache = new ThumbnailCache();
  private itemsIndexCache: { items: CatalogItem[]; expiresAt: number } | null = null;

  constructor(config: ScalewayCatalogConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? '';
    this.s3RequestTimeoutMs = normalizePositiveInteger(config.s3RequestTimeoutMs, DEFAULT_S3_REQUEST_TIMEOUT_MS);
    this.s3ListMaxRetries = normalizePositiveInteger(config.s3ListMaxRetries, DEFAULT_MAX_PAGE_RETRIES);
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

  async listPage(input?: { max?: number; token?: string; prefix?: string; sort?: 'asc' | 'desc' }): Promise<CatalogPage> {
    if (input?.sort === 'desc') {
      return this.listPageDescending(input);
    }
    const max = clamp(input?.max ?? 90, 1, 200);
    const prefix = this.fullPrefix(input?.prefix);

    const items: CatalogItem[] = [];
    let continuationToken = input?.token;
    let hasMore = true;

    while (items.length < max && hasMore) {
      const listMax = Math.min(1000, Math.max(max, 200));
      const result = await s3ListWithRetry(this.client, {
        Bucket: this.bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
        MaxKeys: listMax,
      }, {
        timeoutMs: this.s3RequestTimeoutMs,
        maxRetries: this.s3ListMaxRetries,
      });

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

  /**
   * Serve a page of items in descending (newest-first) order from a cached
   * full index. The index is built lazily on first request and cached with
   * the same TTL as stats (5 min). Pagination uses numeric offsets encoded
   * as the nextToken string (e.g. "200").
   */
  private async listPageDescending(input?: { max?: number; token?: string; prefix?: string }): Promise<CatalogPage> {
    const max = clamp(input?.max ?? 90, 1, 200);
    const allItems = await this.getItemsIndex();

    let items = allItems;
    if (input?.prefix) {
      const lowerPrefix = input.prefix.toLowerCase();
      items = allItems.filter(item => item.key.toLowerCase().startsWith(lowerPrefix));
    }

    const offset = input?.token ? parseInt(input.token, 10) : 0;
    if (Number.isNaN(offset) || offset < 0) {
      return { items: [], nextToken: undefined };
    }
    const page = items.slice(offset, offset + max);
    const nextOffset = offset + page.length;

    return {
      items: page,
      nextToken: nextOffset < items.length ? String(nextOffset) : undefined,
    };
  }

  private async getItemsIndex(): Promise<CatalogItem[]> {
    if (this.itemsIndexCache && Date.now() < this.itemsIndexCache.expiresAt) {
      return this.itemsIndexCache.items;
    }
    const items = await this.listAll();
    this.itemsIndexCache = { items, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
    return items;
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
      { abortSignal: AbortSignal.timeout(this.s3RequestTimeoutMs) },
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

  /**
   * Generate a resized JPEG thumbnail for the given media key.
   *
   * Uses an in-memory LRU cache (30 min TTL, 500 entries) to avoid redundant
   * S3 fetches + sharp resizing on repeated requests (e.g. scrolling back).
   *
   * @param encodedKey - Base64url-encoded S3 object key
   * @param size       - 'small' (256px, grid) or 'large' (1920px, lightbox)
   */
  async getThumbnail(encodedKey: string, size: ThumbnailSize): Promise<ThumbnailResult> {
    const cacheKey = `${size}:${encodedKey}`;
    const cached = this.thumbCache.get(cacheKey);
    if (cached) {
      return { buffer: cached.buffer, contentType: cached.contentType };
    }

    // Reject video files early — sharp can't process them and we'd waste
    // bandwidth downloading the full video from S3 just to fail.
    const decodedKey = decodeKey(encodedKey);
    if (inferMediaType(decodedKey) === 'video') {
      throw Object.assign(new Error('Video thumbnails not supported'), { code: 'UNSUPPORTED_FORMAT' });
    }
    const fullKey = this.withPrefix(decodedKey);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: fullKey }),
      { abortSignal: AbortSignal.timeout(this.s3RequestTimeoutMs) },
    );

    if (!response.Body) {
      throw new Error(`Object has empty body: ${decodedKey}`);
    }

    const bodyStream =
      response.Body instanceof Readable
        ? response.Body
        : Readable.fromWeb(response.Body as ReadableStream<Uint8Array>);

    const { maxDimension, quality } = THUMB_SIZES[size];

    // Stream S3 body directly into Sharp — avoids buffering the full-size
    // image (potentially 20+ MB for HEIC) into a single Buffer[]
    const sharpTransform = sharp()
      .rotate()                                // Auto-orient using EXIF
      .resize(maxDimension, maxDimension, {
        fit: 'inside',                         // Preserve aspect ratio
        withoutEnlargement: true,              // Don't upscale small images
      })
      .jpeg({ quality, mozjpeg: true });       // MozJPEG for smaller output

    bodyStream.pipe(sharpTransform);
    const buffer = await sharpTransform.toBuffer();

    const contentType = 'image/jpeg';

    this.thumbCache.set(cacheKey, {
      buffer,
      contentType,
      expiresAt: Date.now() + THUMB_CACHE_TTL_MS,
    });

    return { buffer, contentType };
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
      const result = await s3ListWithRetry(this.client, {
        Bucket: this.bucket,
        Prefix: this.prefix ? `${this.prefix}/` : undefined,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }, {
        timeoutMs: this.s3RequestTimeoutMs,
        maxRetries: this.s3ListMaxRetries,
      });

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
      const result = await s3ListWithRetry(this.client, {
        Bucket: this.bucket,
        Prefix: this.fullPrefix(prefix),
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }, {
        timeoutMs: this.s3RequestTimeoutMs,
        maxRetries: this.s3ListMaxRetries,
      });

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
          { abortSignal: AbortSignal.timeout(this.s3RequestTimeoutMs) },
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

    // Invalidate caches after deletion
    this.statsCache = null;
    this.itemsIndexCache = null;
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
      { abortSignal: AbortSignal.timeout(this.s3RequestTimeoutMs) },
    );

    // Delete original
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: fullOldKey,
      }),
      { abortSignal: AbortSignal.timeout(this.s3RequestTimeoutMs) },
    );

    // Invalidate caches
    this.statsCache = null;
    this.itemsIndexCache = null;
    return { from: oldKey, to: newKey };
  }

  async getAlbums(): Promise<AlbumsManifest> {
    const key = this.withPrefix('_albums.json');
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(this.s3RequestTimeoutMs) },
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
      { abortSignal: AbortSignal.timeout(this.s3RequestTimeoutMs) },
    );
  }

  async findDuplicates(onProgress?: (listed: number) => void): Promise<DuplicateGroup[]> {
    // Phase 1: list all objects, capturing size + ETag
    const objects: { key: string; size: number; etag: string }[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await s3ListWithRetry(this.client, {
        Bucket: this.bucket,
        Prefix: this.prefix ? `${this.prefix}/` : undefined,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }, {
        timeoutMs: this.s3RequestTimeoutMs,
        maxRetries: this.s3ListMaxRetries,
      });

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

      continuationToken = result!.IsTruncated ? result!.NextContinuationToken : undefined;
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
  // 1. Prefer the date from the S3 path (YYYY/MM/DD folders) — this was assigned
  //    during upload from EXIF/sidecar data, so it's the most reliable source.
  const fromPath = /(?:^|\/)((?:19|20)\d{2})\/(\d{2})\/(\d{2})(?:\/|$)/.exec(key);
  if (fromPath) {
    const parsed = asUtcDate(fromPath[1], fromPath[2], fromPath[3], '00', '00', '00');
    if (parsed) {
      return parsed;
    }
  }

  // 2. Try filename-embedded timestamps (e.g. IMG_20231215_143022.jpg)
  //    Use (?<!\d) / (?!\d) boundaries so we don't match inside longer digit runs.
  const filename = key.split('/').pop() ?? key;

  const fromFileUnderscore = /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})[\sT_-]?(\d{2})(\d{2})(\d{2})(?!\d)/.exec(filename);
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

  const fromFileDashed = /(?<!\d)((?:19|20)\d{2})-(\d{2})-(\d{2})[ T_.-]?(\d{2})[.:_-]?(\d{2})[.:_-]?(\d{2})(?!\d)/.exec(filename);
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

  const fromFileDateOnly = /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/.exec(filename);
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
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  // Reject implausible dates: before 1970, after current year + 1, or invalid month/day
  if (y < 1970 || y > new Date().getFullYear() + 1 || m < 1 || m > 12 || d < 1 || d > 31) {
    return undefined;
  }
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

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return rounded >= 1 ? rounded : fallback;
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