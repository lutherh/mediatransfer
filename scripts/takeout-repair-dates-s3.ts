/**
 * Repair script for already-uploaded Takeout files with wrong date paths.
 *
 * Works directly from S3 — no local files needed. For each misplaced file
 * under transfers/2026/, downloads the first 256 KB to extract EXIF dates,
 * then copies the object to the correct date path and deletes the old one.
 *
 * Sources for correct dates (priority order):
 *  1. Archive metadata sidecar (photoTakenTime / creationTime)
 *  2. EXIF DateTimeOriginal / CreateDate from the file itself
 *  3. Filename date patterns (IMG_20231215_143022.jpg)
 *  4. Skip — leave in place if no date can be determined
 *
 * Usage:
 *   npx tsx scripts/takeout-repair-dates-s3.ts                    # dry-run
 *   npx tsx scripts/takeout-repair-dates-s3.ts --apply            # execute
 *   npx tsx scripts/takeout-repair-dates-s3.ts --apply --concurrency 8
 *   npx tsx scripts/takeout-repair-dates-s3.ts --apply --save-every 200
 */
import * as dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  S3Client,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';
import { loadAllArchiveMetadata, type SidecarMetadata } from '../src/takeout/archive-metadata.js';
import { extractExifMetadata, inferDateFromFilename } from '../src/utils/exif.js';
import type { UploadState } from '../src/takeout/uploader.js';
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
const saveEvery = readNumberArg(args, '--save-every') ?? 500;

function readNumberArg(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  const val = Number(argv[idx + 1]);
  return Number.isFinite(val) ? val : undefined;
}

// ── Load config ─────────────────────────────────────────────────

const pathOverrides = parseTakeoutPathArgs(args);
const config = loadTakeoutConfig(undefined, pathOverrides);
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

// ── Step 1: Load archive metadata for sidecar dates ──────────────

const metadataDir = path.join(config.workDir, 'metadata');
console.log('📂 Loading archive metadata...');
const allMetadata = await loadAllArchiveMetadata(metadataDir);
console.log(`   ${allMetadata.length} archive metadata files loaded`);

// Build lookup: destinationKey → sidecar metadata
const sidecarByKey = new Map<string, SidecarMetadata>();
for (const meta of allMetadata) {
  for (const item of meta.items) {
    if (item.sidecar) {
      sidecarByKey.set(item.destinationKey, item.sidecar);
    }
  }
}
console.log(`   ${sidecarByKey.size} items with sidecar metadata`);

// ── Step 2: Load upload state, find items to fix ─────────────────

const statePath = config.statePath;
let uploadState: UploadState;
try {
  const raw = await fs.readFile(statePath, 'utf8');
  uploadState = JSON.parse(raw) as UploadState;
} catch (err) {
  throw new Error(`Could not read upload state: ${(err as Error).message}`);
}

// Find all uploaded items under transfers/2026/
const wrongDateKeys = Object.entries(uploadState.items)
  .filter(([key, item]) => key.startsWith('transfers/2026/') && item.status === 'uploaded')
  .map(([key]) => key);

console.log(`\n📊 Found ${wrongDateKeys.length} files under transfers/2026/ to check`);

if (wrongDateKeys.length === 0) {
  console.log('✅ Nothing to repair!');
  process.exit(0);
}

// ── Step 3: Determine correct dates ──────────────────────────────

type MoveOp = {
  oldKey: string;
  newKey: string;
  source: 'sidecar' | 'exif' | 'filename';
};

console.log('\n🔍 Determining correct dates...');
console.log(`   (Will download EXIF headers from S3 for files without sidecar dates)`);

const EXIF_READ_BYTES = 256 * 1024;
const moves: MoveOp[] = [];
let fromSidecar = 0;
let fromExif = 0;
let fromFilename = 0;
let noDateFound = 0;
let exifErrors = 0;
let processed = 0;

function toDatePath(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function parseSidecarDate(sidecar: SidecarMetadata): Date | undefined {
  // photoTakenTime as unix timestamp string
  if (sidecar.photoTakenTime) {
    const ts = Number(sidecar.photoTakenTime);
    if (Number.isFinite(ts) && ts > 0) {
      return new Date(ts * 1000);
    }
    // Try as ISO string
    const d = new Date(sidecar.photoTakenTime);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (sidecar.creationTime) {
    const ts = Number(sidecar.creationTime);
    if (Number.isFinite(ts) && ts > 0) {
      return new Date(ts * 1000);
    }
    const d = new Date(sidecar.creationTime);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function computeNewKey(oldKey: string, newDatePath: string): string {
  // oldKey: transfers/2026/03/15/AlbumName/IMG_1234.JPG
  // We want:  transfers/{newDatePath}/AlbumName/IMG_1234.JPG
  // The date portion is always transfers/YYYY/MM/DD/...
  const parts = oldKey.split('/');
  // parts[0] = 'transfers', [1] = year, [2] = month, [3] = day, [4+] = rest
  const rest = parts.slice(4).join('/');
  return `transfers/${newDatePath}/${rest}`;
}

function isWrongDate(date: Date): boolean {
  const year = date.getUTCFullYear();
  // If the date is 2026 it's probably extraction time, not capture time
  // But some photos legitimately from 2026 Jan/Feb/Mar could be valid
  // We only fix dates that point to the future or match the extraction window
  return year >= 2026;
}

async function resolveDate(oldKey: string): Promise<MoveOp | null> {
  const filename = oldKey.split('/').pop() ?? '';

  // 1. Try sidecar metadata
  const sidecar = sidecarByKey.get(oldKey);
  if (sidecar) {
    const date = parseSidecarDate(sidecar);
    if (date && !isWrongDate(date)) {
      const newDatePath = toDatePath(date);
      const newKey = computeNewKey(oldKey, newDatePath);
      if (newKey !== oldKey) {
        fromSidecar++;
        return { oldKey, newKey, source: 'sidecar' };
      }
    }
  }

  // 2. Try filename date inference
  const filenameDate = inferDateFromFilename(filename);
  if (filenameDate && !isWrongDate(filenameDate)) {
    const newDatePath = toDatePath(filenameDate);
    const newKey = computeNewKey(oldKey, newDatePath);
    if (newKey !== oldKey) {
      fromFilename++;
      return { oldKey, newKey, source: 'filename' };
    }
  }

  // 3. Download EXIF header from S3
  try {
    const s3Key = fullKey(oldKey);
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: s3Key,
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

      if (exif.capturedAt && !isWrongDate(exif.capturedAt)) {
        const newDatePath = toDatePath(exif.capturedAt);
        const newKey = computeNewKey(oldKey, newDatePath);
        if (newKey !== oldKey) {
          fromExif++;
          return { oldKey, newKey, source: 'exif' };
        }
      }
    }
  } catch {
    exifErrors++;
  }

  noDateFound++;
  return null;
}

// Process in parallel batches to resolve dates
for (let i = 0; i < wrongDateKeys.length; i += concurrency) {
  const batch = wrongDateKeys.slice(i, i + concurrency);
  const results = await Promise.all(batch.map(resolveDate));
  for (const result of results) {
    if (result) moves.push(result);
  }
  processed += batch.length;

  if (processed % 100 === 0 || processed === wrongDateKeys.length) {
    process.stdout.write(
      `\r   ${processed}/${wrongDateKeys.length} checked — ` +
        `${moves.length} to move (sidecar: ${fromSidecar}, exif: ${fromExif}, filename: ${fromFilename}) ` +
        `| ${noDateFound} undetermined | ${exifErrors} errors`,
    );
  }
}
console.log('');

console.log(`\n📊 Date resolution complete:`);
console.log(`   From sidecar:  ${fromSidecar}`);
console.log(`   From EXIF:     ${fromExif}`);
console.log(`   From filename: ${fromFilename}`);
console.log(`   No date found: ${noDateFound} (will stay in transfers/2026/)`);
console.log(`   EXIF errors:   ${exifErrors}`);
console.log(`   Total to move: ${moves.length}`);

if (moves.length === 0) {
  console.log('\n✅ Nothing to move!');
  process.exit(0);
}

// Show sample moves
console.log(`\n📦 Sample moves (first 15):`);
for (const move of moves.slice(0, 15)) {
  console.log(`   [${move.source}] ${move.oldKey}`);
  console.log(`          → ${move.newKey}`);
}

// Save plan for inspection
const planPath = path.join(config.workDir, 'repair-s3-plan.json');
await fs.writeFile(
  planPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      totalToMove: moves.length,
      noDateFound,
      breakdown: { fromSidecar, fromExif, fromFilename },
      moves: moves.slice(0, 200), // first 200 for inspection
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`\n   Full plan saved to: ${planPath}`);

if (!apply) {
  console.log(`\n⚠️  DRY RUN — no changes made. Run with --apply to execute ${moves.length} moves.`);
  process.exit(0);
}

// ── Step 4: Execute S3 moves ─────────────────────────────────────

console.log(`\n🚀 Moving ${moves.length} objects on S3 (concurrency: ${concurrency})...`);

let moveCompleted = 0;
let moveErrors = 0;
const failedMoves: MoveOp[] = [];

async function executeMoveOp(move: MoveOp): Promise<void> {
  const sourceFullKey = fullKey(move.oldKey);
  const destFullKey = fullKey(move.newKey);

  try {
    // Check source exists
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: sourceFullKey }));
    } catch {
      // Already moved or deleted — just update state
      moveCompleted++;
      return;
    }

    // Copy to new location
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceFullKey}`,
        Key: destFullKey,
      }),
    );

    // Delete old location
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: sourceFullKey,
      }),
    );

    // Update state: remove old key, add new key
    const oldState = uploadState.items[move.oldKey];
    if (oldState) {
      delete uploadState.items[move.oldKey];
      uploadState.items[move.newKey] = {
        ...oldState,
        updatedAt: new Date().toISOString(),
      };
    }

    moveCompleted++;
  } catch (err) {
    moveErrors++;
    failedMoves.push(move);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n   ❌ ${move.oldKey} → ${move.newKey}: ${msg}`);
  }
}

// Process in parallel batches with periodic state saves
for (let i = 0; i < moves.length; i += concurrency) {
  const batch = moves.slice(i, i + concurrency);
  await Promise.all(batch.map(executeMoveOp));

  const done = moveCompleted + moveErrors;
  if (done % 50 === 0 || done === moves.length) {
    process.stdout.write(
      `\r   ${done}/${moves.length} (${moveCompleted} ok, ${moveErrors} failed)`,
    );
  }

  // Periodic state save to allow resume
  if (done > 0 && done % saveEvery === 0) {
    uploadState.updatedAt = new Date().toISOString();
    await fs.writeFile(statePath, JSON.stringify(uploadState, null, 2), 'utf8');
  }
}

console.log('');

// ── Step 5: Save final state ─────────────────────────────────────

console.log('\n💾 Saving updated upload state...');
await fs.copyFile(statePath, `${statePath}.pre-s3-repair.bak`);
uploadState.updatedAt = new Date().toISOString();
await fs.writeFile(statePath, JSON.stringify(uploadState, null, 2), 'utf8');

console.log(`\n✅ Repair complete!`);
console.log(`   Moved:      ${moveCompleted}`);
console.log(`   Failed:     ${moveErrors}`);
console.log(`   Unchanged:  ${noDateFound} (no date found)`);

if (failedMoves.length > 0) {
  const failedPath = path.join(config.workDir, 'repair-s3-failed.json');
  await fs.writeFile(failedPath, JSON.stringify(failedMoves, null, 2), 'utf8');
  console.log(`   Failed moves saved to: ${failedPath}`);
}
