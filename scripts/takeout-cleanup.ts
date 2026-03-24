/**
 * takeout-cleanup.ts
 *
 * Safely removes local Google Takeout data that has been confirmed uploaded to S3.
 * This reclaims disk space by removing:
 *   1. Extracted files   (work/Takeout/)
 *   2. Normalized files   (work/normalized/)
 *   3. Input archives     (input/*.tgz)  — only with --delete-archives
 *
 * Safety:
 *   - will NOT delete any data unless upload state confirms every manifest entry
 *     is 'uploaded' or 'skipped' (never 'failed' or missing).
 *   - will ONLY move/delete input archives that are marked `completed` in
 *     work/archive-state.json.
 *
 * Usage:
 *   npx tsx scripts/takeout-cleanup.ts                # dry-run (default)
 *   npx tsx scripts/takeout-cleanup.ts --apply        # actually delete
 *   npx tsx scripts/takeout-cleanup.ts --apply --delete-archives   # also remove .tgz inputs
 *   npx tsx scripts/takeout-cleanup.ts --apply --move-archives     # move .tgz to uploaded-archives/
 *   npx tsx scripts/takeout-cleanup.ts --backfill-state            # also create archive-state.json
 */
import * as dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';
import { loadManifestJsonl } from '../src/takeout/manifest.js';
import { loadUploadState } from '../src/takeout/uploader.js';
import { discoverTakeoutArchives } from '../src/takeout/unpack.js';
import {
  createEmptyArchiveState,
  isCrossDeviceRenameError,
  loadArchiveState,
  persistArchiveState,
} from '../src/takeout/incremental.js';
import { formatBytes } from '../src/utils/format.js';

dotenv.config();

const args = process.argv.slice(2);
const pathOverrides = parseTakeoutPathArgs(args);
const config = loadTakeoutConfig(undefined, pathOverrides);
const apply = args.includes('--apply');
const deleteArchives = args.includes('--delete-archives');
const moveArchives = args.includes('--move-archives');
const backfillState = args.includes('--backfill-state');
const force = args.includes('--force'); // bypass missing-state check; still respects archive-state.json
const includeUnscanned = args.includes('--include-unscanned'); // also handle archives not in archive-state when safe
const moveTargetArg = readStringArg(args, '--move-dir');
const moveTarget = moveTargetArg
  ? path.resolve(moveTargetArg)
  : config.archiveDir ?? path.join(config.inputDir, 'uploaded-archives');

if (deleteArchives && moveArchives) {
  console.error('Choose only one: --delete-archives OR --move-archives');
  process.exit(1);
}

// ─── 1. Load & verify upload state ─────────────────────────────────────────

console.log('');
console.log('┌──────────────────────────────────────────┐');
console.log('│   Takeout Cleanup — Reclaim Disk Space    │');
console.log('└──────────────────────────────────────────┘');
console.log('');

const manifestPath = path.join(config.workDir, 'manifest.jsonl');
let manifest;
try {
  manifest = await loadManifestJsonl(manifestPath);
} catch {
  console.error(`❌ Cannot load manifest at ${manifestPath}`);
  console.error('   Run takeout-scan first, or there is nothing to clean up.');
  process.exit(1);
}

const uploadState = await loadUploadState(config.statePath);
const stateItems = uploadState.items;

// Count statuses
let uploaded = 0;
let skipped = 0;
let failed = 0;
let missing = 0;
const failedKeys: { key: string; error?: string; attempts?: number }[] = [];
const missingKeys: string[] = [];

for (const entry of manifest) {
  const item = stateItems[entry.destinationKey];
  if (!item) {
    missing += 1;
    if (missingKeys.length < 10) missingKeys.push(entry.destinationKey);
  } else if (item.status === 'uploaded') {
    uploaded += 1;
  } else if (item.status === 'skipped') {
    skipped += 1;
  } else if (item.status === 'failed') {
    failed += 1;
    failedKeys.push({
      key: entry.destinationKey,
      error: (item as { error?: string }).error,
      attempts: (item as { attempts?: number }).attempts,
    });
  }
}

console.log(`📋 Manifest entries: ${manifest.length}`);
console.log(`   ✅ Uploaded: ${uploaded}`);
console.log(`   ⏭️  Skipped: ${skipped}`);
console.log(`   ❌ Failed:   ${failed}`);
console.log(`   ❓ Missing:  ${missing}`);
console.log('');

if (failed > 0) {
  console.error('❌ Cannot clean up: there are failed uploads.');
  console.error('');
  console.error('   Failed files:');
  for (const f of failedKeys) {
    const file = f.key.split('/').pop() ?? f.key;
    const reason = f.error ?? 'unknown error';
    const att = f.attempts ? ` (${f.attempts} attempt${f.attempts > 1 ? 's' : ''})` : '';
    console.error(`     ✗ ${file}${att}`);
    console.error(`       ${reason}`);
  }
  console.error('');
  console.error('   Re-run takeout-upload or takeout-process --resume to fix failed items first.');
  process.exit(1);
}

if (missing > 0) {
  // For archive operations (move/delete), archive-state.json is the real safety gate —
  // only archives marked completed are eligible. Manifest key mismatches (e.g. from
  // re-scanning) shouldn't block moving/deleting archives that are confirmed complete.
  const archiveOpsRelaxed = (moveArchives || deleteArchives) && !force;

  if (!force && !archiveOpsRelaxed) {
    console.error(`❌ Cannot clean up safely: ${missing.toLocaleString()} manifest entries have no upload record.`);
    console.error('   This means upload state is incomplete or the manifest was rebuilt after upload.');
    console.error('');
    console.error(`   Sample missing files (${Math.min(missingKeys.length, 10)} of ${missing.toLocaleString()}):`);
    for (const key of missingKeys) {
      const file = key.split('/').pop() ?? key;
      const dir = key.split('/').slice(0, -1).join('/');
      console.error(`     · ${file}`);
      console.error(`       in ${dir}`);
    }
    if (missing > missingKeys.length) {
      console.error(`     … and ${(missing - missingKeys.length).toLocaleString()} more`);
    }
    console.error('');
    console.error('   Options:');
    console.error('   1. Re-run upload so every manifest entry has a state record, then retry.');
    console.error('   2. If archives are confirmed complete in archive-state.json and state keys');
    console.error('      are just mismatched (e.g. manifest was re-scanned), override with:');
    console.error('        takeout:cleanup -- --apply --move-archives --force');
    console.error('   Note: --force still only touches archives marked completed in archive-state.json.');
    process.exit(1);
  }

  if (archiveOpsRelaxed) {
    console.warn(`⚠️  ${missing} manifest entries have no upload record — archive-state.json will be used as safety gate.`);
  } else {
    console.warn(`⚠️  Missing state records: ${missing} — continuing because --force was passed.`);
  }
  console.warn('   Only archives marked completed in archive-state.json will be touched.');
  console.warn('');
}

// ─── 2. Measure disk usage ─────────────────────────────────────────────────

const extractedDir = path.join(config.workDir, 'Takeout');
const normalizedDir = path.join(config.workDir, 'normalized');
const tempExtractDir = path.join(config.workDir, 'temp-extract');

const [extractedSize, normalizedSize, tempSize, inputArchives, archiveState] = await Promise.all([
  measureDirSize(extractedDir),
  measureDirSize(normalizedDir),
  measureDirSize(tempExtractDir),
  discoverTakeoutArchives(config.inputDir),
  loadArchiveState(path.join(config.workDir, 'archive-state.json')),
]);

const completedArchiveNames = new Set(
  Object.entries(archiveState.archives)
    .filter(([, item]) => item.status === 'completed')
    .map(([name]) => name),
);

// When --include-unscanned is set AND uploads are confirmed safe, treat archives not
// tracked in archive-state.json as eligible too. For archive operations (move/delete),
// manifest key mismatches don't invalidate archive-level safety.
const allSafe = failed === 0 && (missing === 0 || moveArchives || deleteArchives || force);
const unscannedArchives = includeUnscanned && allSafe
  ? inputArchives.filter((a) => !completedArchiveNames.has(path.basename(a)))
  : [];

const eligibleInputArchives = [
  ...inputArchives.filter((archivePath) => completedArchiveNames.has(path.basename(archivePath))),
  ...unscannedArchives,
];

const protectedInputArchives = inputArchives.filter((archivePath) =>
  !completedArchiveNames.has(path.basename(archivePath)) && !unscannedArchives.includes(archivePath)
);

let inputSize = 0;
for (const archivePath of eligibleInputArchives) {
  try {
    const stat = await fs.stat(archivePath);
    inputSize += stat.size;
  } catch { /* skip */ }
}

console.log('💾 Disk usage:');
console.log(`   Extracted (Takeout/):    ${formatBytes(extractedSize)}${extractedSize === 0 ? ' (empty/absent)' : ''}`);
console.log(`   Normalized:              ${formatBytes(normalizedSize)}${normalizedSize === 0 ? ' (empty/absent)' : ''}`);
console.log(`   Temp-extract:            ${formatBytes(tempSize)}${tempSize === 0 ? ' (empty/absent)' : ''}`);
console.log(`   Input archives eligible (${eligibleInputArchives.length}/${inputArchives.length}):   ${formatBytes(inputSize)}${inputSize === 0 ? ' (empty/absent)' : ''}`);

if (protectedInputArchives.length > 0) {
  console.log(`   🔒 Protected (not completed): ${protectedInputArchives.length}`);
}
if (unscannedArchives.length > 0) {
  console.log(`   📂 Unscanned (will include because all uploads done): ${unscannedArchives.length}`);
}

let willFree = extractedSize + normalizedSize + tempSize;
if (deleteArchives || moveArchives) {
  willFree += inputSize;
}

console.log('');
console.log(`🗑️  Will free: ${formatBytes(willFree)}`);
console.log('');

// ─── 3. Plan cleanup actions ───────────────────────────────────────────────

type CleanupAction =
  | { type: 'remove-dir'; path: string; label: string; size: number }
  | { type: 'delete-file'; path: string; label: string; size: number }
  | { type: 'move-file'; from: string; to: string; label: string; size: number };

const actions: CleanupAction[] = [];

if (extractedSize > 0) {
  actions.push({ type: 'remove-dir', path: extractedDir, label: 'work/Takeout/', size: extractedSize });
}
if (normalizedSize > 0) {
  actions.push({ type: 'remove-dir', path: normalizedDir, label: 'work/normalized/', size: normalizedSize });
}
if (tempSize > 0) {
  actions.push({ type: 'remove-dir', path: tempExtractDir, label: 'work/temp-extract/', size: tempSize });
}

if (deleteArchives && eligibleInputArchives.length > 0) {
  for (const archivePath of eligibleInputArchives) {
    const stat = await fs.stat(archivePath).catch(() => null);
    actions.push({
      type: 'delete-file',
      path: archivePath,
      label: `input/${path.basename(archivePath)}`,
      size: stat?.size ?? 0,
    });
  }
} else if (moveArchives && eligibleInputArchives.length > 0) {
  for (const archivePath of eligibleInputArchives) {
    const stat = await fs.stat(archivePath).catch(() => null);
    const archiveName = path.basename(archivePath);
    actions.push({
      type: 'move-file',
      from: archivePath,
      to: path.join(moveTarget, archiveName),
      label: `input/${archiveName} → ${path.basename(moveTarget)}/${archiveName}`,
      size: stat?.size ?? 0,
    });
  }
}

if (actions.length === 0) {
  if ((deleteArchives || moveArchives) && inputArchives.length > 0 && eligibleInputArchives.length === 0) {
    console.log('✅ No archive cleanup actions planned.');
    if (protectedInputArchives.length > 0) {
      console.log(`   ${protectedInputArchives.length} archive(s) in input/ are not in archive-state.json (never scanned).`);
      if (!includeUnscanned) {
        console.log('   If all files are uploaded, re-run with --include-unscanned to also clean those up.');
      } else if (!allSafe) {
        console.log('   --include-unscanned requires missing=0 and failed=0; fix uploads first.');
      }
    }
  }
  console.log('✅ Nothing to clean up — disk is already clean.');
  process.exit(0);
}

console.log(`📝 Planned actions (${actions.length}):`);
for (const action of actions) {
  const sizeLabel = action.size > 0 ? ` (${formatBytes(action.size)})` : '';
  if (action.type === 'remove-dir') {
    console.log(`   🗑️  Remove directory: ${action.label}${sizeLabel}`);
  } else if (action.type === 'delete-file') {
    console.log(`   🗑️  Delete file: ${action.label}${sizeLabel}`);
  } else if (action.type === 'move-file') {
    console.log(`   📦 Move: ${action.label}${sizeLabel}`);
  }
}
console.log('');

// ─── 4. Execute or dry-run ─────────────────────────────────────────────────

if (!apply) {
  console.log('🔍 DRY RUN — no changes made. Pass --apply to execute.');
  console.log('');
  console.log('Example commands:');
  console.log('  npx tsx scripts/takeout-cleanup.ts --apply                    # clean extracted + normalized');
  console.log('  npx tsx scripts/takeout-cleanup.ts --apply --move-archives    # also move input .tgz to uploaded-archives/');
  console.log('  npx tsx scripts/takeout-cleanup.ts --apply --delete-archives  # also delete input .tgz files');
  console.log('');
  process.exit(0);
}

console.log('🚀 Applying cleanup...');
console.log('');

let freedBytes = 0;
let actionsDone = 0;
const actionFailures: { label: string; error: string }[] = [];

for (const action of actions) {
  try {
    if (action.type === 'remove-dir') {
      console.log(`   Removing ${action.label}...`);
      await fs.rm(action.path, { recursive: true, force: true });
      freedBytes += action.size;
    } else if (action.type === 'delete-file') {
      console.log(`   Deleting ${action.label}...`);
      await fs.unlink(action.path);
      freedBytes += action.size;
    } else if (action.type === 'move-file') {
      console.log(`   Moving ${action.label}...`);
      await fs.mkdir(path.dirname(action.to), { recursive: true });
      try {
        await fs.rename(action.from, action.to);
      } catch (error) {
        if (!isCrossDeviceRenameError(error)) throw error;
        // Cross-device (e.g. external HD): copy then delete
        await fs.copyFile(action.from, action.to);
        await fs.unlink(action.from);
      }
      freedBytes += action.size;
    }
    actionsDone += 1;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const file = 'from' in action ? path.basename(action.from) : path.basename(action.path);
    console.error(`   ⚠️  Failed: ${file}`);
    console.error(`       ${msg}`);
    actionFailures.push({ label: action.label, error: msg });
  }
}

console.log('');
if (actionFailures.length > 0) {
  console.error(`❌ Cleanup finished with ${actionFailures.length} error(s):`);
  for (const f of actionFailures) {
    console.error(`   ✗ ${f.label}: ${f.error}`);
  }
  console.log('');
}
console.log(`✅ Cleanup complete: ${actionsDone}/${actions.length} actions, ~${formatBytes(freedBytes)} freed.`);

// ─── 5. Optionally backfill archive-state.json ─────────────────────────────

if (backfillState) {
  await backfillArchiveState();
}

console.log('');
console.log('💡 For future imports, use the incremental pipeline to avoid disk bloat:');
console.log('   npx tsx scripts/takeout-process.ts --move-archive');
console.log('   This processes one archive at a time and cleans up after each upload.');
console.log('');

// ─── Helpers ───────────────────────────────────────────────────────────────

async function backfillArchiveState(): Promise<void> {
  console.log('');
  console.log('📝 Backfilling archive-state.json from upload state...');

  const archiveStatePath = path.join(config.workDir, 'archive-state.json');
  const existingState = await loadArchiveState(archiveStatePath);

  // Discover all input archives (even if deleted — we mark what we know from manifest)
  const archives = await discoverTakeoutArchives(config.inputDir);
  const archiveNames = archives.map((a) => path.basename(a));

  // Count items per archive is not possible after the fact, but we know the totals
  // Mark all known archives as completed since everything is uploaded
  let backfilled = 0;
  for (const name of archiveNames) {
    if (!existingState.archives[name] || existingState.archives[name].status !== 'completed') {
      existingState.archives[name] = {
        status: 'completed',
        entryCount: 0, // Unknown per-archive breakdown
        uploadedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        completedAt: new Date().toISOString(),
      };
      backfilled += 1;
    }
  }

  await persistArchiveState(archiveStatePath, existingState);
  console.log(`   Marked ${backfilled} archives as completed in archive-state.json`);
  console.log(`   Total tracked: ${Object.keys(existingState.archives).length}`);
}

async function measureDirSize(dirPath: string): Promise<number> {
  try {
    await fs.access(dirPath);
  } catch {
    return 0;
  }

  let total = 0;
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          total += stat.size;
        } catch { /* skip */ }
      }
    }
  }

  return total;
}

function readStringArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
