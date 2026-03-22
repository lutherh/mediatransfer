import dotenv from 'dotenv';
dotenv.config();
import { S3Client, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';

const client = new S3Client({
  region: 'nl-ams',
  endpoint: 'https://s3.nl-ams.scw.cloud',
  credentials: {
    accessKeyId: process.env.SCW_ACCESS_KEY!,
    secretAccessKey: process.env.SCW_SECRET_KEY!,
  },
  forcePathStyle: true,
});

const bucket = process.env.SCW_BUCKET!;
const testKey = '_test_speed_10mb.bin';
const SIZE_MB = 10;
const SIZE_BYTES = SIZE_MB * 1024 * 1024;

console.log(`=== Upload Speed Test (${SIZE_MB} MB) ===`);
console.log('Bucket:', bucket);

// Generate random data (incompressible)
const data = crypto.randomBytes(SIZE_BYTES);
const stream = Readable.from([data]);

console.log('\nUploading...');
const startMs = Date.now();

const upload = new Upload({
  client,
  queueSize: 4,
  partSize: 16 * 1024 * 1024,
  leavePartsOnError: false,
  params: {
    Bucket: bucket,
    Key: testKey,
    Body: stream,
    ContentType: 'application/octet-stream',
  },
});

await upload.done();
const durationMs = Date.now() - startMs;
const speedMBps = SIZE_BYTES / (durationMs / 1000) / 1e6;
const speedMbps = speedMBps * 8;

console.log(`Upload completed in ${durationMs}ms`);
console.log(`Speed: ${speedMBps.toFixed(2)} MB/s (${speedMbps.toFixed(0)} Mbps)`);

// Verify it exists
const resp = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: '_test_speed', MaxKeys: 5 }));
console.log(`\nVerification: ${resp.KeyCount} object(s) found`);
if (resp.Contents) {
  for (const obj of resp.Contents) {
    console.log(`  ${obj.Key}: ${obj.Size} bytes`);
    if (obj.Size !== SIZE_BYTES) {
      console.log(`  >>> SIZE MISMATCH! Expected ${SIZE_BYTES}, got ${obj.Size} <<<`);
    }
  }
}

// Cleanup
await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: testKey }));
console.log('\nTest object cleaned up.');

// Projection
console.log(`\n=== Projected Throughput ===`);
console.log(`At ${speedMBps.toFixed(1)} MB/s:`);
console.log(`  1 GB would take: ${(1024 / speedMBps / 60).toFixed(1)} minutes`);
console.log(`  1 TB would take: ${(1024 * 1024 / speedMBps / 3600).toFixed(1)} hours`);
console.log(`\nArchive state claims 1427 GB uploaded in ~5 hours of active uploading.`);
console.log(`That requires: ${(1427 * 1024 / (5 * 3600)).toFixed(1)} MB/s sustained.`);
console.log(`Your actual speed: ${speedMBps.toFixed(1)} MB/s`);
if (speedMBps < 50) {
  console.log(`\n>>> WARNING: Your upload speed (${speedMBps.toFixed(1)} MB/s) is too slow for the claimed throughput (~50 MB/s) <<<`);
  console.log(`>>> This suggests the uploads may not have actually transferred data to S3 <<<`);
}
