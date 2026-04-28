/**
 * Enhanced date repair for already-uploaded Takeout files with wrong date paths.
 *
 * Extends the original takeout-repair-dates-s3.ts with additional date resolution
 * strategies for files that had no sidecar metadata:
 *
 *   1. Direct sidecar lookup (exact key, album+file, unique basename)
 *   2. Edited→non-edited sidecar lookup (-edited.PNG → .PNG sidecar)
 *   3. Stem cross-extension lookup (IMG_0917.MP4 → IMG_0917.JPG sidecar)
 *   4. EXIF / video header extraction from S3 (images + MP4/MOV moov atom)
 *   5. Album median date inference (median of dated files in same album)
 *
 * Usage:
 *   npx tsx scripts/takeout-repair-dates-enhanced.ts                  # dry-run
 *   npx tsx scripts/takeout-repair-dates-enhanced.ts --apply          # execute
 *   npx tsx scripts/takeout-repair-dates-enhanced.ts --apply --concurrency 8
 *   npx tsx scripts/takeout-repair-dates-enhanced.ts --apply --save-every 200
 *   npx tsx scripts/takeout-repair-dates-enhanced.ts --prefix 2026/03/15  # only fix this date
 *   npx tsx scripts/takeout-repair-dates-enhanced.ts --skip-s3        # skip S3 EXIF reads
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
import type { MediaItemMetadata, SidecarMetadata } from '../src/takeout/archive-metadata.js';
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
  readStringArg,
  createS3Helpers,
  toDatePath,
  computeNewKey,
  s3Move,
} from './lib/repair-helpers.js';

dotenv.config();

// ── Parse arguments ─────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const skipS3 = args.includes('--skip-s3');
const concurrency = readNumberArg(args, '--concurrency') ?? 8;
const saveEvery = readNumberArg(args, '--save-every') ?? 500;
const prefixFilter = readStringArg(args, '--prefix');

// ── Load config ─────────────────────────────────────────────────

const pathOverrides = parseTakeoutPathArgs(args);
const config = loadTakeoutConfig(undefined, pathOverrides);
const { s3, bucket, fullKey } = createS3Helpers();

// ── Step 1: Load archive metadata ───────────────────────────────

const metadataDir = path.join(config.workDir, 'metadata');
console.log('📂 Loading archive metadata...');
const allMetadata = await loadAllArchiveMetadata(metadataDir);
const allItems = allMetadata.flatMap(m => m.items);
console.log(`   ${allMetadata.length} archive metadata files loaded`);
console.log(`   ${allItems.length} total items`);

// Build standard three-level sidecar lookup
const sidecarLookup = buildSidecarLookup(allItems);
console.log(`   ${sidecarLookup.byKey.size} items with sidecar metadata (byKey)`);

// ── Build enhanced lookups ──────────────────────────────────────

// Lookup: basename (without -edited suffix) → sidecar with date
// Used for strategy 2: edited→non-edited
const sidecarByBasename = new Map<string, SidecarMetadata[]>();
for (const item of allItems) {
  if (!item.sidecar || (!item.sidecar.photoTakenTime && !item.sidecar.creationTime)) continue;
  const basename = item.destinationKey.split('/').pop()!;
  if (!sidecarByBasename.has(basename)) sidecarByBasename.set(basename, []);
  sidecarByBasename.get(basename)!.push(item.sidecar);
}

// Lookup: filename stem (no extension) → sidecar with date
// Used for strategy 3: cross-extension stem match
const sidecarByStem = new Map<string, SidecarMetadata[]>();
for (const item of allItems) {
  if (!item.sidecar || (!item.sidecar.photoTakenTime && !item.sidecar.creationTime)) continue;
  const basename = item.destinationKey.split('/').pop()!;
  const stem = basename.replace(/\.[^.]+$/, '');
  if (!sidecarByStem.has(stem)) sidecarByStem.set(stem, []);
  sidecarByStem.get(stem)!.push(item.sidecar);
}

// Lookup: album name → array of resolved Date objects (for median calculation)
// Used for strategy 5: album median inference
const albumDates = new Map<string, Date[]>();
for (const item of allItems) {
  if (!item.album) continue;
  if (item.sidecar && (item.sidecar.photoTakenTime || item.sidecar.creationTime)) {
    const d = parseSidecarDate(item.sidecar);
    if (d && !isWrongDate(d)) {
      if (!albumDates.has(item.album)) albumDates.set(item.album, []);
      albumDates.get(item.album)!.push(d);
    }
  }
}

// Pre-compute album medians
const albumMedian = new Map<string, Date>();
for (const [album, dates] of albumDates) {
  dates.sort((a, b) => a.getTime() - b.getTime());
  const mid = Math.floor(dates.length / 2);
  albumMedian.set(album, dates[mid]);
}

console.log(`   ${sidecarByBasename.size} unique basename sidecar entries`);
console.log(`   ${sidecarByStem.size} unique stem sidecar entries`);
console.log(`   ${albumMedian.size} albums with computable median dates`);

// Build item-to-album lookup for the 2026 items
const itemAlbum = new Map<string, string>();
for (const item of allItems) {
  if (item.album && item.destinationKey) {
    itemAlbum.set(item.destinationKey, item.album);
  }
}

// ── Step 2: Load upload state & find items to fix ────────────────

const statePath = config.statePath;
let uploadState: UploadState;
try {
  const raw = await fs.readFile(statePath, 'utf8');
  uploadState = JSON.parse(raw) as UploadState;
} catch (err) {
  throw new Error(`Could not read upload state: ${(err as Error).message}`);
}

const filterPrefix = prefixFilter
  ? `s3transfers/${prefixFilter}`
  : 's3transfers/2026/';

const wrongDateKeys = Object.entries(uploadState.items)
  .filter(([key, item]) => key.startsWith(filterPrefix) && item.status === 'uploaded')
  .map(([key]) => key);

console.log(`\n📊 Found ${wrongDateKeys.length} files under ${filterPrefix} to check`);

if (wrongDateKeys.length === 0) {
  console.log('✅ Nothing to repair!');
  process.exit(0);
}

// ── Step 3: Date resolution with enhanced strategies ─────────────

type DateSource = 'sidecar' | 'sidecar-edited' | 'sidecar-stem' | 'exif' | 'video' | 'filename' | 'album-median';

type MoveOp = {
  oldKey: string;
  newKey: string;
  source: DateSource;
};

const EXIF_READ_BYTES = 256 * 1024;
const MAX_MOOV_READ = 2 * 1024 * 1024;

const moves: MoveOp[] = [];
const missingKeys: string[] = [];
const counts: Record<DateSource | 'no-date' | 's3-missing' | 'errors', number> = {
  'sidecar': 0,
  'sidecar-edited': 0,
  'sidecar-stem': 0,
  'exif': 0,
  'video': 0,
  'filename': 0,
  'album-median': 0,
  'no-date': 0,
  's3-missing': 0,
  'errors': 0,
};

console.log('\n🔍 Determining correct dates with enhanced resolution...');
if (skipS3) console.log('   (Skipping S3 EXIF/video reads — using metadata-only strategies)');

function tryResolveSidecarDate(sidecar: SidecarMetadata): Date | undefined {
  const d = parseSidecarDate(sidecar);
  return d && !isWrongDate(d) ? d : undefined;
}

function makeMove(oldKey: string, date: Date, source: DateSource): MoveOp | null {
  const newDatePath = toDatePath(date);
  const newKey = computeNewKey(oldKey, newDatePath);
  if (newKey !== oldKey) {
    counts[source]++;
    return { oldKey, newKey, source };
  }
  return null;
}

async function resolveDate(oldKey: string): Promise<MoveOp | null> {
  const filename = oldKey.split('/').pop() ?? '';
  const stem = filename.replace(/\.[^.]+$/, '');

  // Strategy 1: Standard three-level sidecar lookup
  const sidecar = resolveSidecar(sidecarLookup, oldKey);
  if (sidecar) {
    const date = tryResolveSidecarDate(sidecar);
    if (date) return makeMove(oldKey, date, 'sidecar');
  }

  // Strategy 2: Edited → non-edited sidecar lookup
  if (filename.includes('-edited')) {
    const nonEditedName = filename.replace('-edited', '');
    const entries = sidecarByBasename.get(nonEditedName);
    if (entries?.length === 1) {
      const date = tryResolveSidecarDate(entries[0]);
      if (date) return makeMove(oldKey, date, 'sidecar-edited');
    }
    // Also try cross-extension for edited files
    const nonEditedStem = nonEditedName.replace(/\.[^.]+$/, '');
    const stemEntries = sidecarByStem.get(nonEditedStem);
    if (stemEntries?.length === 1) {
      const date = tryResolveSidecarDate(stemEntries[0]);
      if (date) return makeMove(oldKey, date, 'sidecar-edited');
    }
  }

  // Strategy 3: Stem cross-extension lookup (e.g., IMG_0917.MP4 → IMG_0917.JPG sidecar)
  const stemEntries = sidecarByStem.get(stem);
  if (stemEntries?.length === 1) {
    const date = tryResolveSidecarDate(stemEntries[0]);
    if (date) return makeMove(oldKey, date, 'sidecar-stem');
  }

  // Strategy 4a: Filename date inference
  const filenameDate = inferDateFromFilename(filename);
  if (filenameDate && !isWrongDate(filenameDate)) {
    const m = makeMove(oldKey, filenameDate, 'filename');
    if (m) return m;
  }

  // Strategy 4b: Download from S3 and extract EXIF / video creation date
  if (!skipS3) {
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

        if (isVideoKey(oldKey)) {
          // Video: try moov/mvhd atom
          const result = extractVideoCreationDateFromBuffer(buf);
          if (result.date && !isWrongDate(result.date)) {
            const m = makeMove(oldKey, result.date, 'video');
            if (m) return m;
          }

          // moov beyond initial read — follow-up fetch
          if (!result.date && result.moovOffset !== undefined) {
            try {
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
                    const m = makeMove(oldKey, videoDate, 'video');
                    if (m) return m;
                  }
                }
              }
            } catch {
              // moov fetch failed — fall through
            }
          }
        } else {
          // Image: EXIF
          const exif = await extractExifMetadata(buf);
          if (exif.capturedAt && !isWrongDate(exif.capturedAt)) {
            const m = makeMove(oldKey, exif.capturedAt, 'exif');
            if (m) return m;
          }
        }
      }
    } catch (err: any) {
      if (err.Code === 'NoSuchKey' || err.name === 'NoSuchKey') {
        counts['s3-missing']++;
        missingKeys.push(oldKey);
        return null;
      }
      counts['errors']++;
      if (counts['errors'] <= 5) {
        console.error(`\n   ⚠ S3 error for ${oldKey}: ${err.Code ?? err.name ?? 'unknown'}`);
      }
    }
  }

  // Strategy 5: Album median date inference
  const album = itemAlbum.get(oldKey);
  if (album) {
    const median = albumMedian.get(album);
    if (median) {
      const m = makeMove(oldKey, median, 'album-median');
      if (m) return m;
    }
  }

  counts['no-date']++;
  return null;
}

// Process in parallel batches
let processed = 0;
for (let i = 0; i < wrongDateKeys.length; i += concurrency) {
  const batch = wrongDateKeys.slice(i, i + concurrency);
  const results = await Promise.all(batch.map(resolveDate));
  for (const result of results) {
    if (result) moves.push(result);
  }
  processed += batch.length;

  if (processed % 100 === 0 || processed === wrongDateKeys.length) {
    const total = counts.sidecar + counts['sidecar-edited'] + counts['sidecar-stem'] + counts.exif + counts.video + counts.filename + counts['album-median'];
    process.stdout.write(
      `\r   ${processed}/${wrongDateKeys.length} checked — ` +
        `${total} to move | ${counts['no-date']} undetermined | ${counts['s3-missing']} missing`,
    );
  }
}
console.log('');

// ── Report ──────────────────────────────────────────────────────

console.log(`\n📊 Date resolution complete:`);
console.log(`   From sidecar (direct):    ${counts.sidecar}`);
console.log(`   From sidecar (edited):    ${counts['sidecar-edited']}`);
console.log(`   From sidecar (stem):      ${counts['sidecar-stem']}`);
console.log(`   From EXIF:                ${counts.exif}`);
console.log(`   From video header:        ${counts.video}`);
console.log(`   From filename:            ${counts.filename}`);
console.log(`   From album median:        ${counts['album-median']}`);
console.log(`   ──────────────────────────────`);
console.log(`   Total to move:            ${moves.length}`);
console.log(`   No date found:            ${counts['no-date']}`);
console.log(`   S3 missing:               ${counts['s3-missing']}`);
console.log(`   Errors:                   ${counts.errors}`);

// Destination date distribution
const destDates: Record<string, number> = {};
for (const m of moves) {
  const parts = m.newKey.split('/');
  const datePath = parts.slice(1, 4).join('/');
  destDates[datePath] = (destDates[datePath] || 0) + 1;
}
const sorted = Object.entries(destDates).sort((a, b) => b[1] - a[1]);
console.log(`\n📅 Destination date distribution (top 20):`);
for (const [date, count] of sorted.slice(0, 20)) {
  console.log(`   ${date}: ${count}`);
}

// Show sample moves by source
console.log(`\n📦 Sample moves by source:`);
const bySource = new Map<DateSource, MoveOp[]>();
for (const m of moves) {
  if (!bySource.has(m.source)) bySource.set(m.source, []);
  bySource.get(m.source)!.push(m);
}
for (const [source, ops] of bySource) {
  console.log(`\n   [${source}] (${ops.length} total):`);
  for (const op of ops.slice(0, 3)) {
    console.log(`     ${op.oldKey}`);
    console.log(`       → ${op.newKey}`);
  }
}

// Save plan
const planPath = path.join(config.workDir, 'repair-enhanced-plan.json');
await fs.writeFile(
  planPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      totalToMove: moves.length,
      noDateFound: counts['no-date'],
      breakdown: counts,
      destDistribution: sorted.slice(0, 50),
      moves: moves.slice(0, 500),
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

// Back up state before changes
const backupPath = `${statePath}.pre-enhanced-repair.bak`;
await fs.copyFile(statePath, backupPath);
console.log(`\n💾 State backed up to: ${backupPath}`);

console.log(`\n🚀 Moving ${moves.length} objects on S3 (concurrency: ${concurrency})...`);

let moveCompleted = 0;
let moveErrors = 0;
const failedMoves: MoveOp[] = [];

async function executeMoveOp(move: MoveOp): Promise<void> {
  const result = await s3Move(s3, bucket, fullKey(move.oldKey), fullKey(move.newKey));

  if (result.ok) {
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

for (let i = 0; i < moves.length; i += concurrency) {
  const batch = moves.slice(i, i + concurrency);
  await Promise.all(batch.map(executeMoveOp));

  const done = moveCompleted + moveErrors;
  if (done % 50 === 0 || done === moves.length) {
    process.stdout.write(
      `\r   ${done}/${moves.length} (${moveCompleted} ok, ${moveErrors} failed)`,
    );
  }

  // Periodic state save
  if (done > 0 && done % saveEvery === 0) {
    uploadState.updatedAt = new Date().toISOString();
    await fs.writeFile(statePath, JSON.stringify(uploadState, null, 2), 'utf8');
  }
}

console.log('');

// ── Step 5: Save final state ─────────────────────────────────────

console.log('\n💾 Saving updated upload state...');
uploadState.updatedAt = new Date().toISOString();
await fs.writeFile(statePath, JSON.stringify(uploadState, null, 2), 'utf8');

console.log(`\n✅ Enhanced repair complete!`);
console.log(`   Moved:      ${moveCompleted}`);
console.log(`   Failed:     ${moveErrors}`);
console.log(`   Unchanged:  ${counts['no-date']} (no date found)`);

if (failedMoves.length > 0) {
  const failedPath = path.join(config.workDir, 'repair-enhanced-failed.json');
  await fs.writeFile(failedPath, JSON.stringify(failedMoves, null, 2), 'utf8');
  console.log(`   Failed moves saved to: ${failedPath}`);
}

// ── Step 6: Clean up stale state entries for missing S3 objects ──

if (missingKeys.length > 0) {
  console.log(`\n🧹 Cleaning ${missingKeys.length} stale state entries (S3 objects no longer exist)...`);
  for (const key of missingKeys) {
    delete uploadState.items[key];
  }
  uploadState.updatedAt = new Date().toISOString();
  await fs.writeFile(statePath, JSON.stringify(uploadState, null, 2), 'utf8');
  console.log(`   Removed ${missingKeys.length} stale entries from state.json`);
}
