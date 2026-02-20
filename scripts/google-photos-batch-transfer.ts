import * as dotenv from 'dotenv';
import path from 'node:path';
import {
  createOAuth2Client,
  setTokens,
  GooglePhotosProvider,
  ScalewayProvider,
  validateScalewayConfig,
} from '../src/providers/index.js';
import { runGoogleApiBatchTransferLoop } from '../src/takeout/google-api-runner.js';

dotenv.config();

const clientId = requiredEnv('GOOGLE_CLIENT_ID');
const clientSecret = requiredEnv('GOOGLE_CLIENT_SECRET');
const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/auth/google/callback';
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
const expiryDate = parseNumber(process.env.GOOGLE_TOKEN_EXPIRY_DATE);

const scalewayConfig = validateScalewayConfig({
  provider: 'scaleway',
  region: process.env.SCW_REGION,
  bucket: process.env.SCW_BUCKET,
  accessKey: process.env.SCW_ACCESS_KEY,
  secretKey: process.env.SCW_SECRET_KEY,
  prefix: process.env.SCW_PREFIX,
});

const args = process.argv.slice(2);
assertArgHasValue(args, '--batch-items');
assertArgHasValue(args, '--batch-gb');
assertArgHasValue(args, '--source-page-size');
assertArgHasValue(args, '--max-batches');
assertArgHasValue(args, '--state-path');
assertArgHasValue(args, '--temp-dir');
assertArgHasValue(args, '--max-source-pages');

const batchItems = parsePositiveIntArg(args, '--batch-items') ?? 100;
const batchGb = parsePositiveNumberArg(args, '--batch-gb') ?? 2;
const batchBytes = Math.floor(batchGb * 1024 * 1024 * 1024);
const sourcePageSize = parsePositiveIntArg(args, '--source-page-size') ?? 100;
const maxSourcePages = parsePositiveIntArg(args, '--max-source-pages') ?? 25;
const maxBatches = parsePositiveIntArg(args, '--max-batches');
const dryRun = args.includes('--dry-run');

if (!refreshToken && !accessToken) {
  throw new Error(
    'Missing Google auth token. Set GOOGLE_REFRESH_TOKEN (recommended) or GOOGLE_ACCESS_TOKEN (short-lived).',
  );
}

if (!refreshToken && accessToken) {
  console.log('⚠️ Running with GOOGLE_ACCESS_TOKEN only. This may expire during long transfers.');
}

const statePath = path.resolve(
  readStringArg(args, '--state-path') ?? process.env.GOOGLE_BATCH_STATE_PATH ?? './data/takeout/google-api-state.json',
);
const tempDir = path.resolve(
  readStringArg(args, '--temp-dir') ?? process.env.GOOGLE_BATCH_TEMP_DIR ?? './data/takeout/work/google-api-batches',
);

const oauthClient = createOAuth2Client({
  clientId,
  clientSecret,
  redirectUri,
});

setTokens(oauthClient, {
  accessToken: accessToken ?? '',
  refreshToken,
  expiryDate,
});

const source = new GooglePhotosProvider(oauthClient, {
  accessToken: accessToken ?? '',
  refreshToken,
  expiryDate,
});
const destination = new ScalewayProvider(scalewayConfig);

console.log('🔁 Starting fully programmatic Google Photos batch transfer');
console.log(`   Batch limits: ${batchItems} files or ${batchGb} GB`);
console.log(`   State path  : ${statePath}`);
console.log(`   Temp dir    : ${tempDir}`);
console.log(`   Max pages   : ${maxSourcePages} per batch`);
console.log(`   Dry run     : ${dryRun}`);

const result = await runGoogleApiBatchTransferLoop(source, destination, {
  statePath,
  tempDir,
  batchMaxItems: batchItems,
  batchMaxBytes: batchBytes,
  sourcePageSize,
  maxSourcePagesPerBatch: maxSourcePages,
  maxBatches,
  dryRun,
});

for (const batch of result.batches) {
  console.log(`\nBatch ${batch.batchNumber}`);
  console.log(`   Downloaded : ${batch.downloadedCount}`);
  console.log(`   Uploaded   : ${batch.uploadedCount}`);
  console.log(`   Verified   : ${batch.verifiedCount}`);
  console.log(`   Local clean: ${batch.deletedLocalCount}`);
  console.log(`   Bytes      : ${batch.totalBytes}`);
  console.log(`   Completed  : ${batch.completed}`);
}

console.log('\n✅ Run summary');
console.log(`   Total downloaded : ${result.totalDownloaded}`);
console.log(`   Total uploaded   : ${result.totalUploaded}`);
console.log(`   Total verified   : ${result.totalVerified}`);
console.log(`   Total local clean: ${result.totalDeletedLocal}`);
console.log(`   Total bytes      : ${result.totalBytes}`);
console.log(`   Source completed : ${result.completed}`);

if (!result.completed) {
  console.log('ℹ️  Source not fully completed (resume is automatic on next run).');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveIntArg(args: string[], name: string): number | undefined {
  const value = readStringArg(args, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveNumberArg(args: string[], name: string): number | undefined {
  const value = readStringArg(args, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readStringArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function assertArgHasValue(args: string[], name: string): void {
  const index = args.indexOf(name);
  if (index === -1) {
    return;
  }

  const next = args[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Argument ${name} requires a value. Example: ${name} 2`);
  }
}