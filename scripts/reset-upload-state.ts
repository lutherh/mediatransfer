/**
 * Reset upload state to allow re-uploading all files to S3.
 *
 * This backs up the current state files and creates clean versions so the
 * upload pipeline will re-process all archives from scratch.
 *
 * Usage:
 *   npx tsx scripts/reset-upload-state.ts          # dry run (shows what would happen)
 *   npx tsx scripts/reset-upload-state.ts --apply   # actually reset
 */
import * as dotenv from 'dotenv';
dotenv.config();
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const pathOverrides = parseTakeoutPathArgs(args);
const config = loadTakeoutConfig(undefined, pathOverrides);

const statePath = config.statePath;
const archiveStatePath = path.join(config.workDir, 'archive-state.json');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

console.log('');
console.log('┌──────────────────────────────────────────┐');
console.log('│  Reset Upload State for Re-upload         │');
console.log('└──────────────────────────────────────────┘');
console.log('');
console.log(`  State path:         ${statePath}`);
console.log(`  Archive state path: ${archiveStatePath}`);
console.log(`  Mode:               ${apply ? 'APPLY' : 'DRY RUN'}`);
console.log('');

// Check current state
try {
  const raw = await fs.readFile(statePath, 'utf8');
  const state = JSON.parse(raw);
  const count = Object.keys(state.items ?? {}).length;
  console.log(`  Current upload state: ${count} items`);
} catch {
  console.log('  Current upload state: (not found or invalid)');
}

try {
  const raw = await fs.readFile(archiveStatePath, 'utf8');
  const state = JSON.parse(raw);
  const archives = Object.keys(state.archives ?? {});
  const completed = archives.filter(k => state.archives[k]?.status === 'completed').length;
  console.log(`  Current archive state: ${archives.length} archives (${completed} completed)`);
} catch {
  console.log('  Current archive state: (not found or invalid)');
}

console.log('');

if (!apply) {
  console.log('  DRY RUN — no changes made. Use --apply to execute.');
  console.log('');
  process.exit(0);
}

// Back up state.json
const stateBackup = `${statePath}.pre-reset-${timestamp}.bak`;
try {
  await fs.copyFile(statePath, stateBackup);
  console.log(`  ✅ Backed up state.json → ${path.basename(stateBackup)}`);
} catch {
  console.log('  ⚠️  No state.json to back up');
}

// Back up archive-state.json
const archiveBackup = `${archiveStatePath}.pre-reset-${timestamp}.bak`;
try {
  await fs.copyFile(archiveStatePath, archiveBackup);
  console.log(`  ✅ Backed up archive-state.json → ${path.basename(archiveBackup)}`);
} catch {
  console.log('  ⚠️  No archive-state.json to back up');
}

// Write clean state.json
const cleanState = {
  version: 1,
  updatedAt: new Date().toISOString(),
  items: {},
};
await fs.writeFile(statePath, JSON.stringify(cleanState, null, 2), 'utf8');
console.log('  ✅ Reset state.json (0 items)');

// Write clean archive-state.json
const cleanArchiveState = {
  version: 1,
  updatedAt: new Date().toISOString(),
  archives: {},
};
await fs.writeFile(archiveStatePath, JSON.stringify(cleanArchiveState, null, 2), 'utf8');
console.log('  ✅ Reset archive-state.json (0 archives)');

console.log('');
console.log('  State has been reset. Next upload run will re-process all archives.');
console.log('  Run the upload with: npm run takeout:upload');
console.log('  Or trigger it from the web UI.');
console.log('');
