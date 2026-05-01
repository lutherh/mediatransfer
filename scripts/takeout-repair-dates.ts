/**
 * Repair script for already-uploaded Takeout files with wrong date paths.
 *
 * Problem: Many files (especially __dup copies and .mov files) were uploaded
 * to S3 under 2026/02/... paths (file extraction time) instead of their actual
 * capture date, because the manifest didn't resolve sidecar metadata for dup
 * files or infer dates from filenames.
 *
 * This script:
 *  1. Rebuilds the manifest with the improved date logic
 *  2. Compares old vs new destination keys
 *  3. For changed keys, copies the S3 object to the correct path & deletes the old one
 *  4. Updates the upload state file to reflect the new keys
 *
 * Usage:
 *   npx tsx scripts/takeout-repair-dates.ts              # dry-run (default)
 *   npx tsx scripts/takeout-repair-dates.ts --apply       # actually move objects
 *   npx tsx scripts/takeout-repair-dates.ts --apply --concurrency 4
 */
import * as dotenv from 'dotenv';
import { ensureCaffeinate } from "../src/utils/caffeinate.js";
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';
import {
  buildManifest,
  loadManifestJsonl,
  persistManifestJsonl,
  type ManifestEntry,
} from '../src/takeout/manifest.js';
import type { UploadState } from '../src/takeout/uploader.js';
import {
  readNumberArg,
  createS3Helpers,
  s3Move,
} from './lib/repair-helpers.js';

dotenv.config();
ensureCaffeinate();

// ── Parse arguments ─────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const concurrency = readNumberArg(args, '--concurrency') ?? 4;

// ── Load config ─────────────────────────────────────────────────

const pathOverrides = parseTakeoutPathArgs(args);
const config = loadTakeoutConfig(undefined, pathOverrides);
const { s3, bucket, fullKey } = createS3Helpers();

// ── Step 1: Load old manifest, rebuild with fixed logic ──────────

const manifestPath = path.join(config.workDir, 'manifest.jsonl');
const normalizedRoot = path.join(config.workDir, 'normalized', 'Google Photos');

console.log('📋 Loading old manifest...');
const oldEntries = await loadManifestJsonl(manifestPath);
console.log(`   ${oldEntries.length} entries in old manifest`);

// Build lookup: relativePath → old entry
const oldByRelative = new Map<string, ManifestEntry>();
for (const entry of oldEntries) {
  oldByRelative.set(entry.relativePath, entry);
}

console.log('\n🔄 Rebuilding manifest with improved date logic...');
const newEntries = await buildManifest(normalizedRoot, (processed, total) => {
  if (processed % 500 === 0 || processed === total) {
    process.stdout.write(`\r   ${processed}/${total} files processed`);
  }
});
console.log('');

// ── Step 2: Compute moves needed ─────────────────────────────────

type MoveOp = {
  relativePath: string;
  oldKey: string;
  newKey: string;
  capturedAt: string;
};

const moves: MoveOp[] = [];
let alreadyCorrect = 0;
let notUploaded = 0;

// Load upload state to know which keys were actually uploaded
const statePath = config.statePath;
let uploadState: UploadState;
try {
  const raw = await fs.readFile(statePath, 'utf8');
  uploadState = JSON.parse(raw) as UploadState;
} catch (err) {
  throw new Error(`❌Could not read upload state from ${statePath}: ${(err as Error).message}`);
}

for (const newEntry of newEntries) {
  const oldEntry = oldByRelative.get(newEntry.relativePath);
  if (!oldEntry) {
    // New file not in old manifest — skip
    continue;
  }

  if (oldEntry.destinationKey === newEntry.destinationKey) {
    alreadyCorrect++;
    continue;
  }

  // Check if the old key was actually uploaded
  const stateItem = uploadState.items[oldEntry.destinationKey];
  if (!stateItem || stateItem.status !== 'uploaded') {
    notUploaded++;
    continue;
  }

  moves.push({
    relativePath: newEntry.relativePath,
    oldKey: oldEntry.destinationKey,
    newKey: newEntry.destinationKey,
    capturedAt: newEntry.capturedAt,
  });
}

console.log(`\n📊 Analysis complete:`);
console.log(`   Already correct:     ${alreadyCorrect}`);
console.log(`   Not uploaded (skip): ${notUploaded}`);
console.log(`   Need moving:         ${moves.length}`);

if (moves.length === 0) {
  console.log('\n✅ Nothing to repair!');
  process.exit(0);
}

// Show sample moves
console.log(`\n📦 Sample moves (first 10):`);
for (const move of moves.slice(0, 10)) {
  console.log(`   ${move.oldKey}`);
  console.log(`     → ${move.newKey}`);
}

if (!apply) {
  console.log(`\n⚠️  DRY RUN — no changes made. Run with --apply to execute ${moves.length} moves.`);

  // Still save the rebuilt manifest for inspection
  const previewPath = path.join(config.workDir, 'manifest-repaired-preview.jsonl');
  await persistManifestJsonl(newEntries, previewPath);
  console.log(`   Preview manifest saved to: ${previewPath}`);
  process.exit(0);
}

// ── Step 3: Execute S3 moves ─────────────────────────────────────

console.log(`\n🚀 Moving ${moves.length} objects on S3 (concurrency: ${concurrency})...`);

let completed = 0;
let errors = 0;
const failedMoves: MoveOp[] = [];

async function executeMoveOp(move: MoveOp): Promise<void> {
  const result = await s3Move(s3, bucket, fullKey(move.oldKey), fullKey(move.newKey));

  if (result.ok) {
    // Update upload state: remove old key, add new key
    const oldState = uploadState.items[move.oldKey];
    if (oldState) {
      delete uploadState.items[move.oldKey];
      uploadState.items[move.newKey] = {
        ...oldState,
        updatedAt: new Date().toISOString(),
      };
    }
    completed++;
  } else {
    errors++;
    failedMoves.push(move);
    console.error(`   ❌ Failed: ${move.oldKey} → ${move.newKey}: ${result.error}`);
  }

  if ((completed + errors) % 50 === 0 || completed + errors === moves.length) {
    process.stdout.write(`\r   ${completed + errors}/${moves.length} (${completed} ok, ${errors} failed)`);
  }
}

// Process in parallel batches
for (let i = 0; i < moves.length; i += concurrency) {
  const batch = moves.slice(i, i + concurrency);
  await Promise.all(batch.map(executeMoveOp));
}

console.log('');

// ── Step 4: Save updated manifest & state ────────────────────────

console.log('\n💾 Saving updated manifest...');
// Backup old manifest
await fs.copyFile(manifestPath, `${manifestPath}.pre-repair.bak`);
await persistManifestJsonl(newEntries, manifestPath);

console.log('💾 Saving updated upload state...');
await fs.copyFile(statePath, `${statePath}.pre-repair.bak`);
uploadState.updatedAt = new Date().toISOString();
await fs.writeFile(statePath, JSON.stringify(uploadState, null, 2), 'utf8');

console.log(`\n✅ Repair complete!`);
console.log(`   Moved:  ${completed}`);
console.log(`   Failed: ${errors}`);
if (failedMoves.length > 0) {
  const failedPath = path.join(config.workDir, 'repair-failed.json');
  await fs.writeFile(failedPath, JSON.stringify(failedMoves, null, 2), 'utf8');
  console.log(`   Failed moves saved to: ${failedPath}`);
}
