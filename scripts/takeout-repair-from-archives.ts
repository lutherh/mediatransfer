/**
 * Repair script for files with wrong dates on S3 by re-deriving dates from
 * local backup tgz archives.
 *
 * The existing S3 repair script (`takeout-repair-dates-s3.ts`) can only read
 * the first 256 KB from S3 for EXIF headers, and cannot extract video
 * container dates (moov/mvhd atoms are typically at the end of MP4/MOV files).
 *
 * This script instead extracts each tgz from a local backup directory,
 * runs the full deriveCapturedDate chain (sidecar → filename → EXIF → video
 * container), and generates S3 move operations for files with wrong dates.
 *
 * Usage:
 *   npx tsx scripts/takeout-repair-from-archives.ts                          # dry-run
 *   npx tsx scripts/takeout-repair-from-archives.ts --apply                  # execute
 *   npx tsx scripts/takeout-repair-from-archives.ts --apply --concurrency 8
 *   npx tsx scripts/takeout-repair-from-archives.ts --archive-dir "D:\archive-already-uploaded"
 *   npx tsx scripts/takeout-repair-from-archives.ts --start-at 50            # resume from archive #50
 */
import * as dotenv from 'dotenv';
import { ensureCaffeinate } from "../src/utils/caffeinate.js";
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';
import { buildManifest, type ManifestEntry } from '../src/takeout/manifest.js';
import { extractArchive } from '../src/takeout/unpack.js';
import { normalizeTakeoutMediaRoot } from '../src/takeout/unpack.js';
import type { UploadState } from '../src/takeout/uploader.js';
import {
  readNumberArg,
  readStringArg,
  createS3Helpers,
  s3Move,
} from './lib/repair-helpers.js';

dotenv.config();
ensureCaffeinate();

// ── Parse arguments ─────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const concurrency = readNumberArg(args, '--concurrency') ?? 8;
const saveEvery = readNumberArg(args, '--save-every') ?? 200;
const startAt = readNumberArg(args, '--start-at') ?? 0;
const archiveDirArg = readStringArg(args, '--archive-dir');

// ── Load config ─────────────────────────────────────────────────

const pathOverrides = parseTakeoutPathArgs(args);
const config = loadTakeoutConfig(undefined, pathOverrides);
const archiveDir = archiveDirArg;
if (!archiveDir) {
  console.error('❌ --archive-dir is required.');
  console.error('   Example: npx tsx scripts/takeout-repair-from-archives.ts --archive-dir "/path/to/archives"');
  process.exit(1);
}

const { s3, bucket, fullKey } = createS3Helpers();

// ── Step 1: Load state, identify wrong-date files ────────────────

console.log('📂 Loading upload state...');
const statePath = config.statePath;
let uploadState: UploadState;
try {
  const raw = await fs.readFile(statePath, 'utf8');
  uploadState = JSON.parse(raw) as UploadState;
} catch (err) {
  throw new Error(`Could not read upload state: ${(err as Error).message}`);
}

// All items currently under s3transfers/2026/
const wrongDateEntries = new Map<string, { status: string }>();
for (const [key, item] of Object.entries(uploadState.items)) {
  if (key.startsWith('s3transfers/2026/') && item.status === 'uploaded') {
    wrongDateEntries.set(key, item);
  }
}

console.log(`📊 Found ${wrongDateEntries.size} files under s3transfers/2026/ to check`);

if (wrongDateEntries.size === 0) {
  console.log('✅ Nothing to repair!');
  process.exit(0);
}

// Build a reverse lookup: the path suffix after the date portion → current S3 key
// For "s3transfers/2026/03/15/AlbumName/IMG_1234.JPG" the suffix is "AlbumName/IMG_1234.JPG"
const suffixToKey = new Map<string, string>();
for (const key of wrongDateEntries.keys()) {
  const parts = key.split('/');
  // parts[0] = 'transfers', [1] = year, [2] = month, [3] = day, [4+] = rest
  const suffix = parts.slice(4).join('/');
  suffixToKey.set(suffix, key);
}

// ── Step 2: Discover and process tgz archives ────────────────────

console.log(`\n📦 Scanning archive directory: ${archiveDir}`);
const archiveFiles = (await fs.readdir(archiveDir))
  .filter((f) => f.endsWith('.tgz') || f.endsWith('.tar.gz') || f.endsWith('.zip'))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

console.log(`   Found ${archiveFiles.length} archives`);

type MoveOp = {
  oldKey: string;
  newKey: string;
  source: string; // date source description
};

const allMoves: MoveOp[] = [];
let archivesProcessed = 0;
let archivesSkipped = 0;
let filesExamined = 0;
let datesResolved = 0;
let datesUnresolvable = 0;
let alreadyCorrect = 0;

// Track which wrong-date keys we've successfully resolved
const resolvedKeys = new Set<string>();

// Progress file for resuming
const progressPath = path.join(config.workDir, 'repair-from-archives-progress.json');

// Load existing progress if resuming
let existingMoves: MoveOp[] = [];
if (startAt > 0) {
  try {
    const progressRaw = await fs.readFile(progressPath, 'utf8');
    const progress = JSON.parse(progressRaw);
    existingMoves = progress.moves ?? [];
    allMoves.push(...existingMoves);
    for (const m of existingMoves) resolvedKeys.add(m.oldKey);
    console.log(`   Resuming from archive #${startAt}, loaded ${existingMoves.length} previous moves`);
  } catch {
    // No progress file — starting fresh from startAt
  }
}

console.log(`\n🔍 Processing archives to derive correct dates...`);
console.log(`   (Extracting each archive, running full date derivation chain)`);
console.log(`   (sidecar JSON → filename → EXIF → video container)\n`);

for (let i = startAt; i < archiveFiles.length; i++) {
  const archiveName = archiveFiles[i];
  const archivePath = path.join(archiveDir, archiveName);

  // Create a temp directory for extraction
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repair-archive-'));

  try {
    process.stdout.write(
      `\r  [${i + 1}/${archiveFiles.length}] Extracting ${archiveName}...`.padEnd(100),
    );

    // Extract the archive
    await extractArchive(archivePath, tempDir);

    // Find and normalize the Google Photos root
    let mediaRoot: string;
    try {
      mediaRoot = await normalizeTakeoutMediaRoot(tempDir);
    } catch {
      // No Google Photos folder found — skip this archive
      archivesSkipped++;
      continue;
    }

    // Build manifest with full date derivation
    const entries = await buildManifest(mediaRoot);

    if (entries.length === 0) {
      archivesSkipped++;
      continue;
    }

    archivesProcessed++;
    let archiveMoves = 0;

    for (const entry of entries) {
      filesExamined++;

      // The destination key computed by buildManifest uses the CORRECT date
      // We need to find the corresponding wrong-date S3 key
      //
      // The path suffix (after the date portion) should match between
      // the original upload and the new computation
      const parts = entry.destinationKey.split('/');
      // parts[0] = 'transfers', [1+] = datePath + rest
      // For "s3transfers/2020/07/15/Album/IMG.jpg" → suffix is "Album/IMG.jpg"
      const suffix = parts.slice(4).join('/');

      const currentS3Key = suffixToKey.get(suffix);
      if (!currentS3Key) {
        // This file isn't in the wrong-date set — might already be correct
        // or wasn't uploaded from this batch
        continue;
      }

      if (resolvedKeys.has(currentS3Key)) {
        continue; // Already resolved by a previous archive
      }

      // Check if the new date is different from 2026
      if (entry.datePath.startsWith('2026/') || entry.datePath === 'unknown-date') {
        // deriveCapturedDate couldn't find a better date even with full local access
        datesUnresolvable++;
        continue;
      }

      // We have a proper date! Generate a move operation
      const newKey = `s3transfers/${entry.datePath}/${suffix}`;
      if (newKey !== currentS3Key) {
        allMoves.push({
          oldKey: currentS3Key,
          newKey,
          source: `archive:${archiveName}`,
        });
        resolvedKeys.add(currentS3Key);
        datesResolved++;
        archiveMoves++;
      } else {
        alreadyCorrect++;
      }
    }

    if (archiveMoves > 0) {
      process.stdout.write(
        `\r  [${i + 1}/${archiveFiles.length}] ${archiveName}: ${entries.length} files, ${archiveMoves} dates resolved`.padEnd(100) + '\n',
      );
    }

    // Save progress periodically
    if ((i + 1) % 10 === 0) {
      await fs.writeFile(
        progressPath,
        JSON.stringify({
          lastArchiveIndex: i,
          timestamp: new Date().toISOString(),
          moves: allMoves,
          stats: { archivesProcessed, filesExamined, datesResolved, datesUnresolvable },
        }, null, 2),
        'utf8',
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n   ⚠️  Error processing ${archiveName}: ${msg}`);
  } finally {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

process.stdout.write('\r' + ' '.repeat(100) + '\r');

// ── Step 3: Report ───────────────────────────────────────────────

console.log(`\n📊 Archive scan complete:`);
console.log(`   Archives processed: ${archivesProcessed} (skipped: ${archivesSkipped})`);
console.log(`   Files examined:     ${filesExamined}`);
console.log(`   Dates resolved:     ${datesResolved}`);
console.log(`   Still unresolvable: ${datesUnresolvable}`);
console.log(`   Already correct:    ${alreadyCorrect}`);
console.log(`   Total S3 moves:     ${allMoves.length}`);
console.log(`   Remaining in 2026/: ${wrongDateEntries.size - resolvedKeys.size}`);

if (allMoves.length === 0) {
  console.log('\n✅ No moves needed!');
  process.exit(0);
}

// Show sample moves
console.log(`\n📦 Sample moves (first 20):`);
for (const move of allMoves.slice(0, 20)) {
  console.log(`   ${move.oldKey}`);
  console.log(`     → ${move.newKey}  [${move.source}]`);
}

// Save full plan
const planPath = path.join(config.workDir, 'repair-from-archives-plan.json');
await fs.writeFile(
  planPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      totalToMove: allMoves.length,
      remaining: wrongDateEntries.size - resolvedKeys.size,
      stats: { archivesProcessed, archivesSkipped, filesExamined, datesResolved, datesUnresolvable },
      moves: allMoves,
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`\n   Full plan saved to: ${planPath}`);

if (!apply) {
  console.log(`\n⚠️  DRY RUN — no changes made. Run with --apply to execute ${allMoves.length} moves.`);
  process.exit(0);
}

// ── Step 4: Execute S3 moves ─────────────────────────────────────

console.log(`\n🚀 Moving ${allMoves.length} objects on S3 (concurrency: ${concurrency})...`);

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

// Process in parallel batches
for (let i = 0; i < allMoves.length; i += concurrency) {
  const batch = allMoves.slice(i, i + concurrency);
  await Promise.all(batch.map(executeMoveOp));

  const done = moveCompleted + moveErrors;
  if (done % 50 === 0 || done === allMoves.length) {
    process.stdout.write(
      `\r   ${done}/${allMoves.length} (${moveCompleted} ok, ${moveErrors} failed)`,
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

uploadState.updatedAt = new Date().toISOString();
await fs.writeFile(statePath, JSON.stringify(uploadState, null, 2), 'utf8');

console.log(`\n✅ Repair complete:`);
console.log(`   Moved:  ${moveCompleted}`);
console.log(`   Failed: ${moveErrors}`);

if (failedMoves.length > 0) {
  const failPath = path.join(config.workDir, 'repair-from-archives-failed.json');
  await fs.writeFile(failPath, JSON.stringify(failedMoves, null, 2), 'utf8');
  console.log(`   Failed moves saved to: ${failPath}`);
}
