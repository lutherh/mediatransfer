import dotenv from 'dotenv';
dotenv.config();
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

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

console.log('=== Upload Test ===');
console.log('Bucket:', bucket);

try {
  // Upload a small test object
  console.log('\n1. Uploading test object...');
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: '_test_verify_upload.txt',
    Body: 'test-' + Date.now(),
    ContentType: 'text/plain',
  }));
  console.log('   Upload completed without error');

  // Verify it exists
  console.log('\n2. Listing to verify...');
  const resp = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: '_test',
    MaxKeys: 5,
  }));
  console.log('   Objects found:', resp.KeyCount);
  if (resp.Contents) {
    for (const obj of resp.Contents) {
      console.log(`   - ${obj.Key} (${obj.Size} bytes)`);
    }
  }

  if (resp.KeyCount === 0) {
    console.log('\n>>> CRITICAL: Upload succeeded but object not found! <<<');
    console.log('>>> This confirms uploads are silently failing or bucket has a lifecycle policy <<<');
  } else {
    console.log('\n   Upload verified successfully. Cleaning up...');
    await client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: '_test_verify_upload.txt',
    }));
    console.log('   Test object deleted.');
    console.log('\n>>> Uploads work fine. The issue is elsewhere. <<<');
  }
} catch (err) {
  console.error('\nERROR:', err);
}
