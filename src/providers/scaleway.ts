import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  type ListObjectsV2CommandInput,
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
 * Accepts either region code (`nl-ams`) or full Scaleway S3 endpoint URL.
 */
export function resolveScalewaySigningRegion(region: string): string {
  const normalized = region.toLowerCase();
  if (SCALEWAY_REGIONS[normalized]) {
    return normalized;
  }

  if (region.startsWith('https://') || region.startsWith('http://')) {
    try {
      const parsed = new URL(region);
      const match = /^s3\.([a-z0-9-]+)\.scw\.cloud$/i.exec(parsed.hostname);
      if (match?.[1]) {
        return match[1].toLowerCase();
      }
    } catch {
      // ignored, handled by throw below
    }

    throw new Error(
      `Cannot derive Scaleway signing region from endpoint URL "${region}". ` +
        'Use a known Scaleway endpoint like https://s3.nl-ams.scw.cloud or provide region code.',
    );
  }

  const known = Object.keys(SCALEWAY_REGIONS).join(', ');
  throw new Error(
    `Unknown Scaleway region "${region}". Known regions: ${known}. ` +
      'You can also pass a full endpoint URL.',
  );
}

/**
 * Resolve a Scaleway region string to an S3 endpoint URL.
 * Accepts both region codes ("fr-par") and full URLs.
 */
export function resolveScalewayEndpoint(region: string): string {
  const endpoint = SCALEWAY_REGIONS[region.toLowerCase()];
  if (endpoint) return endpoint;

  // Allow passing a full URL directly (custom / new regions)
  if (region.startsWith('https://') || region.startsWith('http://')) {
    return region;
  }

  const known = Object.keys(SCALEWAY_REGIONS).join(', ');
  throw new Error(
    `Unknown Scaleway region "${region}". Known regions: ${known}. ` +
      'You can also pass a full endpoint URL.',
  );
}

// ── Configuration ───────────────────────────────────────────────

export type ScalewayConfig = ProviderConfig & {
  provider: 'scaleway';
  /** Scaleway region code (e.g. "fr-par") or full endpoint URL */
  region: string;
  /** Target bucket name */
  bucket: string;
  /** Access key (SCW_ACCESS_KEY) */
  accessKey: string;
  /** Secret key (SCW_SECRET_KEY) */
  secretKey: string;
  /** Optional key prefix to scope operations */
  prefix?: string;
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

  return {
    provider: 'scaleway',
    region: region as string,
    bucket: bucket as string,
    accessKey: accessKey as string,
    secretKey: secretKey as string,
    prefix: typeof prefix === 'string' ? prefix : undefined,
  };
}

// ── Provider implementation ─────────────────────────────────────

export class ScalewayProvider implements CloudProvider {
  readonly name = 'Scaleway Object Storage';

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: ScalewayConfig, client?: S3Client) {
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

      const response = await this.client.send(command);

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

  async upload(key: string, stream: Readable, contentType?: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: stream,
        ContentType: contentType,
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
}

// ── Factory ─────────────────────────────────────────────────────

/**
 * Factory function for the provider registry.
 */
export function createScalewayProvider(config: ProviderConfig): CloudProvider {
  const validated = validateScalewayConfig(config);
  return new ScalewayProvider(validated);
}
