/** Quick S3 connectivity smoke test. Run: npx tsx scripts/test-s3-quick.ts */
import 'dotenv/config';
import { S3Client, ListObjectsV2Command, HeadBucketCommand } from '@aws-sdk/client-s3';
import { resolveScalewayEndpoint, resolveScalewaySigningRegion } from '../src/providers/scaleway.js';

const region = process.env.SCW_REGION!;
const bucket = process.env.SCW_BUCKET!;

console.log('Region:        ', region);
console.log('Bucket:        ', bucket);
console.log('Endpoint:      ', resolveScalewayEndpoint(region));
console.log('Signing region:', resolveScalewaySigningRegion(region));
console.log('Storage class: ', process.env.SCW_STORAGE_CLASS || '(not set)');
console.log('');

const s3 = new S3Client({
  region: resolveScalewaySigningRegion(region),
  endpoint: resolveScalewayEndpoint(region),
  credentials: { accessKeyId: process.env.SCW_ACCESS_KEY!, secretAccessKey: process.env.SCW_SECRET_KEY! },
  forcePathStyle: true,
});

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e: any) {
    console.log(`  FAIL: ${e.message}`);
    failed++;
  }
}

await test('1. HeadBucket — bucket reachable', async () => {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log('  OK — bucket accessible');
});

await test('2. List first 5 objects', async () => {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 5 }));
  console.log(`  OK — ${res.KeyCount} objects returned`);
  for (const o of res.Contents ?? []) {
    console.log(`    ${o.Key}  (${Math.round((o.Size ?? 0) / 1024)} KB)`);
  }
});

await test('3. List immich/ prefix (mount target)', async () => {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'immich/', MaxKeys: 3 }));
  console.log(`  OK — ${res.KeyCount} objects under immich/`);
});

await test('4. List transfers/ prefix (existing data)', async () => {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'transfers/', MaxKeys: 3 }));
  console.log(`  OK — ${res.KeyCount} objects under transfers/`);
});

console.log('');
console.log(`Done: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
