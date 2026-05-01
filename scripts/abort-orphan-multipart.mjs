// One-shot: abort all in-flight multipart uploads on the bucket.
// Used 2026-04-30 to recover from a hung overnight run.
import { S3Client, ListMultipartUploadsCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

const c = new S3Client({
  region: process.env.SCW_REGION,
  endpoint: `https://s3.${process.env.SCW_REGION}.scw.cloud`,
  credentials: {
    accessKeyId: process.env.SCW_ACCESS_KEY,
    secretAccessKey: process.env.SCW_SECRET_KEY,
  },
});

const r = await c.send(new ListMultipartUploadsCommand({ Bucket: process.env.SCW_BUCKET }));
const uploads = r.Uploads || [];
console.log(`Found ${uploads.length} multipart uploads`);
for (const u of uploads) {
  console.log('Aborting:', u.Key, '   uploadId:', u.UploadId);
  await c.send(new AbortMultipartUploadCommand({
    Bucket: process.env.SCW_BUCKET,
    Key: u.Key,
    UploadId: u.UploadId,
  }));
}
console.log('Done.');
