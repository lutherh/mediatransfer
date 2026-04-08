import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(import.meta.dirname, '.env') });

const client = new S3Client({
  endpoint: process.env.SCW_REGION,
  region: 'nl-ams',
  credentials: { accessKeyId: process.env.SCW_ACCESS_KEY!, secretAccessKey: process.env.SCW_SECRET_KEY! },
  forcePathStyle: true,
});

let totalSize = 0, totalObjects = 0, token: string | undefined;
let pages = 0;
do {
  const resp = await client.send(new ListObjectsV2Command({ Bucket: process.env.SCW_BUCKET!, ContinuationToken: token, MaxKeys: 1000 }));
  for (const obj of resp.Contents ?? []) { totalSize += obj.Size ?? 0; totalObjects++; }
  token = resp.NextContinuationToken;
  pages++;
  if (pages % 10 === 0) process.stdout.write(`  ${totalObjects} objects scanned...\r`);
  if (!resp.IsTruncated) break;
} while (token);

console.log(`Total objects: ${totalObjects}`);
console.log(`Total size:    ${Math.round(totalSize / 1024 / 1024 / 1024)} GB (${(totalSize / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB)`);

// Scaleway free tier: 75 GB, paid: unlimited but billed per GB
// Check if there's a quota issue
const sizeGB = totalSize / 1024 / 1024 / 1024;
if (sizeGB > 70) {
  console.log(`\nWARNING: Bucket is at ${Math.round(sizeGB)} GB.`);
  console.log(`Scaleway Object Storage:`);
  console.log(`  - 75 GB included in free tier`);
  console.log(`  - Beyond that: €0.01/GB/month (Multi-AZ) or €0.006/GB/month (One Zone)`);
  console.log(`  - Max object size: 5 TB`);
  console.log(`  - No bucket size limit on paid plans`);
}

// Also check the 12 files with size mismatches
const mismatched = [
  'IMG_0175.MOV', 'IMG_0313.MOV', 'IMG_0452.MOV', 'IMG_0483.MOV',
  'IMG_1176.MOV', 'IMG_1695.MOV', 'IMG_4633.MOV', 'IMG_4653.MOV',
  'IMG_4654.MOV', 'IMG_4655.MOV', 'IMG_6007.MOV', 'IMG_6237.MOV'
];

console.log(`\nChecking S3 sizes for the 12 size-mismatched files...`);
let token2: string | undefined;
const s3Sizes = new Map<string, number>();
do {
  const resp = await client.send(new ListObjectsV2Command({ Bucket: process.env.SCW_BUCKET!, ContinuationToken: token2, MaxKeys: 1000 }));
  for (const obj of resp.Contents ?? []) {
    const key = obj.Key ?? '';
    const basename = key.split('/').pop() ?? '';
    if (mismatched.includes(basename) && !key.includes('_thumbs/')) {
      s3Sizes.set(`${key}`, obj.Size ?? 0);
    }
  }
  token2 = resp.NextContinuationToken;
  if (!resp.IsTruncated) break;
} while (token2);

console.log(`\nS3 copies of size-mismatched files:`);
for (const [key, size] of s3Sizes) {
  console.log(`  ${key}: ${Math.round(size / 1024 / 1024)} MB`);
}
