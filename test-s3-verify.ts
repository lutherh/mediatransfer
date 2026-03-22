import dotenv from 'dotenv';
dotenv.config();
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

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
const prefix = process.env.SCW_PREFIX || '';

console.log('=== S3 Bucket Verification ===');
console.log('Bucket:', bucket);
console.log('Prefix:', prefix || '(none)');
console.log('Region: nl-ams');
console.log('');

try {
  // List with no prefix - see everything
  const resp = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    MaxKeys: 20,
  }));
  console.log('KeyCount (no prefix):', resp.KeyCount);
  console.log('IsTruncated:', resp.IsTruncated);
  if (resp.Contents && resp.Contents.length > 0) {
    console.log('First objects:');
    for (const obj of resp.Contents) {
      console.log(`  ${obj.Key} (${obj.Size} bytes, ${obj.LastModified})`);
    }
  } else {
    console.log('>>> BUCKET IS EMPTY - no objects found <<<');
  }

  // Also try with "transfers/" prefix since state keys start with that
  console.log('');
  const resp2 = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: 'transfers/',
    MaxKeys: 10,
  }));
  console.log('KeyCount (transfers/ prefix):', resp2.KeyCount);
  if (resp2.Contents && resp2.Contents.length > 0) {
    console.log('First objects with transfers/:');
    for (const obj of resp2.Contents) {
      console.log(`  ${obj.Key} (${obj.Size} bytes)`);
    }
  } else {
    console.log('>>> No objects with "transfers/" prefix <<<');
  }
} catch (err) {
  console.error('S3 ERROR:', err);
}
