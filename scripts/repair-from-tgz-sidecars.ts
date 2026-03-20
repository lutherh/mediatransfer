/**
 * Repair S3 dates using raw Google Takeout sidecar JSONs from .tgz archives.
 *
 * This script streams through the original Google Takeout .tgz archives,
 * extracts photoTakenTime from each .supplemental-metadata.json sidecar,
 * builds a filename→date lookup, then matches and moves the remaining
 * undated S3 files.
 *
 * Usage:
 *   npx tsx scripts/repair-from-tgz-sidecars.ts --tgz-dir "D:\archive-already-uploaded"
 *   npx tsx scripts/repair-from-tgz-sidecars.ts --tgz-dir "D:\archive-already-uploaded" --apply
 *   npx tsx scripts/repair-from-tgz-sidecars.ts --tgz-dir "D:\archive-already-uploaded" --prefix unknown-date --apply
 */
import * as dotenv from 'dotenv';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { Parser as TarParser } from 'tar';
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  resolveScalewayEndpoint,
  resolveScalewaySigningRegion,
  validateScalewayConfig,
} from '../src/providers/scaleway.js';

dotenv.config();

// ── Parse arguments ─────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const concurrency = readNumberArg(args, '--concurrency') ?? 8;
const scanPrefix = readStringArg(args, '--prefix') ?? String(new Date().getFullYear());
const tgzDir = readStringArg(args, '--tgz-dir');

if (!tgzDir) {
  console.error('❌ --tgz-dir is required. Point it at the directory with your .tgz archives.');
  console.error('   Example: npx tsx scripts/repair-from-tgz-sidecars.ts --tgz-dir "D:\\archive-already-uploaded"');
  process.exit(1);
}

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

// ── S3 config ───────────────────────────────────────────────────

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

// ── Step 1: Extract sidecar dates from .tgz archives ────────────

type SidecarDate = {
  date: Date;
  archiveFile: string;
  sidecarPath: string;
};

// Map: lowercase media filename → array of possible dates
const sidecarDates = new Map<string, SidecarDate[]>();

/**
 * Given a sidecar path like "photo.jpg.supplemental-metadata.json",
 * return the media filename it refers to ("photo.jpg").
 */
function mediaFilenameFromSidecar(sidecarEntryPath: string): string | null {
  const basename = path.basename(sidecarEntryPath);

  // Pattern 1: "photo.jpg.supplemental-metadata.json"
  if (basename.endsWith('.supplemental-metadata.json')) {
    return basename.slice(0, -'.supplemental-metadata.json'.length);
  }

  // Pattern 2: "photo.json" (direct sidecar, same name but .json ext)
  // Only if the remaining name has another extension (i.e., it's "photo.jpg" → "photo.json")
  if (basename.endsWith('.json')) {
    const withoutJson = basename.slice(0, -'.json'.length);
    const parentDir = path.dirname(sidecarEntryPath);
    // We can't check the directory here, but this pattern is common in Takeout
    // We'll store it and match later
    if (withoutJson.includes('.')) {
      // Has another extension — likely "metadata.json" for album, skip
      return null;
    }
    // No other extension — could be "IMG_1234.json" matching "IMG_1234.jpg"
    // Store with the base name so it can match any extension
    return withoutJson;
  }

  return null;
}

function parseSidecarDate(jsonString: string): Date | null {
  try {
    const parsed = JSON.parse(jsonString) as Record<string, unknown>;

    // Try photoTakenTime.timestamp (most reliable — unix seconds)
    const photoTakenTime = parsed.photoTakenTime as Record<string, unknown> | undefined;
    if (photoTakenTime?.timestamp) {
      const ts = Number(photoTakenTime.timestamp);
      if (Number.isFinite(ts) && ts > 0) {
        const date = new Date(ts * 1000);
        if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() < new Date().getFullYear()) {
          return date;
        }
      }
    }

    // Try creationTime.timestamp
    const creationTime = parsed.creationTime as Record<string, unknown> | undefined;
    if (creationTime?.timestamp) {
      const ts = Number(creationTime.timestamp);
      if (Number.isFinite(ts) && ts > 0) {
        const date = new Date(ts * 1000);
        if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() < new Date().getFullYear()) {
          return date;
        }
      }
    }

    // Try photoTakenTime.formatted as ISO string
    if (photoTakenTime?.formatted && typeof photoTakenTime.formatted === 'string') {
      const date = new Date(photoTakenTime.formatted as string);
      if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() < new Date().getFullYear()) {
        return date;
      }
    }
  } catch {
    // Malformed JSON — skip
  }
  return null;
}

async function extractSidecarsFromTgz(archivePath: string): Promise<number> {
  const archiveName = path.basename(archivePath);
  let found = 0;

  return new Promise<number>((resolve, reject) => {
    const parser = new TarParser({
      onReadEntry: (entry) => {
        const entryPath = entry.path;

        // Only process .supplemental-metadata.json and .json sidecars
        if (!entryPath.endsWith('.supplemental-metadata.json') && !entryPath.endsWith('.json')) {
          entry.resume();
          return;
        }

        // Skip album/directory metadata files
        const basename = path.basename(entryPath);
        if (basename === 'metadata.json' || basename === 'print-subscriptions.json' ||
            basename === 'shared_album_comments.json' || basename === 'user-generated-memory-titles.json') {
          entry.resume();
          return;
        }

        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          const json = Buffer.concat(chunks).toString('utf-8');
          const date = parseSidecarDate(json);
          if (!date) return;

          const mediaFile = mediaFilenameFromSidecar(entryPath);
          if (!mediaFile) return;

          const key = mediaFile.toLowerCase();
          const arr = sidecarDates.get(key) ?? [];
          arr.push({ date, archiveFile: archiveName, sidecarPath: entryPath });
          sidecarDates.set(key, arr);
          found++;
        });
      },
    });

    const readStream = fs.createReadStream(archivePath);
    const gunzip = createGunzip();

    readStream.on('error', reject);
    gunzip.on('error', reject);
    parser.on('error', reject);
    parser.on('end', () => resolve(found));

    readStream.pipe(gunzip).pipe(parser);
  });
}

console.log(`📂 Scanning .tgz archives in: ${tgzDir}`);

const tgzFiles = (await fsPromises.readdir(tgzDir))
  .filter(f => f.endsWith('.tgz') || f.endsWith('.tar.gz'))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

console.log(`   Found ${tgzFiles.length} archives\n`);

let totalSidecars = 0;
for (let i = 0; i < tgzFiles.length; i++) {
  const tgzPath = path.join(tgzDir, tgzFiles[i]);
  try {
    const found = await extractSidecarsFromTgz(tgzPath);
    totalSidecars += found;
    process.stdout.write(
      `\r   [${i + 1}/${tgzFiles.length}] ${tgzFiles[i]} — ${found} dates (total: ${totalSidecars}, unique filenames: ${sidecarDates.size})`,
    );
  } catch (err) {
    console.error(`\n   ⚠️  Error in ${tgzFiles[i]}: ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`\n\n📊 Sidecar extraction summary:`);
console.log(`   Total sidecar dates found: ${totalSidecars}`);
console.log(`   Unique media filenames:    ${sidecarDates.size}`);

if (sidecarDates.size === 0) {
  console.log('\n❌ No sidecar dates found. Check the --tgz-dir path.');
  process.exit(1);
}

// ── Step 2: List S3 objects under the suspect prefix ────────────

const targetPrefix = `transfers/${scanPrefix}/`;
console.log(`\n🔍 Scanning S3 for objects under: ${fullKey(targetPrefix)}`);
console.log(`   Mode: ${apply ? '🚀 APPLY (will move objects)' : '🔎 DRY RUN (no changes)'}`);
console.log('');

type S3Object = { key: string; size: number };
const objects: S3Object[] = [];
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
      objects.push({ key: stripPrefix(obj.Key), size: obj.Size });
    }
  }

  continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  process.stdout.write(`\r   Listed ${objects.length} objects...`);
} while (continuationToken);

console.log(`\r   Found ${objects.length} objects under ${targetPrefix}\n`);

if (objects.length === 0) {
  console.log('✅ Nothing to repair!');
  process.exit(0);
}

// ── Step 3: Match S3 files to sidecar dates ─────────────────────

const MEDIA_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'dng', 'tif', 'tiff',
  'mp4', 'mov', 'avi', 'm4v', '3gp', 'mkv', 'webm',
]);

function isMediaFile(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_EXTENSIONS.has(ext);
}

function toDatePath(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function computeNewKey(oldKey: string, newDatePath: string): string {
  if (oldKey.includes('unknown-date/')) {
    const rest = oldKey.split('unknown-date/')[1];
    return `transfers/${newDatePath}/${rest}`;
  }
  // Standard date path: transfers/YYYY/MM/DD/...
  const parts = oldKey.split('/');
  const rest = parts.slice(4).join('/');
  return `transfers/${newDatePath}/${rest}`;
}

function isSuspiciousDate(date: Date): boolean {
  return date.getUTCFullYear() >= new Date().getFullYear();
}

type MoveOp = {
  oldKey: string;
  newKey: string;
  correctDate: string;
  sidecarPath: string;
};

const moves: MoveOp[] = [];
let matched = 0;
let noMatch = 0;
let skippedNonMedia = 0;
let alreadyCorrect = 0;

console.log('🔍 Matching S3 files to sidecar dates...\n');

for (const obj of objects) {
  if (!isMediaFile(obj.key)) {
    skippedNonMedia++;
    continue;
  }

  const filename = (obj.key.split('/').pop() ?? '').toLowerCase();
  // Try exact filename match
  let entries = sidecarDates.get(filename);

  // If no match, try without __dupN suffix
  if (!entries) {
    const dupMatch = filename.match(/^(.+?)__dup\d+(\.[^.]+)$/);
    if (dupMatch) {
      entries = sidecarDates.get(`${dupMatch[1]}${dupMatch[2]}`);
    }
  }

  // If no match, try base name without extension (for .json sidecars that only store base name)
  if (!entries) {
    const ext = path.extname(filename);
    const baseName = filename.slice(0, -ext.length);
    entries = sidecarDates.get(baseName);
  }

  if (!entries || entries.length === 0) {
    noMatch++;
    continue;
  }

  // Pick the best date (prefer earliest non-suspicious date)
  const best = entries
    .filter(e => !isSuspiciousDate(e.date))
    .sort((a, b) => a.date.getTime() - b.date.getTime())[0];

  if (!best) {
    noMatch++;
    continue;
  }

  const newDatePath = toDatePath(best.date);
  const newKey = computeNewKey(obj.key, newDatePath);

  if (newKey === obj.key) {
    alreadyCorrect++;
    continue;
  }

  moves.push({
    oldKey: obj.key,
    newKey,
    correctDate: best.date.toISOString(),
    sidecarPath: best.sidecarPath,
  });
  matched++;
}

console.log('📊 Matching summary:');
console.log(`   Matched (movable):    ${matched}`);
console.log(`   No sidecar match:     ${noMatch}`);
console.log(`   Already correct:      ${alreadyCorrect}`);
console.log(`   Skipped (non-media):  ${skippedNonMedia}`);
console.log(`   Total S3 objects:     ${objects.length}`);

if (moves.length === 0) {
  console.log('\n✅ Nothing to move!');
  process.exit(0);
}

// Show sample moves
console.log(`\n📦 Sample moves (first 20):`);
for (const move of moves.slice(0, 20)) {
  console.log(`   ${move.oldKey}`);
  console.log(`     → ${move.newKey}  (${move.correctDate})`);
  console.log(`     sidecar: ${move.sidecarPath}`);
}

if (!apply) {
  console.log(`\n⚠️  DRY RUN — no changes made. Run with --apply to execute ${moves.length} moves.`);
  process.exit(0);
}

// ── Step 4: Execute S3 moves ─────────────────────────────────────

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
      return;
    }

    // Copy to new location with captured-at metadata
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceFullKey}`,
        Key: destFullKey,
        MetadataDirective: 'REPLACE',
        Metadata: { 'captured-at': move.correctDate },
      }),
    );

    // Verify the copy
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
