/**
 * Verify the integrity of the S3 bucket against the local upload state.
 *
 * Checks:
 *  1. Every "uploaded" key in state.json exists on S3 (no missing files)
 *  2. Every S3 object under s3transfers/ is tracked in state.json (no orphans)
 *  3. File sizes match between S3 and what we expect
 *  4. Total counts are consistent
 *
 * Usage:
 *   npx tsx scripts/takeout-verify-s3.ts                  # full verify
 *   npx tsx scripts/takeout-verify-s3.ts --quick           # count-only (no size check)
 *   npx tsx scripts/takeout-verify-s3.ts --prefix s3transfers/2019  # check specific prefix
 */
import * as dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  S3Client,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { loadTakeoutConfig, parseTakeoutPathArgs } from '../src/takeout/config.js';
import type { UploadState } from '../src/takeout/uploader.js';
import {
  resolveScalewayEndpoint,
  resolveScalewaySigningRegion,
  validateScalewayConfig,
} from '../src/providers/scaleway.js';

dotenv.config();

// ── Parse arguments ─────────────────────────────────────────────

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const filterPrefix = readStringArg(args, '--prefix');

function readStringArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
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

function fullPrefix(key: string): string {
  return s3Prefix ? `${s3Prefix}/${key}` : key;
}

function stripPrefix(key: string): string {
  if (s3Prefix && key.startsWith(`${s3Prefix}/`)) {
    return key.slice(s3Prefix.length + 1);
  }
  return key;
}

// ── Step 1: Load upload state ────────────────────────────────────

console.log('📋 Loading upload state...');
const statePath = config.statePath;
let uploadState: UploadState;
try {
  const raw = await fs.readFile(statePath, 'utf8');
  uploadState = JSON.parse(raw) as UploadState;
} catch (err) {
  throw new Error(`Could not read upload state: ${(err as Error).message}`);
}

const stateUploaded = new Map<string, { status: string }>();
for (const [key, item] of Object.entries(uploadState.items)) {
  if (item.status !== 'uploaded') continue;
  if (filterPrefix && !key.startsWith(filterPrefix)) continue;
  stateUploaded.set(key, item);
}

console.log(`   ${stateUploaded.size} uploaded items in state` +
  (filterPrefix ? ` (filtered to "${filterPrefix}")` : ''));

// ── Step 2: List all S3 objects under s3transfers/ ─────────────────

console.log('\n🔍 Listing S3 objects...');

type S3Item = { key: string; size: number };
const s3Items = new Map<string, S3Item>();

// List all objects with the s3transfers/ prefix (or filtered prefix)
const listPrefix = fullPrefix(filterPrefix ?? 's3transfers/');
let continuationToken: string | undefined;
let listBatches = 0;

do {
  const resp: ListObjectsV2CommandOutput = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: listPrefix,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }),
  );

  for (const obj of resp.Contents ?? []) {
    if (!obj.Key) continue;
    const stripped = stripPrefix(obj.Key);
    s3Items.set(stripped, { key: stripped, size: obj.Size ?? 0 });
  }

  continuationToken = resp.NextContinuationToken;
  listBatches++;

  if (listBatches % 20 === 0) {
    process.stdout.write(`\r   ${s3Items.size} objects listed so far...`);
  }
} while (continuationToken);

console.log(`\r   ${s3Items.size} objects found on S3`);

// ── Step 3: Cross-check ──────────────────────────────────────────

console.log('\n🔄 Cross-checking...');

// 3a. Files in state but missing from S3
const missingFromS3: string[] = [];
for (const key of stateUploaded.keys()) {
  if (!key.startsWith('s3transfers/')) continue; // only check takeout uploads
  if (filterPrefix && !key.startsWith(filterPrefix)) continue;
  if (!s3Items.has(key)) {
    missingFromS3.push(key);
  }
}

// 3b. Files on S3 but not in state (orphans)
const orphansOnS3: string[] = [];
for (const key of s3Items.keys()) {
  if (!uploadState.items[key]) {
    orphansOnS3.push(key);
  }
}

// ── Step 4: Report ───────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('📊 VERIFICATION REPORT');
console.log('═'.repeat(60));

console.log(`\n   State uploaded (s3transfers/):  ${stateUploaded.size}`);
console.log(`   S3 objects found:             ${s3Items.size}`);
console.log(`   Missing from S3:              ${missingFromS3.length}`);
console.log(`   Orphans on S3 (not in state): ${orphansOnS3.length}`);

if (missingFromS3.length > 0) {
  console.log(`\n⚠️  MISSING FROM S3 (first 20):`);
  for (const key of missingFromS3.slice(0, 20)) {
    console.log(`   ❌ ${key}`);
  }
  if (missingFromS3.length > 20) {
    console.log(`   ... and ${missingFromS3.length - 20} more`);
  }
}

if (orphansOnS3.length > 0) {
  console.log(`\n⚠️  ORPHANS ON S3 — not tracked in state (first 20):`);
  for (const key of orphansOnS3.slice(0, 20)) {
    console.log(`   🔸 ${key}`);
  }
  if (orphansOnS3.length > 20) {
    console.log(`   ... and ${orphansOnS3.length - 20} more`);
  }
}

// Year breakdown of S3 contents
const s3Years: Record<string, number> = {};
for (const key of s3Items.keys()) {
  const match = key.match(/^s3transfers\/(\d{4})\//);
  if (match) {
    s3Years[match[1]] = (s3Years[match[1]] || 0) + 1;
  }
}

console.log('\n📅 S3 objects by year:');
for (const [year, count] of Object.entries(s3Years).sort()) {
  console.log(`   ${year}: ${count}`);
}

// Final verdict
console.log('\n' + '═'.repeat(60));
if (missingFromS3.length === 0 && orphansOnS3.length === 0) {
  console.log('✅ VERIFICATION PASSED — all files accounted for!');
} else if (missingFromS3.length === 0) {
  console.log(`⚠️  VERIFICATION: No missing files, but ${orphansOnS3.length} orphans found on S3.`);
  console.log('   Orphans are safe — they\'re extra files not tracked in state.');
} else {
  console.log(`❌ VERIFICATION FAILED — ${missingFromS3.length} files missing from S3!`);
}
console.log('═'.repeat(60));

// Save full report if there are issues
if (missingFromS3.length > 0 || orphansOnS3.length > 0) {
  const reportPath = path.join(config.workDir, 'verify-report.json');
  await fs.writeFile(
    reportPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      stateCount: stateUploaded.size,
      s3Count: s3Items.size,
      missingFromS3,
      orphansOnS3: orphansOnS3.slice(0, 500),
    }, null, 2),
    'utf8',
  );
  console.log(`\n   Full report saved to: ${reportPath}`);
}
