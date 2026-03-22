import dotenv from 'dotenv';
dotenv.config();
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';

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
const testKey = '_test_multipart_upload.bin';

console.log('=== Multipart Upload Test (same code path as actual uploader) ===');
console.log('Bucket:', bucket);

try {
  // Create a 1MB test stream (similar to how the uploader creates a read stream)
  const testData = Buffer.alloc(1024 * 1024, 'A');
  const stream = Readable.from([testData]);

  console.log('\n1. Uploading 1MB via @aws-sdk/lib-storage Upload (same as ScalewayProvider.upload)...');
  const upload = new Upload({
    client,
    queueSize: 4,
    partSize: 16 * 1024 * 1024, // 16MB (same as ScalewayProvider)
    leavePartsOnError: false,
    params: {
      Bucket: bucket,
      Key: testKey,
      Body: stream,
      ContentType: 'application/octet-stream',
      Metadata: { 'captured-at': '2026-01-01T00:00:00Z' },
    },
  });

  const result = await upload.done();
  console.log('   Upload.done() resolved. ETag:', result.ETag);
  console.log('   Location:', result.Location);

  // Verify it exists
  console.log('\n2. Listing to verify...');
  const resp = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: '_test_multipart',
    MaxKeys: 5,
  }));
  console.log('   Objects found:', resp.KeyCount);
  if (resp.Contents) {
    for (const obj of resp.Contents) {
      console.log(`   - ${obj.Key} (${obj.Size} bytes, modified: ${obj.LastModified})`);
    }
  }

  if ((resp.KeyCount ?? 0) === 0) {
    console.log('\n>>> CRITICAL BUG: Upload.done() resolved but object is NOT in bucket! <<<');
    console.log('>>> The Upload class reports success but Scaleway is NOT persisting! <<<');
  } else {
    console.log('\n   Multipart upload verified OK. Cleaning up...');
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: testKey }));
    console.log('   Test object deleted.');
  }
} catch (err) {
  console.error('\nERROR:', err);
}
