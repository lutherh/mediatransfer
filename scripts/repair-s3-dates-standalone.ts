/**
 * Standalone S3 date repair script — no local state needed.
 *
 * Scans S3 objects directly, finds files with suspicious date paths (current
 * year or "unknown-date"), downloads EXIF headers, and moves them to correct
 * date-based paths.
 *
 * Sources for correct dates (priority order):
 *  1. S3 custom metadata `x-amz-meta-captured-at` (set by newer uploads)
 *  2. EXIF DateTimeOriginal / CreateDate from the file itself (first 256 KB)
 *  3. Filename date patterns (IMG_20231215_143022.jpg)
 *  4. Skip — leave in place if no date can be determined
 *
 * Usage:
 *   npx tsx scripts/repair-s3-dates-standalone.ts                       # dry-run, default: current year
 *   npx tsx scripts/repair-s3-dates-standalone.ts --apply               # execute moves
 *   npx tsx scripts/repair-s3-dates-standalone.ts --prefix 2026         # scan transfers/2026/
 *   npx tsx scripts/repair-s3-dates-standalone.ts --prefix unknown-date # scan transfers/unknown-date/
 *   npx tsx scripts/repair-s3-dates-standalone.ts --concurrency 8 --apply
 */
import * as dotenv from 'dotenv';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {
  resolveScalewayEndpoint,
  resolveScalewaySigningRegion,
  validateScalewayConfig,
} from '../src/providers/scaleway.js';
import { extractExifMetadata, inferDateFromFilename } from '../src/utils/exif.js';

dotenv.config();

// ── Parse arguments ─────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const concurrency = readNumberArg(args, '--concurrency') ?? 8;

// Default: scan for current year (likely upload date, not capture date)
const scanPrefix = readStringArg(args, '--prefix') ?? String(new Date().getFullYear());

function readNumberArg(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  const val = Number(argv[idx + 1]);
  return Number.isFinite(val) ? val : undefined;
}

function readStringArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

// ── Load config ─────────────────────────────────────────────────

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

// ── Step 1: List S3 objects under the suspect prefix ─────────────

const targetPrefix = `transfers/${scanPrefix}/`;
console.log(`🔍 Scanning S3 for objects under: ${fullKey(targetPrefix)}`);
console.log(`   Bucket: ${bucket}`);
console.log(`   Mode: ${apply ? '🚀 APPLY (will move objects)' : '🔎 DRY RUN (no changes)'}`);
console.log('');

const objectKeys: string[] = [];
let continuationToken: string | undefined;

do {
  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: fullKey(targetPrefix),
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }),
  );

  for (const obj of result.Contents ?? []) {
    if (obj.Key && obj.Size && obj.Size > 0) {
      objectKeys.push(stripPrefix(obj.Key));
    }
  }

  continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  process.stdout.write(`\r   Listed ${objectKeys.length} objects...`);
} while (continuationToken);

console.log(`\r   Found ${objectKeys.length} objects under ${targetPrefix}`);

if (objectKeys.length === 0) {
  console.log('\n✅ Nothing to repair!');
  process.exit(0);
}

// ── Step 2: Determine correct dates ──────────────────────────────

type MoveOp = {
  oldKey: string;
  newKey: string;
  source: 'metadata' | 'exif' | 'filename';
  correctDate: string;
};

const EXIF_READ_BYTES = 256 * 1024;
const moves: MoveOp[] = [];
let fromMetadata = 0;
let fromExif = 0;
let fromFilename = 0;
let noDateFound = 0;
let exifErrors = 0;
let alreadyCorrect = 0;
let processed = 0;

const MEDIA_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'dng', 'tif', 'tiff',
  'mp4', 'mov', 'avi', 'm4v', '3gp', 'mkv', 'webm',
]);

function toDatePath(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function computeNewKey(oldKey: string, newDatePath: string): string {
  // oldKey: transfers/2026/03/15/AlbumName/IMG_1234.JPG
  //      or transfers/unknown-date/AlbumName/IMG_1234.JPG
  // We want: transfers/{newDatePath}/rest...

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

function isSuspiciousDate(date: Date): boolean {
  return date.getUTCFullYear() >= new Date().getFullYear();
}

function isMediaFile(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_EXTENSIONS.has(ext);
}

async function resolveDate(oldKey: string): Promise<MoveOp | null> {
  const filename = oldKey.split('/').pop() ?? '';

  if (!isMediaFile(oldKey)) {
    return null;
  }

  // 1. Check S3 custom metadata (x-amz-meta-captured-at)
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: fullKey(oldKey) }),
    );
    const capturedAtMeta = head.Metadata?.['captured-at'];
    if (capturedAtMeta && capturedAtMeta !== 'unknown') {
      const date = new Date(capturedAtMeta);
      if (!Number.isNaN(date.getTime()) && !isSuspiciousDate(date)) {
        const newDatePath = toDatePath(date);
        const newKey = computeNewKey(oldKey, newDatePath);
        if (newKey !== oldKey) {
          fromMetadata++;
          return { oldKey, newKey, source: 'metadata', correctDate: date.toISOString() };
        }
        alreadyCorrect++;
        return null;
      }
    }
  } catch {
    // HeadObject failed — continue to EXIF
  }

  // 2. Try EXIF from the first 256 KB
  try {
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: fullKey(oldKey),
        Range: `bytes=0-${EXIF_READ_BYTES - 1}`,
      }),
    );

    if (resp.Body) {
      const chunks: Buffer[] = [];
      for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const buf = Buffer.concat(chunks);
      const exif = await extractExifMetadata(buf);

      if (exif.capturedAt && !isSuspiciousDate(exif.capturedAt)) {
        const newDatePath = toDatePath(exif.capturedAt);
        const newKey = computeNewKey(oldKey, newDatePath);
        if (newKey !== oldKey) {
          fromExif++;
          return { oldKey, newKey, source: 'exif', correctDate: exif.capturedAt.toISOString() };
        }
        alreadyCorrect++;
        return null;
      }
    }
  } catch {
    exifErrors++;
  }

  // 3. Try filename date inference
  const filenameDate = inferDateFromFilename(filename);
  if (filenameDate && !isSuspiciousDate(filenameDate)) {
    const newDatePath = toDatePath(filenameDate);
    const newKey = computeNewKey(oldKey, newDatePath);
    if (newKey !== oldKey) {
      fromFilename++;
      return { oldKey, newKey, source: 'filename', correctDate: filenameDate.toISOString() };
    }
    alreadyCorrect++;
    return null;
  }

  noDateFound++;
  return null;
}

console.log('\n🔍 Resolving correct dates (downloading EXIF headers from S3)...\n');

for (let i = 0; i < objectKeys.length; i += concurrency) {
  const batch = objectKeys.slice(i, i + concurrency);
  const results = await Promise.all(batch.map(resolveDate));
  for (const result of results) {
    if (result) moves.push(result);
  }
  processed += batch.length;

  if (processed % 50 === 0 || processed === objectKeys.length) {
    process.stdout.write(
      `\r   ${processed}/${objectKeys.length} checked — ` +
      `${moves.length} to move (meta: ${fromMetadata}, exif: ${fromExif}, file: ${fromFilename}) ` +
      `| ${noDateFound} unknown | ${alreadyCorrect} ok | ${exifErrors} errors`,
    );
  }
}
console.log('\n');

console.log('📊 Date resolution summary:');
console.log(`   From S3 metadata: ${fromMetadata}`);
console.log(`   From EXIF:        ${fromExif}`);
console.log(`   From filename:    ${fromFilename}`);
console.log(`   Already correct:  ${alreadyCorrect}`);
console.log(`   No date found:    ${noDateFound} (will stay in place)`);
console.log(`   EXIF errors:      ${exifErrors}`);
console.log(`   Total to move:    ${moves.length}`);

if (moves.length === 0) {
  console.log('\n✅ Nothing to move!');
  process.exit(0);
}

// Show sample moves
console.log(`\n📦 Sample moves (first 20):`);
for (const move of moves.slice(0, 20)) {
  console.log(`   [${move.source}] ${move.oldKey}`);
  console.log(`          → ${move.newKey}  (${move.correctDate})`);
}

if (!apply) {
  console.log(`\n⚠️  DRY RUN — no changes made. Run with --apply to execute ${moves.length} moves.`);
  process.exit(0);
}

// ── Step 3: Execute S3 moves ─────────────────────────────────────

console.log(`\n🚀 Moving ${moves.length} objects on S3 (concurrency: ${concurrency})...`);

let moveCompleted = 0;
let moveErrors = 0;

async function executeMoveOp(move: MoveOp): Promise<void> {
  const sourceFullKey = fullKey(move.oldKey);
  const destFullKey = fullKey(move.newKey);

  try {
    // Check source still exists
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: sourceFullKey }));
    } catch {
      moveCompleted++;
      return; // Already moved or deleted
    }

    // Copy to new location, preserving metadata + adding captured-at
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceFullKey}`,
        Key: destFullKey,
        MetadataDirective: 'REPLACE',
        Metadata: { 'captured-at': move.correctDate },
      }),
    );

    // Verify the copy arrived
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: destFullKey }));
    } catch {
      throw new Error(`Copy verification failed for ${move.newKey}`);
    }

    // Delete old location
    await s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: sourceFullKey }),
    );

    moveCompleted++;
  } catch (err) {
    moveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n   ❌ ${move.oldKey} → ${move.newKey}: ${msg}`);
  }
}

for (let i = 0; i < moves.length; i += concurrency) {
  const batch = moves.slice(i, i + concurrency);
  await Promise.all(batch.map(executeMoveOp));

  const done = moveCompleted + moveErrors;
  if (done % 20 === 0 || done === moves.length) {
    process.stdout.write(
      `\r   ${done}/${moves.length} (${moveCompleted} moved, ${moveErrors} failed)`,
    );
  }
}

console.log('\n');
console.log('📊 Move results:');
console.log(`   Moved:  ${moveCompleted}`);
console.log(`   Failed: ${moveErrors}`);

if (moveErrors > 0) {
  console.log('\n⚠️  Some moves failed. Re-run the script to retry.');
} else {
  console.log('\n✅ All moves completed successfully!');
}
