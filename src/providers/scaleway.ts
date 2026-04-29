import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  type ListObjectsV2CommandInput,
  type ListObjectsV2CommandOutput,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import type { CloudProvider, ListOptions, ObjectInfo, ProviderConfig } from './types.js';

// ── Scaleway region → endpoint mapping ──────────────────────────

/** Supported Scaleway regions and their S3 endpoints. */
const SCALEWAY_REGIONS: Record<string, string> = {
  'fr-par': 'https://s3.fr-par.scw.cloud',
  'nl-ams': 'https://s3.nl-ams.scw.cloud',
  'pl-waw': 'https://s3.pl-waw.scw.cloud',
};

/**
 * Resolve the region value into an SDK signing region.
 * Accepts a Scaleway region code (`nl-ams`), a full S3 endpoint URL, or any
 * plain region string (e.g. `us-east-1` for AWS).
 */
export function resolveScalewaySigningRegion(region: string): string {
  const normalized = region.toLowerCase();
  if (SCALEWAY_REGIONS[normalized]) {
    return normalized;
  }

  if (region.startsWith('https://') || region.startsWith('http://')) {
    try {
      const parsed = new URL(region);
      // Try Scaleway-style: s3.{region}.scw.cloud
      const scwMatch = /^s3\.([a-z0-9-]+)\.scw\.cloud$/i.exec(parsed.hostname);
      if (scwMatch?.[1]) return scwMatch[1].toLowerCase();
      // Generic: s3.{region}.provider.tld (AWS, Backblaze B2, etc.)
      const genericMatch = /^s3[.-]([a-z0-9-]+)\./i.exec(parsed.hostname);
      if (genericMatch?.[1]) return genericMatch[1].toLowerCase();
      // Fall back to full hostname as signing region
      return parsed.hostname;
    } catch {
      // ignored — fall through
    }
  }

  // Unknown plain string — treat as a direct signing region (e.g. "us-east-1", "eu-west-1")
  return region;
}

/**
 * Resolve a region string to an S3 endpoint URL.
 * Accepts Scaleway region codes ("fr-par"), full endpoint URLs, or unknown
 * region strings. Returns `undefined` for unknown plain regions so the AWS SDK
 * can handle endpoint resolution itself (needed for standard AWS S3).
 */
export function resolveScalewayEndpoint(region: string): string | undefined {
  const endpoint = SCALEWAY_REGIONS[region.toLowerCase()];
  if (endpoint) return endpoint;

  // Accept any explicit URL (Backblaze B2, Cloudflare R2, custom S3-compatible)
  if (region.startsWith('https://') || region.startsWith('http://')) {
    return region;
  }

  // Unknown plain region — let the AWS SDK resolve the default endpoint
  return undefined;
}

// ── Configuration ───────────────────────────────────────────────

export type ScalewayConfig = ProviderConfig & {
  provider: 'scaleway';
  /** Region code (e.g. "fr-par", "us-east-1") or full S3 endpoint URL */
  region: string;
  /** Target bucket name */
  bucket: string;
  /** Access key */
  accessKey: string;
  /** Secret key */
  secretKey: string;
  /** Optional key prefix to scope operations */
  prefix?: string;
  /** S3 storage class for new uploads (e.g. STANDARD, ONEZONE_IA, GLACIER, STANDARD_IA) */
  storageClass?: string;
  /** Explicit S3 endpoint URL override (if omitted, derived from region) */
  endpoint?: string;
  /** Use path-style S3 requests. Defaults to true. Set false for AWS S3 virtual-hosted style. */
  forcePathStyle?: boolean;
};

/**
 * Validate that the required Scaleway config fields are present.
 */
export function validateScalewayConfig(config: ProviderConfig): ScalewayConfig {
  const { region, bucket, accessKey, secretKey, prefix } = config as Record<string, unknown>;

  if (typeof region !== 'string' || !region) {
    throw new Error('Scaleway config: "region" is required');
  }
  if (typeof bucket !== 'string' || !bucket) {
    throw new Error('Scaleway config: "bucket" is required');
  }
  if (typeof accessKey !== 'string' || !accessKey) {
    throw new Error('Scaleway config: "accessKey" is required');
  }
  if (typeof secretKey !== 'string' || !secretKey) {
    throw new Error('Scaleway config: "secretKey" is required');
  }

  const { storageClass, endpoint, forcePathStyle } = config as Record<string, unknown>;
  return {
    provider: 'scaleway',
    region: region as string,
    bucket: bucket as string,
    accessKey: accessKey as string,
    secretKey: secretKey as string,
    prefix: typeof prefix === 'string' ? prefix : undefined,
    storageClass: typeof storageClass === 'string' ? storageClass : undefined,
    endpoint: typeof endpoint === 'string' ? endpoint : undefined,
    forcePathStyle: typeof forcePathStyle === 'boolean' ? forcePathStyle : undefined,
  };
}

// ── Provider implementation ─────────────────────────────────────

export class ScalewayProvider implements CloudProvider {
  readonly name = 'Scaleway Object Storage';

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly multipartPartSizeBytes = 16 * 1024 * 1024;
  private readonly multipartQueueSize = 4;
  private readonly storageClass: StorageClass | undefined;

  constructor(config: ScalewayConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? '';
    this.storageClass = config.storageClass as StorageClass | undefined;

    this.client =
      client ??
      new S3Client({
        region: resolveScalewaySigningRegion(config.region),
        endpoint: config.endpoint ?? resolveScalewayEndpoint(config.region),
        credentials: {
          accessKeyId: config.accessKey,
          secretAccessKey: config.secretKey,
        },
        forcePathStyle: config.forcePathStyle ?? true,
      });
  }

  /**
   * Prepend the configured prefix to a key.
   */
  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  /**
   * Strip the configured prefix from a key.
   */
  private stripPrefix(key: string): string {
    if (this.prefix && key.startsWith(`${this.prefix}/`)) {
      return key.slice(this.prefix.length + 1);
    }
    return key;
  }

  async list(options?: ListOptions): Promise<ObjectInfo[]> {
    const prefix = this.prefix
      ? options?.prefix
        ? `${this.prefix}/${options.prefix}`
        : `${this.prefix}/`
      : options?.prefix ?? '';

    const input: ListObjectsV2CommandInput = {
      Bucket: this.bucket,
      Prefix: prefix || undefined,
      MaxKeys: options?.maxResults,
    };

    const results: ObjectInfo[] = [];
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        ...input,
        ContinuationToken: continuationToken,
      });

      const response = await this.sendWithRetry(command);

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key && obj.Size !== undefined && obj.LastModified) {
            results.push({
              key: this.stripPrefix(obj.Key),
              size: obj.Size,
              lastModified: obj.LastModified,
              contentType: undefined, // ListObjectsV2 doesn't return content type
            });
          }
        }
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;

      // Respect maxResults across pages
      if (options?.maxResults && results.length >= options.maxResults) {
        results.length = options.maxResults;
        break;
      }
    } while (continuationToken);

    return results;
  }

  async download(key: string): Promise<Readable> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.fullKey(key),
    });

    const response = await this.client.send(command);

    if (!response.Body) {
      throw new Error(`Empty response body for key "${key}"`);
    }

    // The SDK returns a web ReadableStream in some envs; convert if needed.
    if (response.Body instanceof Readable) {
      return response.Body;
    }

    // @ts-expect-error — SDK Body may be a web stream; convert to Node Readable
    return Readable.fromWeb(response.Body);
  }

  /**
   * Exact-key existence probe via `HeadObject`.
   *
   * Returns `null` for a 404 (the canonical "not found" signal). Any other
   * error is rethrown so transient 5xx / network failures don't get silently
   * misread as "missing" — that bug previously caused dense date folders to
   * be re-uploaded on top of existing keys.
   */
  async head(key: string): Promise<ObjectInfo | null> {
    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: this.fullKey(key),
    });
    try {
      const response = await this.client.send(command, {
        abortSignal: AbortSignal.timeout(ScalewayProvider.S3_REQUEST_TIMEOUT_MS),
      });
      return {
        key,
        size: response.ContentLength ?? 0,
        lastModified: response.LastModified ?? new Date(0),
        contentType: response.ContentType,
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const name = (err as Error)?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        return null;
      }
      throw err;
    }
  }

  async upload(key: string, stream: Readable, contentType?: string, metadata?: Record<string, string>): Promise<void> {
    const upload = new Upload({
      client: this.client,
      queueSize: this.multipartQueueSize,
      partSize: this.multipartPartSizeBytes,
      leavePartsOnError: false,
      params: {
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: stream,
        ContentType: contentType,
        ...(this.storageClass ? { StorageClass: this.storageClass } : {}),
        ...(metadata && Object.keys(metadata).length > 0 ? { Metadata: metadata } : {}),
      },
    });

    await upload.done();
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.fullKey(key),
    });

    await this.client.send(command);
  }

  // ── Retry helper for transient S3 errors ──────────────────────

  private static readonly S3_MAX_RETRIES = 4;
  private static readonly S3_REQUEST_TIMEOUT_MS = 120_000;

  /**
   * Send an S3 command with per-request timeout and exponential backoff retries.
   * Retries on AbortError (timeout), network errors, and 5xx responses.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async sendWithRetry(command: ListObjectsV2Command): Promise<ListObjectsV2CommandOutput> {
    let lastError: unknown;
    for (let attempt = 0; attempt < ScalewayProvider.S3_MAX_RETRIES; attempt++) {
      try {
        return await this.client.send(command as ListObjectsV2Command, {
          abortSignal: AbortSignal.timeout(ScalewayProvider.S3_REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err;
        const httpStatus = (err as Record<string, unknown>)?.['$metadata'] != null
          ? ((err as Record<string, Record<string, unknown>>)['$metadata']?.['httpStatusCode'] as number | undefined)
          : undefined;
        const isRetryable =
          err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError' ||
           err.name === 'NetworkingError' || err.name === 'ECONNRESET' ||
           (typeof httpStatus === 'number' && httpStatus >= 500));
        if (!isRetryable) throw err;
        if (attempt < ScalewayProvider.S3_MAX_RETRIES - 1) {
          const delay = Math.min(1000 * 2 ** attempt, 15_000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }
}

// ── Factory ─────────────────────────────────────────────────────

/**
 * Factory function for the provider registry.
 */
export function createScalewayProvider(config: ProviderConfig): CloudProvider {
  const validated = validateScalewayConfig(config);
  return new ScalewayProvider(validated);
}
