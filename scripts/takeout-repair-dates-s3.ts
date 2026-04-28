/**
 * Repair script for already-uploaded Takeout files with wrong date paths.
 *
 * Works directly from S3 — no local files needed. For each misplaced file
 * under s3transfers/2026/, downloads the first 256 KB to extract EXIF dates,
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
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';
import { loadAllArchiveMetadata } from '../src/takeout/archive-metadata.js';
import { extractExifMetadata, inferDateFromFilename, extractVideoCreationDateFromBuffer, extractVideoCreationDateFromMoov } from '../src/utils/exif.js';
import {
  parseSidecarDate,
  isWrongDate,
  isVideoKey,
  buildSidecarLookup,
  resolveSidecar,
} from '../src/utils/date-repair.js';
import type { UploadState } from '../src/takeout/uploader.js';
import {
  readNumberArg,
  createS3Helpers,
  toDatePath,
  computeNewKey,
  s3Move,
} from './lib/repair-helpers.js';

dotenv.config();

// ── Parse arguments ─────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const concurrency = readNumberArg(args, '--concurrency') ?? 8;
const saveEvery = readNumberArg(args, '--save-every') ?? 500;

// ── Load config ─────────────────────────────────────────────────

const pathOverrides = parseTakeoutPathArgs(args);
const config = loadTakeoutConfig(undefined, pathOverrides);
const { s3, bucket, fullKey } = createS3Helpers();

// ── Step 1: Load archive metadata for sidecar dates ──────────────

const metadataDir = path.join(config.workDir, 'metadata');
console.log('📂 Loading archive metadata...');
const allMetadata = await loadAllArchiveMetadata(metadataDir);
console.log(`   ${allMetadata.length} archive metadata files loaded`);

// Build three-level sidecar lookup from all archive metadata
const allItems = allMetadata.flatMap(m => m.items);
const sidecarLookup = buildSidecarLookup(allItems);
console.log(`   ${sidecarLookup.byKey.size} items with sidecar metadata`);
console.log(`   ${sidecarLookup.byAlbumFile.size} unique album+filename sidecar entries`);
console.log(`   ${sidecarLookup.byBasename.size} unique basename sidecar entries`);

// ── Step 2: Load upload state, find items to fix ─────────────────

const statePath = config.statePath;
let uploadState: UploadState;
try {
  const raw = await fs.readFile(statePath, 'utf8');
  uploadState = JSON.parse(raw) as UploadState;
} catch (err) {
  throw new Error(`Could not read upload state: ${(err as Error).message}`);
}

// Find all uploaded items under s3transfers/2026/
const wrongDateKeys = Object.entries(uploadState.items)
  .filter(([key, item]) => key.startsWith('s3transfers/2026/') && item.status === 'uploaded')
  .map(([key]) => key);

console.log(`\n📊 Found ${wrongDateKeys.length} files under s3transfers/2026/ to check`);

if (wrongDateKeys.length === 0) {
  console.log('✅ Nothing to repair!');
  process.exit(0);
}

// ── Step 3: Determine correct dates ──────────────────────────────

type MoveOp = {
  oldKey: string;
  newKey: string;
  source: 'sidecar' | 'exif' | 'filename' | 'video';
};

console.log('\n🔍 Determining correct dates...');
console.log(`   (Will download EXIF/video headers from S3 for files without sidecar dates)`);

const EXIF_READ_BYTES = 256 * 1024;
const MAX_MOOV_READ = 2 * 1024 * 1024; // 2 MB max moov atom read

const moves: MoveOp[] = [];
let fromSidecar = 0;
let fromExif = 0;
let fromFilename = 0;
let fromVideo = 0;
let noDateFound = 0;
let exifErrors = 0;
let s3Missing = 0;
let processed = 0;

async function resolveDate(oldKey: string): Promise<MoveOp | null> {
  const filename = oldKey.split('/').pop() ?? '';

  // 1. Try sidecar metadata — three-level lookup:
  //    a) exact destinationKey, b) album+filename, c) unique basename
  const sidecar = resolveSidecar(sidecarLookup, oldKey);
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

  // 3. Download header from S3 and extract date (EXIF for images, moov/mvhd for videos)
  try {
    const objectKey = fullKey(oldKey);
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Range: `bytes=0-${EXIF_READ_BYTES - 1}`,
      }),
    );

    if (resp.Body) {
      const chunks: Buffer[] = [];
      for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const buf = Buffer.concat(chunks);

      // For videos: try moov/mvhd atom parsing
      if (isVideoKey(oldKey)) {
        const result = extractVideoCreationDateFromBuffer(buf);
        if (result.date && !isWrongDate(result.date)) {
          const newDatePath = toDatePath(result.date);
          const newKey = computeNewKey(oldKey, newDatePath);
          if (newKey !== oldKey) {
            fromVideo++;
            return { oldKey, newKey, source: 'video' };
          }
        }

        // moov is beyond the initial read — fetch from the computed offset
        if (!result.date && result.moovOffset !== undefined) {
          try {
            // Get actual file size via HEAD
            const head = await s3.send(
              new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
            );
            const fileSize = head.ContentLength ?? 0;
            if (result.moovOffset < fileSize) {
              const moovEnd = Math.min(result.moovOffset + MAX_MOOV_READ, fileSize) - 1;
              const moovResp = await s3.send(
                new GetObjectCommand({
                  Bucket: bucket,
                  Key: objectKey,
                  Range: `bytes=${result.moovOffset}-${moovEnd}`,
                }),
              );
              if (moovResp.Body) {
                const moovChunks: Buffer[] = [];
                for await (const chunk of moovResp.Body as AsyncIterable<Uint8Array>) {
                  moovChunks.push(Buffer.from(chunk));
                }
                const moovBuf = Buffer.concat(moovChunks);
                const videoDate = extractVideoCreationDateFromMoov(moovBuf);
                if (videoDate && !isWrongDate(videoDate)) {
                  const newDatePath = toDatePath(videoDate);
                  const newKey = computeNewKey(oldKey, newDatePath);
                  if (newKey !== oldKey) {
                    fromVideo++;
                    return { oldKey, newKey, source: 'video' };
                  }
                }
              }
            }
          } catch {
            // moov fetch failed — fall through to no date
          }
        }
      } else {
        // For images: use EXIF parser
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
    }
  } catch (err: any) {
    if (err.Code === 'NoSuchKey' || err.name === 'NoSuchKey') {
      s3Missing++;
    } else {
      exifErrors++;
      if (exifErrors <= 5) {
        console.error(`\n   ⚠ S3 error for ${oldKey}: ${err.Code ?? err.name ?? 'unknown'} — ${String(err.message).slice(0, 120)}`);
      }
    }
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
        `${moves.length} to move (sidecar: ${fromSidecar}, exif: ${fromExif}, video: ${fromVideo}, filename: ${fromFilename}) ` +
        `| ${noDateFound} undetermined | ${s3Missing} missing | ${exifErrors} errors`,
    );
  }
}
console.log('');

console.log(`\n📊 Date resolution complete:`);
console.log(`   From sidecar:  ${fromSidecar}`);
console.log(`   From EXIF:     ${fromExif}`);
console.log(`   From video:    ${fromVideo}`);
console.log(`   From filename: ${fromFilename}`);
console.log(`   No date found: ${noDateFound} (will stay in s3transfers/2026/)`);
console.log(`   S3 missing:    ${s3Missing} (objects deleted/moved previously)`);
console.log(`   Other errors:  ${exifErrors}`);
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
  const result = await s3Move(s3, bucket, fullKey(move.oldKey), fullKey(move.newKey));

  if (result.ok) {
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
  } else {
    moveErrors++;
    failedMoves.push(move);
    console.error(`\n   ❌ ${move.oldKey} → ${move.newKey}: ${result.error}`);
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
