/**
 * Debug script: test MP4 moov atom extraction on a real S3 video.
 * Usage: npx tsx scripts/test-moov-debug.ts
 */
import * as dotenv from 'dotenv';
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

dotenv.config();

const s3 = new S3Client({
  region: 'nl-ams',
  endpoint: 'https://s3.nl-ams.scw.cloud',
  credentials: {
    accessKeyId: process.env.SCW_ACCESS_KEY!,
    secretAccessKey: process.env.SCW_SECRET_KEY!,
  },
  forcePathStyle: true,
});
const bucket = process.env.SCW_BUCKET!;
const prefix = process.env.SCW_PREFIX!;

// Find MOV/MP4 files under 2026/01
const searchPrefix = prefix ? `${prefix}/transfers/2026/03/` : `transfers/2026/03/`;
const list = await s3.send(
  new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: searchPrefix,
    MaxKeys: 500,
  }),
);

const allFiles = list.Contents || [];
console.log(`Total files listed: ${allFiles.length}`);
if (allFiles.length > 0) {
  for (const f of allFiles.slice(0, 5)) {
    console.log(`  ${f.Key?.split('/').pop()} (${f.Size})`);
  }
}

const videoFiles = allFiles.filter(
  (o) => {
    const key = o.Key?.toLowerCase() || '';
    return key.endsWith('.mov') || key.endsWith('.mp4') || key.endsWith('.avi') || key.endsWith('.m4v');
  },
);
console.log(`Found ${videoFiles.length} video files under 2026/03/`);

// Test first 5 videos
for (const file of videoFiles.slice(0, 5)) {
  console.log(`\n--- ${file.Key} (${file.Size} bytes) ---`);

  // Download first 32 KB
  const resp = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: file.Key!,
      Range: 'bytes=0-32767',
    }),
  );

  const chunks: Buffer[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);

  // Scan top-level atoms
  let pos = 0;
  const atoms: Array<{ type: string; offset: number; size: number }> = [];
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (size === 0) break;
    if (size === 1 && pos + 16 <= buf.length) {
      const hi = buf.readUInt32BE(pos + 8);
      const lo = buf.readUInt32BE(pos + 12);
      size = hi * 0x100000000 + lo;
    }
    atoms.push({ type, offset: pos, size });
    console.log(`  Atom: ${type} offset=${pos} size=${size}`);
    pos += size;
  }

  const moovAtom = atoms.find((a) => a.type === 'moov');
  const mdatAtom = atoms.find((a) => a.type === 'mdat');

  if (moovAtom) {
    console.log(`  ✅ moov found at offset ${moovAtom.offset}, size ${moovAtom.size}`);
  } else if (mdatAtom) {
    const moovOffset = mdatAtom.offset + mdatAtom.size;
    console.log(
      `  ℹ️  moov likely at offset ${moovOffset} (after mdat at ${mdatAtom.offset}, size ${mdatAtom.size})`,
    );

    if (moovOffset < (file.Size || 0)) {
      // Try to read moov from that offset
      const moovMax = Math.min(2 * 1024 * 1024, (file.Size || 0) - moovOffset);
      const moovResp = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: file.Key!,
          Range: `bytes=${moovOffset}-${moovOffset + moovMax - 1}`,
        }),
      );
      const moovChunks: Buffer[] = [];
      for await (const chunk of moovResp.Body as AsyncIterable<Uint8Array>) {
        moovChunks.push(Buffer.from(chunk));
      }
      const moovBuf = Buffer.concat(moovChunks);

      if (moovBuf.length >= 8) {
        const moovType = moovBuf.toString('ascii', 4, 8);
        console.log(`  Downloaded ${moovBuf.length} bytes at offset ${moovOffset}, type: '${moovType}'`);

        if (moovType === 'moov') {
          // Find mvhd inside moov
          let mPos = 8;
          while (mPos + 8 <= moovBuf.length) {
            let aSize = moovBuf.readUInt32BE(mPos);
            const aType = moovBuf.toString('ascii', mPos + 4, mPos + 8);
            if (aSize === 0) break;
            if (aSize === 1 && mPos + 16 <= moovBuf.length) {
              const hi = moovBuf.readUInt32BE(mPos + 8);
              const lo = moovBuf.readUInt32BE(mPos + 12);
              aSize = hi * 0x100000000 + lo;
            }
            console.log(`    moov child: ${aType} offset=${mPos} size=${aSize}`);

            if (aType === 'mvhd') {
              const dataStart = mPos + 8;
              const version = moovBuf.readUInt8(dataStart);
              const MAC_EPOCH_OFFSET = 2082844800;
              let creationTime: number;
              if (version === 0) {
                creationTime = moovBuf.readUInt32BE(dataStart + 4);
              } else {
                const hi = moovBuf.readUInt32BE(dataStart + 4);
                const lo = moovBuf.readUInt32BE(dataStart + 8);
                creationTime = hi * 0x100000000 + lo;
              }
              console.log(`    mvhd version=${version}, creationTime raw=${creationTime}`);
              if (creationTime > 0) {
                const unixSeconds = creationTime - MAC_EPOCH_OFFSET;
                const date = new Date(unixSeconds * 1000);
                console.log(`    ✅ Creation date: ${date.toISOString()}`);
              } else {
                console.log(`    ❌ creationTime is 0 (not set)`);
              }
            }

            mPos += aSize;
          }
        }
      }
    }
  } else {
    console.log('  ❌ No moov or mdat found in first 32 KB');
  }
}

console.log('\nDone.');
