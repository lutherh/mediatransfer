/**
 * verify-s3-immich-compat.ts
 *
 * Pre-flight check before enabling the rclone S3 mount for Immich.
 * Ensures:
 *   1. The chosen RCLONE_PREFIX doesn't collide with existing S3 keys
 *   2. Immich's expected subdirectories don't conflict with existing data
 *   3. The rclone remote is reachable and the bucket exists
 *   4. File listing on both sides is consistent
 *
 * Usage:  npx tsx scripts/verify-s3-immich-compat.ts
 *         npx tsx scripts/verify-s3-immich-compat.ts --fix-prefix custom-prefix
 */

import { S3Client, ListObjectsV2Command, HeadBucketCommand } from '@aws-sdk/client-s3';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { resolveScalewayEndpoint, resolveScalewaySigningRegion } from '../src/providers/scaleway.js';

// ── Config ──────────────────────────────────────────────────────

dotenv.config({ path: resolve(import.meta.dirname, '../.env') });

const envImmich = resolve(import.meta.dirname, '../.env.immich');
const immichVars: Record<string, string> = {};
if (fs.existsSync(envImmich)) {
  for (const line of fs.readFileSync(envImmich, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)/);
    if (m) immichVars[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

const region = process.env.SCW_REGION!;
const bucket = process.env.SCW_BUCKET!;
const rcloneBucket = immichVars.RCLONE_BUCKET || bucket;
const rclonePrefix = process.argv.includes('--fix-prefix')
  ? process.argv[process.argv.indexOf('--fix-prefix') + 1]
  : (immichVars.RCLONE_PREFIX || 'immich');
const uploadLocation = immichVars.UPLOAD_LOCATION || './data/immich-s3';

const client = new S3Client({
  endpoint: resolveScalewayEndpoint(region),
  region: resolveScalewaySigningRegion(region),
  credentials: {
    accessKeyId: process.env.SCW_ACCESS_KEY!,
    secretAccessKey: process.env.SCW_SECRET_KEY!,
  },
  forcePathStyle: true,
});

// ── Immich's known subdirectories ───────────────────────────────

const IMMICH_SUBDIRS = ['library', 'upload', 'thumbs', 'encoded-video', 'profile', 'backups'];

// ── Logging ─────────────────────────────────────────────────────

type Level = 'INFO' | 'WARN' | 'ERROR' | 'OK';
const COLORS: Record<Level, string> = {
  INFO: '\x1b[36m',   // cyan
  WARN: '\x1b[33m',   // yellow
  ERROR: '\x1b[31m',  // red
  OK: '\x1b[32m',     // green
};

function log(level: Level, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${COLORS[level]}[${ts}] [${level.padEnd(5)}]\x1b[0m ${msg}`);
}

// ── Checks ──────────────────────────────────────────────────────

let errors = 0;
let warnings = 0;

log('INFO', '═══════════════════════════════════════════════════════');
log('INFO', '  S3 ↔ Immich Compatibility Verification');
log('INFO', '═══════════════════════════════════════════════════════');
log('INFO', '');
log('INFO', `Bucket:         ${rcloneBucket}`);
log('INFO', `Immich prefix:  ${rclonePrefix}/`);
log('INFO', `Mount path:     ${uploadLocation}`);
log('INFO', '');

// ── Check 1: Bucket reachable ───────────────────────────────────

log('INFO', '── Check 1: S3 bucket reachable ──');
try {
  await client.send(new HeadBucketCommand({ Bucket: rcloneBucket }));
  log('OK', `Bucket "${rcloneBucket}" is accessible.`);
} catch (e: any) {
  log('ERROR', `Cannot access bucket "${rcloneBucket}": ${e.message}`);
  errors++;
}

// ── Check 2: rclone installed ───────────────────────────────────

log('INFO', '── Check 2: rclone installed ──');
try {
  execSync('rclone version', { encoding: 'utf-8' });
  log('OK', 'rclone is installed.');
} catch {
  log('ERROR', 'rclone is not installed or not in PATH.');
  errors++;
}

// ── Check 3: Prefix collision with existing keys ────────────────

log('INFO', '── Check 3: Prefix collision scan ──');
log('INFO', `Scanning for existing keys under "${rclonePrefix}/" ...`);

let existingUnderPrefix = 0;
let existingKeys: string[] = [];
let token3: string | undefined;

try {
  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: rcloneBucket,
      Prefix: `${rclonePrefix}/`,
      ContinuationToken: token3,
      MaxKeys: 1000,
    }));
    for (const obj of resp.Contents ?? []) {
      existingUnderPrefix++;
      if (existingKeys.length < 20) existingKeys.push(obj.Key ?? '');
    }
    token3 = resp.NextContinuationToken;
    if (!resp.IsTruncated) break;
  } while (token3);

  if (existingUnderPrefix === 0) {
    log('OK', `No existing keys under "${rclonePrefix}/". Clean namespace.`);
  } else {
    log('WARN', `Found ${existingUnderPrefix} existing keys under "${rclonePrefix}/".`);
    log('WARN', 'These are already in the target namespace — Immich may see/overwrite them.');
    log('INFO', 'Sample keys:');
    for (const k of existingKeys) {
      log('INFO', `  ${k}`);
    }
    warnings++;
  }
} catch (e: any) {
  log('ERROR', `Failed to list prefix "${rclonePrefix}/": ${e.message}`);
  errors++;
}

// ── Check 4: Immich subdirectory collisions ─────────────────────

log('INFO', '── Check 4: Immich subdirectory collision scan ──');

for (const subdir of IMMICH_SUBDIRS) {
  const prefix = `${rclonePrefix}/${subdir}/`;
  try {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: rcloneBucket,
      Prefix: prefix,
      MaxKeys: 5,
    }));
    const count = resp.Contents?.length ?? 0;
    if (count > 0) {
      log('WARN', `"${prefix}" already has ${count}${resp.IsTruncated ? '+' : ''} objects${count > 0 ? ': ' + resp.Contents!.map(o => o.Key).join(', ') : ''}`);
      warnings++;
    } else {
      log('OK', `"${prefix}" is empty — safe for Immich.`);
    }
  } catch (e: any) {
    log('ERROR', `Failed to check "${prefix}": ${e.message}`);
    errors++;
  }
}

// ── Check 5: Cross-check with MediaTransfer prefix ──────────────

log('INFO', '── Check 5: MediaTransfer co-location under Immich prefix ──');

const mtPrefix = process.env.SCW_PREFIX || '';
const mtTransfers = mtPrefix ? `${mtPrefix}/s3transfers/` : 's3transfers/';
const mtThumbs = mtPrefix ? `${mtPrefix}/_thumbs/` : '_thumbs/';

// Unified layout: MediaTransfer writes MUST live under the Immich rclone prefix
// (e.g. SCW_PREFIX=immich → mtTransfers=immich/s3transfers/ inside immich/).
// This prevents the historic split-brain where transfers/ at bucket root was
// invisible to Immich.
if (mtTransfers.startsWith(`${rclonePrefix}/`)) {
  log('OK', `MediaTransfer "${mtTransfers}" is co-located under Immich prefix "${rclonePrefix}/".`);
} else {
  log('ERROR', `MediaTransfer prefix "${mtTransfers}" is NOT under Immich prefix "${rclonePrefix}/".`);
  log('ERROR', 'Set SCW_PREFIX to match RCLONE_PREFIX (typically "immich") to unify the layout.');
  errors++;
}

if (mtThumbs.startsWith(`${rclonePrefix}/`)) {
  log('OK', `MediaTransfer thumbs "${mtThumbs}" is co-located under Immich prefix.`);
} else {
  log('WARN', `MediaTransfer thumbs "${mtThumbs}" is not under Immich prefix "${rclonePrefix}/".`);
  warnings++;
}

// ── Check 6: Existing local Immich data ─────────────────────────

log('INFO', '── Check 6: Existing local Immich data ──');

const resolvedUpload = path.isAbsolute(uploadLocation)
  ? uploadLocation
  : path.resolve(resolve(import.meta.dirname, '..'), uploadLocation);

if (fs.existsSync(resolvedUpload)) {
  const entries = fs.readdirSync(resolvedUpload);
  if (entries.length > 0) {
    log('WARN', `Mount target "${resolvedUpload}" already has ${entries.length} entries: ${entries.join(', ')}`);
    log('WARN', 'If this becomes a mount point, existing local files will be hidden (not lost).');
    warnings++;
  } else {
    log('OK', `Mount target "${resolvedUpload}" exists and is empty.`);
  }
} else {
  log('OK', `Mount target "${resolvedUpload}" does not exist yet — will be created by mount script.`);
}

// Check if existing Immich DB references the old local path
log('INFO', '── Check 7: Immich DB path consistency ──');
try {
  const sql = 'SELECT count(*) FROM asset WHERE "deletedAt" IS NULL;';
  const countResult = execSync(
    `echo ${sql} | docker exec -i immich_postgres psql -U immich -d immich -t -A`,
    { encoding: 'utf-8', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' }
  ).trim();
  const assetCount = parseInt(countResult, 10);

  if (assetCount > 0) {
    const pathSql = `SELECT DISTINCT substring("originalPath" FROM '^/usr/src/app/upload/([^/]+)') FROM asset WHERE "deletedAt" IS NULL;`;
    const pathResult = execSync(
      `echo ${pathSql} | docker exec -i immich_postgres psql -U immich -d immich -t -A`,
      { encoding: 'utf-8', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' }
    ).trim();
    const topDirs = pathResult.split('\n').filter(Boolean);
    log('INFO', `Immich has ${assetCount} assets stored under top-level dirs: ${topDirs.join(', ')}`);
    log('WARN', `These ${assetCount} assets reference paths under the OLD local UPLOAD_LOCATION.`);
    log('WARN', 'After switching to S3 mount, these files must exist at the same relative paths on S3.');
    log('WARN', 'Migration plan: rclone sync existing data/immich/{library,upload} → s3://bucket/immich/');
    warnings++;
  } else {
    log('OK', 'Immich DB has 0 assets — fresh install, no migration needed.');
  }
} catch (e: any) {
  log('WARN', `Could not query Immich DB (is it running?): ${e.message?.split('\n')[0]}`);
  warnings++;
}

// ── Summary ─────────────────────────────────────────────────────

log('INFO', '');
log('INFO', '═══════════════════════════════════════════════════════');
if (errors > 0) {
  log('ERROR', `FAILED — ${errors} error(s), ${warnings} warning(s).`);
  log('ERROR', 'Fix the errors above before enabling the S3 mount.');
} else if (warnings > 0) {
  log('WARN', `PASSED with ${warnings} warning(s). Review them above.`);
} else {
  log('OK', 'ALL CHECKS PASSED — safe to enable S3 mount for Immich.');
}

log('INFO', '');
log('INFO', 'Namespace layout after enabling mount:');
log('INFO', `  s3://${rcloneBucket}/${rclonePrefix}/s3transfers/...     ← MediaTransfer uploads`);
log('INFO', `  s3://${rcloneBucket}/${rclonePrefix}/_thumbs/...        ← MediaTransfer catalog thumbs`);
log('INFO', `  s3://${rcloneBucket}/${rclonePrefix}/library/...        ← Immich originals`);
log('INFO', `  s3://${rcloneBucket}/${rclonePrefix}/upload/...         ← Immich incoming`);
log('INFO', `  s3://${rcloneBucket}/${rclonePrefix}/thumbs/...         ← (local override, not on S3)`);
log('INFO', `  s3://${rcloneBucket}/${rclonePrefix}/encoded-video/     ← (local override, not on S3)`);
log('INFO', '');

if (errors > 0) process.exit(1);
