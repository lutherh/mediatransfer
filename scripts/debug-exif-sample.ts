import * as dotenv from 'dotenv';
dotenv.config();
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  resolveScalewayEndpoint,
  resolveScalewaySigningRegion,
  validateScalewayConfig,
} from '../src/providers/scaleway.js';
import { extractExifMetadata } from '../src/utils/exif.js';
import fs from 'fs/promises';

const cfg = validateScalewayConfig({
  provider: 'scaleway',
  region: process.env.SCW_REGION,
  bucket: process.env.SCW_BUCKET,
  accessKey: process.env.SCW_ACCESS_KEY,
  secretKey: process.env.SCW_SECRET_KEY,
  prefix: process.env.SCW_PREFIX,
});
const s3 = new S3Client({
  region: resolveScalewaySigningRegion(cfg.region),
  endpoint: resolveScalewayEndpoint(cfg.region),
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  forcePathStyle: true,
});

const state = JSON.parse(await fs.readFile('data/takeout/state.json', 'utf8'));
const keys2026 = Object.keys(state.items).filter((k: string) => k.startsWith('transfers/2026/'));
const imageKeys = keys2026.filter((k: string) => /\.(jpg|jpeg|heic|png)$/i.test(k));
console.log('Total 2026 image keys:', imageKeys.length);

for (const key of imageKeys.slice(0, 10)) {
  const full = cfg.prefix ? `${cfg.prefix}/${key}` : key;
  try {
    const resp = await s3.send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: full, Range: 'bytes=0-262143' }),
    );
    const chunks: Buffer[] = [];
    for await (const c of resp.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
    const buf = Buffer.concat(chunks);
    const exif = await extractExifMetadata(buf);
    console.log(key, '→ capturedAt:', exif.capturedAt?.toISOString() ?? 'none', '| size:', buf.length);
  } catch (e: any) {
    console.log(key, '→ ERROR:', e.Code ?? e.name, String(e.message).slice(0, 100));
  }
}
