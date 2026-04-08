import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { resolve } from 'path';
import { execSync } from 'child_process';

dotenv.config({ path: resolve(import.meta.dirname, '.env') });

const client = new S3Client({
  endpoint: process.env.SCW_REGION,
  region: 'nl-ams',
  credentials: {
    accessKeyId: process.env.SCW_ACCESS_KEY!,
    secretAccessKey: process.env.SCW_SECRET_KEY!,
  },
  forcePathStyle: true,
});
const bucket = process.env.SCW_BUCKET!;

// Step 1: Get Downloads videos
const downloadsDir = path.join(process.env.USERPROFILE!, 'Downloads');
const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp']);
const dlFiles = fs.readdirSync(downloadsDir)
  .filter(f => videoExts.has(path.extname(f).toLowerCase()));

console.log(`Found ${dlFiles.length} videos in Downloads\n`);

// Step 2: Get Immich DB filenames
console.log('Querying Immich DB...');
const sqlQuery = `SELECT a."originalFileName" FROM asset a WHERE a.type = 'VIDEO' AND a."deletedAt" IS NULL;`;
const immichRaw = execSync(
  `docker exec immich_postgres psql -U immich -d immich -t -A -c "${sqlQuery.replace(/"/g, '\\"')}"`,
  { encoding: 'utf-8', shell: 'cmd.exe' }
);
const immichSet = new Set(immichRaw.split('\n').map(l => l.trim()).filter(Boolean));
console.log(`Immich DB has ${immichSet.size} videos\n`);

// Step 3: Build S3 index of actual video files (not thumbnails)
console.log('Building S3 video index (this may take a moment)...');
const s3Videos = new Map<string, { key: string; size: number }[]>();

let continuationToken: string | undefined;
let totalS3 = 0;
do {
  const resp = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    ContinuationToken: continuationToken,
    MaxKeys: 1000,
  }));
  for (const obj of resp.Contents ?? []) {
    const key = obj.Key ?? '';
    const lower = key.toLowerCase();
    if (lower.includes('_thumbs/')) continue;
    if (!videoExts.has(path.extname(lower))) continue;
    
    const baseName = path.basename(key);
    if (!s3Videos.has(baseName)) s3Videos.set(baseName, []);
    s3Videos.get(baseName)!.push({ key, size: obj.Size ?? 0 });
    totalS3++;
  }
  continuationToken = resp.NextContinuationToken;
  if (!resp.IsTruncated) break;
} while (continuationToken);

console.log(`S3 has ${totalS3} video files indexed\n`);

// Step 4: Categorize each Downloads file
const safeToDelete: { name: string; sizeMB: number }[] = [];
const inImmichOnly: string[] = [];
const inS3Only: string[] = [];
const inNeither: string[] = [];

for (const dlName of dlFiles) {
  const inImmich = immichSet.has(dlName);
  
  // For S3, match by filename (case-insensitive)
  const s3Match = s3Videos.get(dlName) || 
    [...s3Videos.entries()].find(([k]) => k.toLowerCase() === dlName.toLowerCase())?.[1];
  const inS3 = !!s3Match && s3Match.length > 0;
  
  const dlPath = path.join(downloadsDir, dlName);
  const dlSize = fs.statSync(dlPath).size;
  const dlSizeMB = Math.round(dlSize / 1024 / 1024);
  
  if (inImmich && inS3) {
    // Verify S3 file size roughly matches (within 5%)
    const s3Size = s3Match![0].size;
    const sizeRatio = Math.abs(s3Size - dlSize) / dlSize;
    if (sizeRatio < 0.05) {
      safeToDelete.push({ name: dlName, sizeMB: dlSizeMB });
    } else {
      console.log(`  WARNING: ${dlName} size mismatch! Downloads=${dlSizeMB}MB vs S3=${Math.round(s3Size/1024/1024)}MB — SKIPPING`);
      inImmichOnly.push(dlName); // treat as not fully safe
    }
  } else if (inImmich && !inS3) {
    inImmichOnly.push(dlName);
  } else if (!inImmich && inS3) {
    inS3Only.push(dlName);
  } else {
    inNeither.push(dlName);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`SAFE TO DELETE (in both Immich + S3): ${safeToDelete.length}`);
console.log(`In Immich only (not S3):              ${inImmichOnly.length}`);
console.log(`In S3 only (not Immich):              ${inS3Only.length}`);
console.log(`In neither:                           ${inNeither.length}`);
console.log(`${'='.repeat(60)}\n`);

if (safeToDelete.length > 0) {
  const totalMB = safeToDelete.reduce((s, f) => s + f.sizeMB, 0);
  console.log(`Will free ~${Math.round(totalMB / 1024)} GB by deleting ${safeToDelete.length} files:\n`);
  for (const f of safeToDelete) {
    console.log(`  ${f.name}  (${f.sizeMB} MB)`);
  }
  
  console.log(`\nDeleting...`);
  let deleted = 0;
  let errors = 0;
  for (const f of safeToDelete) {
    try {
      fs.unlinkSync(path.join(downloadsDir, f.name));
      deleted++;
    } catch (e: any) {
      console.log(`  ERROR deleting ${f.name}: ${e.message}`);
      errors++;
    }
  }
  console.log(`\nDone: ${deleted} deleted, ${errors} errors, ~${Math.round(totalMB / 1024)} GB freed`);
}

if (inImmichOnly.length > 0) {
  console.log(`\nKEPT (Immich only, no S3 backup):`);
  inImmichOnly.forEach(n => console.log(`  ${n}`));
}
if (inS3Only.length > 0) {
  console.log(`\nKEPT (S3 only, not in Immich):`);
  inS3Only.forEach(n => console.log(`  ${n}`));
}
if (inNeither.length > 0) {
  console.log(`\nKEPT (NOT in Immich or S3 — only copy!):`);
  inNeither.forEach(n => console.log(`  ${n}`));
}
