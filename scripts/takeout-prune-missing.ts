/**
 * takeout-prune-missing.ts
 *
 * Removes manifest entries and state records for source files that no longer
 * exist on disk (ENOENT). This is the correct fix when:
 *   - Normalization created __dup files that were later cleaned up
 *   - Albums/directories were removed from the work directory between runs
 *   - A re-scan rebuilt the normalized tree differently
 *
 * What it does:
 *   1. Reads manifest.jsonl — checks each entry's sourcePath on disk
 *   2. Removes entries where the source file is missing
 *   3. Removes corresponding ENOENT 'failed' entries from state.json
 *   4. Writes updated manifest.jsonl and state.json
 *
 * Usage:
 *   npx tsx scripts/takeout-prune-missing.ts              # dry-run (default)
 *   npx tsx scripts/takeout-prune-missing.ts --apply       # actually prune
 */
import * as dotenv from 'dotenv';
import { ensureCaffeinate } from "../src/utils/caffeinate.js";
import path from 'node:path';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';
import {
  loadManifestJsonl,
  persistManifestJsonl,
  type ManifestEntry,
} from '../src/takeout/manifest.js';
import {
  loadUploadState,
  persistUploadState,
} from '../src/takeout/uploader.js';

dotenv.config();
ensureCaffeinate();

const args = process.argv.slice(2);
const pathOverrides = parseTakeoutPathArgs(args);
const config = loadTakeoutConfig(undefined, pathOverrides);
const apply = args.includes('--apply');

const manifestPath = path.join(config.workDir, 'manifest.jsonl');

console.log('');
console.log('┌──────────────────────────────────────────┐');
console.log('│  Takeout Prune — Remove Missing Entries   │');
console.log('└──────────────────────────────────────────┘');
console.log('');

// ─── 1. Load manifest ──────────────────────────────────────────────────────

let manifest: ManifestEntry[];
try {
  manifest = await loadManifestJsonl(manifestPath);
} catch {
  console.error(`❌ Cannot load manifest at ${manifestPath}`);
  console.error('   Run takeout-scan first.');
  process.exit(1);
}

console.log(`📋 Manifest entries: ${manifest.length}`);

// ─── 2. Check which source files exist ─────────────────────────────────────

const keepEntries: ManifestEntry[] = [];
const pruneEntries: ManifestEntry[] = [];

for (const entry of manifest) {
  if (existsSync(entry.sourcePath)) {
    keepEntries.push(entry);
  } else {
    pruneEntries.push(entry);
  }
}

const dupPruned = pruneEntries.filter((e) => e.relativePath.includes('__dup')).length;
const nonDupPruned = pruneEntries.length - dupPruned;

console.log(`   ✅ Source exists:  ${keepEntries.length}`);
console.log(`   ❌ Source missing: ${pruneEntries.length}`);
console.log(`      └─ __dup files: ${dupPruned}`);
console.log(`      └─ other files: ${nonDupPruned}`);
console.log('');

if (pruneEntries.length === 0) {
  console.log('✅ Nothing to prune — all manifest entries have source files on disk.');
  process.exit(0);
}

// ─── 3. Check state.json ───────────────────────────────────────────────────

const state = await loadUploadState(config.statePath);
const pruneKeys = new Set(pruneEntries.map((e) => e.destinationKey));

let stateRemoved = 0;
let stateFailedRemoved = 0;
let stateUploadedRemoved = 0;
let stateOtherRemoved = 0;

for (const key of pruneKeys) {
  const item = state.items[key];
  if (item) {
    stateRemoved += 1;
    if (item.status === 'failed') stateFailedRemoved += 1;
    else if (item.status === 'uploaded') stateUploadedRemoved += 1;
    else stateOtherRemoved += 1;
  }
}

console.log(`📊 State entries to remove: ${stateRemoved}`);
console.log(`   └─ failed:   ${stateFailedRemoved}`);
console.log(`   └─ uploaded:  ${stateUploadedRemoved}`);
console.log(`   └─ other:     ${stateOtherRemoved}`);
console.log('');

if (stateUploadedRemoved > 0) {
  console.warn(`⚠️  ${stateUploadedRemoved} pruned entries were marked 'uploaded' in state.`);
  console.warn('   These files were uploaded but the source is now gone.');
  console.warn('   They will be removed from the manifest only (already in cloud).');
  console.warn('');
}

// ─── 4. Show sample pruned entries ─────────────────────────────────────────

console.log('📝 Sample entries to prune (first 10):');
for (const entry of pruneEntries.slice(0, 10)) {
  console.log(`   - ${entry.destinationKey}`);
}
if (pruneEntries.length > 10) {
  console.log(`   ... and ${pruneEntries.length - 10} more`);
}
console.log('');

// ─── 5. Apply or dry-run ──────────────────────────────────────────────────

if (!apply) {
  console.log('🔍 DRY RUN — no changes made. Pass --apply to execute.');
  console.log('');
  console.log('   npx tsx scripts/takeout-prune-missing.ts --apply');
  console.log('');
  process.exit(0);
}

// Back up originals
const manifestBackup = `${manifestPath}.backup-${Date.now()}`;
const stateBackup = `${config.statePath}.backup-${Date.now()}`;

await fs.copyFile(manifestPath, manifestBackup);
console.log(`💾 Backed up manifest → ${path.basename(manifestBackup)}`);

await fs.copyFile(config.statePath, stateBackup);
console.log(`💾 Backed up state    → ${path.basename(stateBackup)}`);

// Write pruned manifest
await persistManifestJsonl(keepEntries, manifestPath);
console.log(`✏️  Wrote manifest: ${keepEntries.length} entries (removed ${pruneEntries.length})`);

// Remove pruned keys from state
for (const key of pruneKeys) {
  delete state.items[key];
}
await persistUploadState(config.statePath, state);
console.log(`✏️  Wrote state: ${Object.keys(state.items).length} entries (removed ${stateRemoved})`);

console.log('');
console.log('✅ Prune complete. You can now re-run verify:');
console.log('   npx tsx scripts/takeout-verify.ts');
console.log('');
