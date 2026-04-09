/**
 * Repair S3 dates using raw Google Takeout sidecar JSONs from .tgz archives.
 *
 * This script streams through the original Google Takeout .tgz archives,
 * extracts photoTakenTime from each .supplemental-metadata.json sidecar,
 * builds a filename→date lookup, then matches and moves the remaining
 * undated S3 files.
 *
 * Usage:
 *   npx tsx scripts/repair-from-tgz-sidecars.ts --tgz-dir "/path/to/archives"
 *   npx tsx scripts/repair-from-tgz-sidecars.ts --tgz-dir "/path/to/archives" --apply
 *   npx tsx scripts/repair-from-tgz-sidecars.ts --tgz-dir "/path/to/archives" --prefix unknown-date --apply
 */
import * as dotenv from 'dotenv';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { Parser as TarParser } from 'tar';
import {
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  readNumberArg,
  readStringArg,
  createS3Helpers,
  toDatePath,
  computeNewKey,
  isSuspiciousDate,
  isMediaFile,
  s3Move,
} from './lib/repair-helpers.js';

dotenv.config();

// ── Parse arguments ─────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const concurrency = readNumberArg(args, '--concurrency') ?? 8;
const scanPrefix = readStringArg(args, '--prefix') ?? String(new Date().getFullYear());
const tgzDir = readStringArg(args, '--tgz-dir');

if (!tgzDir) {
  console.error('❌ --tgz-dir is required. Point it at the directory with your .tgz archives.');
  console.error('   Example: npx tsx scripts/repair-from-tgz-sidecars.ts --tgz-dir "/path/to/archives"');
  process.exit(1);
}

// ── S3 config ───────────────────────────────────────────────────

const { s3, bucket, fullKey, stripPrefix } = createS3Helpers();

// ── Step 1: Extract sidecar dates from .tgz archives ────────────

type SidecarDate = {
  date: Date;
  archiveFile: string;
  sidecarPath: string;
};

// Map: lowercase media filename → array of possible dates
const sidecarDates = new Map<string, SidecarDate[]>();

// ── Logging ─────────────────────────────────────────────────────

type LogRecord = {
  s3_old_path: string;
  s3_new_path: string;
  captured_date: string;
  source_archive: string;
  sidecar_path: string;
  status: 'moved' | 'failed' | 'skipped';
};

const logRecords: LogRecord[] = [];
const archiveStats = new Map<string, { total: number; moved: number; failed: number }>();

async function ensureRepairsDir(): Promise<void> {
  const dir = path.join(process.cwd(), 'repairs');
  await fsPromises.mkdir(dir, { recursive: true });
}

async function writeLogFile(): Promise<string> {
  const timestamp = new Date().toISOString().slice(0, 10);
  const logFile = path.join(process.cwd(), 'repairs', `tgz-sidecar-repairs-${timestamp}.log`);
  
  // Header + TSV records
  const tsv = [
    'S3_OLD_PATH\tS3_NEW_PATH\tCAPTURED_DATE\tSOURCE_ARCHIVE\tSIDECAR_PATH\tSTATUS',
    ...logRecords.map(r =>
      [r.s3_old_path, r.s3_new_path, r.captured_date, r.source_archive, r.sidecar_path, r.status]
        .join('\t')
    ),
  ].join('\n');
  
  await fsPromises.writeFile(logFile, tsv, 'utf-8');
  return logFile;
}

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

type MoveOp = {
  oldKey: string;
  newKey: string;
  correctDate: string;
  sidecarPath: string;
  sourceArchive: string;
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
    sourceArchive: best.archiveFile,
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
  console.log(`     archive: ${move.sourceArchive}`);
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
  const result = await s3Move(s3, bucket, fullKey(move.oldKey), fullKey(move.newKey), {
    'captured-at': move.correctDate,
  });

  const logEntry: LogRecord = {
    s3_old_path: move.oldKey,
    s3_new_path: move.newKey,
    captured_date: move.correctDate,
    source_archive: move.sourceArchive,
    sidecar_path: move.sidecarPath,
    status: result.ok ? 'moved' : 'failed',
  };
  logRecords.push(logEntry);

  const stats = archiveStats.get(move.sourceArchive) ?? { total: 0, moved: 0, failed: 0 };
  stats.total++;

  if (result.ok) {
    moveCompleted++;
    stats.moved++;
  } else {
    moveErrors++;
    stats.failed++;
    console.error(`\n   ❌ ${move.oldKey} → ${move.newKey}: ${result.error}`);
  }

  archiveStats.set(move.sourceArchive, stats);
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

// Write log file
await ensureRepairsDir();
const logFile = await writeLogFile();
console.log(`\n📝 Detailed log: ${logFile}`);

// Show summary by archive
if (archiveStats.size > 0) {
  console.log('\n📦 Repairs by archive:');
  const sortedArchives = Array.from(archiveStats.entries())
    .sort((a, b) => b[1].moved - a[1].moved);
  
  for (const [archive, stats] of sortedArchives.slice(0, 20)) {
    const percentage = stats.total > 0 ? ((stats.moved / stats.total) * 100).toFixed(0) : '0';
    console.log(`   ${archive}: ${stats.moved}/${stats.total} (${percentage}%)`);
  }
  
  if (sortedArchives.length > 20) {
    console.log(`   ... and ${sortedArchives.length - 20} more archives`);
  }
}

if (moveErrors > 0) {
  console.log('\n⚠️  Some moves failed. Re-run the script to retry.');
} else {
  console.log('\n✅ All moves completed successfully!');
}
