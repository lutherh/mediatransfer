/**
 * Shared helpers for repair scripts.
 *
 * Consolidates duplicated utilities (CLI arg parsing, S3 client setup,
 * date-path helpers, media-extension checks) used across the repair scripts.
 */
import {
  S3Client,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  resolveScalewayEndpoint,
  resolveScalewaySigningRegion,
  validateScalewayConfig,
} from '../../src/providers/scaleway.js';
import {
  MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from '../../src/utils/media-extensions.js';

// ── CLI argument helpers ────────────────────────────────────────

export function readNumberArg(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  const val = Number(argv[idx + 1]);
  return Number.isFinite(val) ? val : undefined;
}

export function readStringArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

// ── S3 helpers ──────────────────────────────────────────────────

export type S3Helpers = {
  s3: S3Client;
  bucket: string;
  s3Prefix: string;
  fullKey: (key: string) => string;
  stripPrefix: (key: string) => string;
};

/**
 * Create an S3 client and key helpers from environment variables.
 * Reads SCW_REGION, SCW_BUCKET, SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_PREFIX.
 */
export function createS3Helpers(): S3Helpers {
  const scwConfig = validateScalewayConfig({
    provider: 'scaleway',
    region: process.env.SCW_REGION,
    bucket: process.env.SCW_BUCKET,
    accessKey: process.env.SCW_ACCESS_KEY,
    secretKey: process.env.SCW_SECRET_KEY,
    prefix: process.env.SCW_PREFIX,
  });

  const s3 = new S3Client({
    region: resolveScalewaySigningRegion(scwConfig.region),
    endpoint: resolveScalewayEndpoint(scwConfig.region),
    credentials: {
      accessKeyId: scwConfig.accessKey,
      secretAccessKey: scwConfig.secretKey,
    },
    forcePathStyle: true,
  });

  const bucket = scwConfig.bucket;
  const s3Prefix = scwConfig.prefix ?? '';

  function fullKey(key: string): string {
    return s3Prefix ? `${s3Prefix}/${key}` : key;
  }

  function stripPrefix(key: string): string {
    if (!s3Prefix) return key;
    const prefixed = `${s3Prefix}/`;
    return key.startsWith(prefixed) ? key.slice(prefixed.length) : key;
  }

  return { s3, bucket, s3Prefix, fullKey, stripPrefix };
}

// ── Date-path helpers ───────────────────────────────────────────

/** Convert a Date to a `YYYY/MM/DD` path segment. */
export function toDatePath(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/**
 * Rewrite the date portion of an S3 key.
 *
 * Handles both `transfers/YYYY/MM/DD/…` and `transfers/unknown-date/…` layouts.
 */
export function computeNewKey(oldKey: string, newDatePath: string): string {
  if (oldKey.includes('unknown-date/')) {
    const rest = oldKey.split('unknown-date/')[1];
    return `transfers/${newDatePath}/${rest}`;
  }
  // Standard date path: transfers/YYYY/MM/DD/...
  const parts = oldKey.split('/');
  // parts[0] = 'transfers', [1] = year, [2] = month, [3] = day, [4+] = rest
  const rest = parts.slice(4).join('/');
  return `transfers/${newDatePath}/${rest}`;
}

/** True when the date falls in the current year or later (likely upload/extraction time). */
export function isSuspiciousDate(date: Date): boolean {
  return date.getUTCFullYear() >= new Date().getFullYear();
}

// ── Media-extension helpers ─────────────────────────────────────

/** Check whether an S3 key points to a known media file. */
export function isMediaFile(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_EXTENSIONS.has(`.${ext}`);
}

/** Check whether an S3 key points to an ISO BMFF video file (MP4/MOV/M4V/3GP). */
export function isVideoFile(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.has(`.${ext}`);
}

// ── S3 move helpers ─────────────────────────────────────────────

export type MoveResult = { ok: true } | { ok: false; error: string };

/**
 * Perform a verified S3 move: HeadObject (source) → CopyObject → HeadObject (dest) → DeleteObject.
 *
 * Returns a result object instead of throwing, so callers can handle
 * failures without try/catch boilerplate.
 */
export async function s3Move(
  s3: S3Client,
  bucket: string,
  sourceKey: string,
  destKey: string,
  metadata?: Record<string, string>,
): Promise<MoveResult> {
  try {
    // Check source still exists
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: sourceKey }));
    } catch {
      return { ok: true }; // Already moved or deleted
    }

    // Copy to new location
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceKey}`,
        Key: destKey,
        MetadataDirective: metadata ? 'REPLACE' : 'COPY',
        ...(metadata ? { Metadata: metadata } : {}),
      }),
    );

    // Verify the copy arrived
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: destKey }));
    } catch {
      return { ok: false, error: `Copy verification failed for ${destKey}` };
    }

    // Delete old location
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }));

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
