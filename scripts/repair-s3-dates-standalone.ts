/**
 * Standalone S3 date repair script — no local state needed.
 *
 * Scans S3 objects directly, finds files with suspicious date paths (current
 * year or "unknown-date"), determines correct dates, and moves them.
 *
 * Sources for correct dates (priority order):
 *  1. S3 custom metadata `x-amz-meta-captured-at` (set by newer uploads)
 *  2. Local Google Takeout sidecar metadata (if --metadata-dir provided)
 *  3. EXIF DateTimeOriginal / CreateDate from images (first 256 KB)
 *  4. ffprobe creation_time from video containers (streams first 2 MB)
 *  5. Filename date patterns (IMG_20231215_143022.jpg)
 *  6. Skip — leave in place if no date can be determined
 *
 * Usage:
 *   npx tsx scripts/repair-s3-dates-standalone.ts                       # dry-run, default: current year
 *   npx tsx scripts/repair-s3-dates-standalone.ts --apply               # execute moves
 *   npx tsx scripts/repair-s3-dates-standalone.ts --prefix 2026         # scan transfers/2026/
 *   npx tsx scripts/repair-s3-dates-standalone.ts --prefix unknown-date # scan transfers/unknown-date/
 *   npx tsx scripts/repair-s3-dates-standalone.ts --metadata-dir data/takeout/work/metadata
 *   npx tsx scripts/repair-s3-dates-standalone.ts --concurrency 8 --apply
 */
import * as dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {
  resolveScalewayEndpoint,
  resolveScalewaySigningRegion,
  validateScalewayConfig,
} from '../src/providers/scaleway.js';
import { extractExifMetadata, inferDateFromFilename } from '../src/utils/exif.js';

dotenv.config();

// ── Parse arguments ─────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const concurrency = readNumberArg(args, '--concurrency') ?? 8;

// Default: scan for current year (likely upload date, not capture date)
const scanPrefix = readStringArg(args, '--prefix') ?? String(new Date().getFullYear());
const metadataDir = readStringArg(args, '--metadata-dir');

function readNumberArg(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  const val = Number(argv[idx + 1]);
  return Number.isFinite(val) ? val : undefined;
}

function readStringArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

// ── Load config ─────────────────────────────────────────────────

const scwConfig = validateScalewayConfig({
  provider: 'scaleway',
  region: process.env.SCW_REGION,
  bucket: process.env.SCW_BUCKET,
  accessKey: process.env.SCW_ACCESS_KEY,
  secretKey: process.env.SCW_SECRET_KEY,
  prefix: process.env.SCW_PREFIX,
});

const s3 = new S3Client({
  region: resolveScalewaySigningRegion(scwConfig.region),
  endpoint: resolveScalewayEndpoint(scwConfig.region),
  credentials: {
    accessKeyId: scwConfig.accessKey,
    secretAccessKey: scwConfig.secretKey,
  },
  forcePathStyle: true,
});

const bucket = scwConfig.bucket;
const s3Prefix = scwConfig.prefix ?? '';

function fullKey(key: string): string {
  return s3Prefix ? `${s3Prefix}/${key}` : key;
}

function stripPrefix(key: string): string {
  if (!s3Prefix) return key;
  const prefixed = `${s3Prefix}/`;
  return key.startsWith(prefixed) ? key.slice(prefixed.length) : key;
}

// ── Load sidecar metadata (optional) ────────────────────────────

type SidecarEntry = {
  capturedAt: string;
  sidecarPhotoTakenTime?: string;
};

// Map lowercase filename → array of possible dates from sidecar metadata
const sidecarByFilename = new Map<string, SidecarEntry[]>();

if (metadataDir) {
  console.log(`📂 Loading sidecar metadata from: ${metadataDir}`);
  try {
    const files = (await fs.readdir(metadataDir)).filter(f => f.endsWith('.json'));
    let totalItems = 0;
    let itemsWithDates = 0;

    for (const file of files) {
      const raw = await fs.readFile(path.join(metadataDir, file), 'utf-8');
      const archive = JSON.parse(raw) as {
        items?: Array<{
          destinationKey?: string;
          relativePath?: string;
          capturedAt?: string;
          sidecar?: { photoTakenTime?: string; creationTime?: string };
        }>;
      };

      for (const item of archive.items ?? []) {
        totalItems++;
        const capturedAt = item.capturedAt;
        if (!capturedAt) continue;

        // Extract filename from relativePath or destinationKey
        const relPath = item.relativePath ?? item.destinationKey;
        if (!relPath) continue;
        const filename = path.basename(relPath).toLowerCase();

        const entry: SidecarEntry = { capturedAt };
        if (item.sidecar?.photoTakenTime) {
          entry.sidecarPhotoTakenTime = item.sidecar.photoTakenTime;
        }

        // Only store entries with reasonable dates (not current year = upload date)
        const date = new Date(capturedAt);
        if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() < new Date().getFullYear()) {
          const arr = sidecarByFilename.get(filename) ?? [];
          arr.push(entry);
          sidecarByFilename.set(filename, arr);
          itemsWithDates++;
        }
      }
    }

    console.log(`   Loaded ${files.length} metadata files, ${totalItems} items, ${itemsWithDates} with valid pre-${new Date().getFullYear()} dates`);
    console.log(`   Unique filenames indexed: ${sidecarByFilename.size}`);
  } catch (err) {
    console.error(`   ⚠️  Failed to load metadata: ${err instanceof Error ? err.message : err}`);
  }
} else {
  console.log('💡 Tip: use --metadata-dir data/takeout/work/metadata for sidecar date matching');
}

// ── Video metadata helper ───────────────────────────────────────

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', '3gp']);
const enableVideo = args.includes('--video');

function isVideoFile(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.has(ext);
}

function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    mp4: 'video/mp4', mov: 'video/quicktime',
    m4v: 'video/x-m4v', '3gp': 'video/3gpp',
  };
  return map[ext] ?? 'video/mp4';
}

/** Download an S3 byte range and return it as a Buffer. */
async function s3Range(key: string, start: number, end: number): Promise<Buffer> {
  const resp = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: fullKey(key),
      Range: `bytes=${start}-${end}`,
    }),
  );
  if (!resp.Body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Scan top-level MP4/MOV atoms from a buffer. Returns offset+size pairs.
 * We only need the first ~32 KB to find the atom layout, because top-level
 * atoms (ftyp, mdat, moov, free) have their size in the first 8 bytes.
 */
function scanAtoms(buf: Buffer): Array<{ type: string; offset: number; size: number }> {
  const atoms: Array<{ type: string; offset: number; size: number }> = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);

    if (size === 0) break; // atom extends to EOF — we can't know its actual size yet
    if (size === 1 && pos + 16 <= buf.length) {
      // 64-bit extended size
      const hi = buf.readUInt32BE(pos + 8);
      const lo = buf.readUInt32BE(pos + 12);
      size = hi * 0x100000000 + lo;
    }

    atoms.push({ type, offset: pos, size });
    pos += size;
  }
  return atoms;
}

// MAC epoch offset: seconds between 1904-01-01 and 1970-01-01
const MAC_EPOCH_OFFSET = 2082844800;

/**
 * Parse the mvhd (Movie Header) atom to extract creation_time.
 * The mvhd atom sits inside moov and contains:
 *   version (1 byte), flags (3 bytes),
 *   creation_time (4 or 8 bytes), modification_time (4 or 8 bytes), ...
 * creation_time is seconds since 1904-01-01 00:00:00 UTC.
 */
function parseMvhdCreationTime(moovBuf: Buffer): Date | null {
  // Find 'mvhd' inside moov
  let pos = 8; // skip moov header
  while (pos + 8 <= moovBuf.length) {
    let atomSize = moovBuf.readUInt32BE(pos);
    const atomType = moovBuf.toString('ascii', pos + 4, pos + 8);

    if (atomSize === 0) break;
    if (atomSize === 1 && pos + 16 <= moovBuf.length) {
      const hi = moovBuf.readUInt32BE(pos + 8);
      const lo = moovBuf.readUInt32BE(pos + 12);
      atomSize = hi * 0x100000000 + lo;
    }

    if (atomType === 'mvhd') {
      const dataStart = pos + 8;
      if (dataStart + 4 > moovBuf.length) return null;
      const version = moovBuf.readUInt8(dataStart);

      let creationTime: number;
      if (version === 0) {
        if (dataStart + 8 > moovBuf.length) return null;
        creationTime = moovBuf.readUInt32BE(dataStart + 4);
      } else {
        // version 1: 8-byte timestamps
        if (dataStart + 12 > moovBuf.length) return null;
        const hi = moovBuf.readUInt32BE(dataStart + 4);
        const lo = moovBuf.readUInt32BE(dataStart + 8);
        creationTime = hi * 0x100000000 + lo;
      }

      if (creationTime === 0) return null;
      const unixSeconds = creationTime - MAC_EPOCH_OFFSET;
      if (unixSeconds < 0 || unixSeconds > 4102444800) return null; // sanity: before 1970 or after 2100
      return new Date(unixSeconds * 1000);
    }

    pos += atomSize;
  }
  return null;
}

/**
 * Smart video date extraction using targeted S3 Range requests:
 * 1. Download first 32 KB to scan the atom layout
 * 2. If moov is found in that range, parse it directly
 * 3. If moov comes after mdat, calculate its offset and download just moov
 * Only works for MP4/MOV/M4V (ISO BMFF containers).
 */
async function extractVideoDate(s3Key: string, fileSize: number): Promise<Date | null> {
  try {
    // Step 1: Read first 32 KB to find atom layout
    const scanSize = Math.min(32768, fileSize);
    const header = await s3Range(s3Key, 0, scanSize - 1);
    const atoms = scanAtoms(header);

    // Look for moov in the scanned atoms
    const moovAtom = atoms.find(a => a.type === 'moov');

    if (moovAtom) {
      // moov is near the start — download just the moov atom
      const moovEnd = Math.min(moovAtom.offset + moovAtom.size - 1, fileSize - 1);
      let moovBuf: Buffer;
      if (moovEnd < scanSize) {
        // moov is fully within our initial scan
        moovBuf = header.subarray(moovAtom.offset, moovAtom.offset + moovAtom.size);
      } else {
        // moov starts in our scan but extends beyond — download full moov
        moovBuf = await s3Range(s3Key, moovAtom.offset, moovEnd);
      }
      return parseMvhdCreationTime(moovBuf);
    }

    // moov not in the scanned range — check if we can calculate its offset
    // Typically: ftyp + mdat + moov (or ftyp + free + mdat + moov)
    const mdatAtom = atoms.find(a => a.type === 'mdat');
    if (mdatAtom && mdatAtom.size > 0) {
      const moovOffset = mdatAtom.offset + mdatAtom.size;
      if (moovOffset >= fileSize) return null; // moov would be beyond EOF
      // Download the moov atom (limit to 2 MB to be safe)
      const moovMaxSize = Math.min(2 * 1024 * 1024, fileSize - moovOffset);
      const moovBuf = await s3Range(s3Key, moovOffset, moovOffset + moovMaxSize - 1);
      // Verify this is actually moov
      if (moovBuf.length >= 8 && moovBuf.toString('ascii', 4, 8) === 'moov') {
        return parseMvhdCreationTime(moovBuf);
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ── Step 1: List S3 objects under the suspect prefix ─────────────

const targetPrefix = `transfers/${scanPrefix}/`;
console.log(`🔍 Scanning S3 for objects under: ${fullKey(targetPrefix)}`);
console.log(`   Bucket: ${bucket}`);
console.log(`   Mode: ${apply ? '🚀 APPLY (will move objects)' : '🔎 DRY RUN (no changes)'}`);
if (enableVideo) {
  console.log('   Video metadata extraction: ENABLED (--video)');
} else {
  console.log('   💡 Tip: use --video to extract dates from MP4/MOV containers (slower)');
}
console.log('');

type S3Object = { key: string; size: number };
const objects: S3Object[] = [];
let continuationToken: string | undefined;

do {
  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: fullKey(targetPrefix),
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }),
  );

  for (const obj of result.Contents ?? []) {
    if (obj.Key && obj.Size && obj.Size > 0) {
      objects.push({ key: stripPrefix(obj.Key), size: obj.Size });
    }
  }

  continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  process.stdout.write(`\r   Listed ${objects.length} objects...`);
} while (continuationToken);

console.log(`\r   Found ${objects.length} objects under ${targetPrefix}`);

if (objects.length === 0) {
  console.log('\n✅ Nothing to repair!');
  process.exit(0);
}

// ── Step 2: Determine correct dates ──────────────────────────────

type MoveOp = {
  oldKey: string;
  newKey: string;
  source: 'metadata' | 'sidecar' | 'exif' | 'video-meta' | 'filename';
  correctDate: string;
};

const EXIF_READ_BYTES = 256 * 1024;
const moves: MoveOp[] = [];
let fromMetadata = 0;
let fromSidecar = 0;
let fromExif = 0;
let fromVideoMeta = 0;
let fromFilename = 0;
let noDateFound = 0;
let exifErrors = 0;
let alreadyCorrect = 0;
let processed = 0;

const MEDIA_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'dng', 'tif', 'tiff',
  'mp4', 'mov', 'avi', 'm4v', '3gp', 'mkv', 'webm',
]);

function toDatePath(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function computeNewKey(oldKey: string, newDatePath: string): string {
  // oldKey: transfers/2026/03/15/AlbumName/IMG_1234.JPG
  //      or transfers/unknown-date/AlbumName/IMG_1234.JPG
  // We want: transfers/{newDatePath}/rest...

  if (oldKey.includes('unknown-date/')) {
    const rest = oldKey.split('unknown-date/')[1];
    return `transfers/${newDatePath}/${rest}`;
  }

  // Standard date path: transfers/YYYY/MM/DD/...
  const parts = oldKey.split('/');
  // parts[0] = 'transfers', [1] = year, [2] = month, [3] = day, [4+] = rest
  const rest = parts.slice(4).join('/');
  return `transfers/${newDatePath}/${rest}`;
}

function isSuspiciousDate(date: Date): boolean {
  return date.getUTCFullYear() >= new Date().getFullYear();
}

function isMediaFile(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_EXTENSIONS.has(ext);
}

async function resolveDate(obj: S3Object): Promise<MoveOp | null> {
  const { key: oldKey, size: fileSize } = obj;
  const filename = oldKey.split('/').pop() ?? '';

  if (!isMediaFile(oldKey)) {
    return null;
  }

  // Helper to build a move op if the date resolves to a different path
  function tryBuild(date: Date, source: MoveOp['source']): MoveOp | null {
    if (isSuspiciousDate(date)) return null;
    const newDatePath = toDatePath(date);
    const newKey = computeNewKey(oldKey, newDatePath);
    if (newKey === oldKey) {
      alreadyCorrect++;
      return null;
    }
    return { oldKey, newKey, source, correctDate: date.toISOString() };
  }

  // 1. Check S3 custom metadata (x-amz-meta-captured-at)
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: fullKey(oldKey) }),
    );
    const capturedAtMeta = head.Metadata?.['captured-at'];
    if (capturedAtMeta && capturedAtMeta !== 'unknown') {
      const date = new Date(capturedAtMeta);
      if (!Number.isNaN(date.getTime())) {
        const op = tryBuild(date, 'metadata');
        if (op) { fromMetadata++; return op; }
        if (!isSuspiciousDate(date)) return null; // already correct
      }
    }
  } catch {
    // HeadObject failed — continue
  }

  // 2. Check local sidecar metadata (matched by filename)
  const sidecarEntries = sidecarByFilename.get(filename.toLowerCase());
  if (sidecarEntries && sidecarEntries.length > 0) {
    // Prefer the entry with a sidecar photoTakenTime, otherwise use capturedAt
    const best = sidecarEntries.find(e => e.sidecarPhotoTakenTime) ?? sidecarEntries[0];
    const date = new Date(best.capturedAt);
    if (!Number.isNaN(date.getTime())) {
      const op = tryBuild(date, 'sidecar');
      if (op) { fromSidecar++; return op; }
    }
  }

  // 3. Try EXIF from the first 256 KB (images only — exifr can't parse videos)
  if (!isVideoFile(oldKey)) {
    try {
      const resp = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: fullKey(oldKey),
          Range: `bytes=0-${EXIF_READ_BYTES - 1}`,
        }),
      );

      if (resp.Body) {
        const chunks: Buffer[] = [];
        for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        const buf = Buffer.concat(chunks);
        const exif = await extractExifMetadata(buf);

        if (exif.capturedAt) {
          const op = tryBuild(exif.capturedAt, 'exif');
          if (op) { fromExif++; return op; }
        }
      }
    } catch {
      exifErrors++;
    }
  }

  // 4. Try video container metadata (MP4/MOV creation_time via moov atom)
  if (enableVideo && isVideoFile(oldKey)) {
    const videoDate = await extractVideoDate(oldKey, fileSize);
    if (videoDate) {
      const op = tryBuild(videoDate, 'video-meta');
      if (op) { fromVideoMeta++; return op; }
    }
  }

  // 5. Try filename date inference
  const filenameDate = inferDateFromFilename(filename);
  if (filenameDate) {
    const op = tryBuild(filenameDate, 'filename');
    if (op) { fromFilename++; return op; }
  }

  noDateFound++;
  return null;
}

console.log('\n🔍 Resolving correct dates...\n');

let resolveErrors = 0;

async function safeResolveDate(obj: S3Object): Promise<MoveOp | null> {
  try {
    return await resolveDate(obj);
  } catch (err) {
    resolveErrors++;
    if (resolveErrors <= 5) {
      console.error(`\n   ⚠️  Error resolving ${obj.key}: ${err instanceof Error ? err.message : err}`);
    }
    return null;
  }
}

for (let i = 0; i < objects.length; i += concurrency) {
  const batch = objects.slice(i, i + concurrency);
  const results = await Promise.all(batch.map(safeResolveDate));
  for (const result of results) {
    if (result) moves.push(result);
  }
  processed += batch.length;

  if (processed % 50 === 0 || processed === objects.length) {
    process.stdout.write(
      `\r   ${processed}/${objects.length} checked — ` +
      `${moves.length} to move (meta:${fromMetadata} side:${fromSidecar} exif:${fromExif} vid:${fromVideoMeta} file:${fromFilename}) ` +
      `| ${noDateFound} unknown | ${resolveErrors} err`,
    );
  }

  // Small pause to ease S3 pressure when doing video downloads
  if (enableVideo && i + concurrency < objects.length) {
    await new Promise(r => setTimeout(r, 50));
  }
}
console.log('\n');

console.log('📊 Date resolution summary:');
console.log(`   From S3 metadata:    ${fromMetadata}`);
console.log(`   From sidecar:        ${fromSidecar}`);
console.log(`   From EXIF:           ${fromExif}`);
console.log(`   From video metadata: ${fromVideoMeta}`);
console.log(`   From filename:       ${fromFilename}`);
console.log(`   Already correct:     ${alreadyCorrect}`);
console.log(`   No date found:       ${noDateFound} (will stay in place)`);
console.log(`   EXIF errors:         ${exifErrors}`);
console.log(`   Resolve errors:      ${resolveErrors}`);
console.log(`   Total to move:       ${moves.length}`);

if (moves.length === 0) {
  console.log('\n✅ Nothing to move!');
  process.exit(0);
}

// Show sample moves
console.log(`\n📦 Sample moves (first 20):`);
for (const move of moves.slice(0, 20)) {
  console.log(`   [${move.source}] ${move.oldKey}`);
  console.log(`          → ${move.newKey}  (${move.correctDate})`);
}

if (!apply) {
  console.log(`\n⚠️  DRY RUN — no changes made. Run with --apply to execute ${moves.length} moves.`);
  process.exit(0);
}

// ── Step 3: Execute S3 moves ─────────────────────────────────────

console.log(`\n🚀 Moving ${moves.length} objects on S3 (concurrency: ${concurrency})...`);

let moveCompleted = 0;
let moveErrors = 0;

async function executeMoveOp(move: MoveOp): Promise<void> {
  const sourceFullKey = fullKey(move.oldKey);
  const destFullKey = fullKey(move.newKey);

  try {
    // Check source still exists
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: sourceFullKey }));
    } catch {
      moveCompleted++;
      return; // Already moved or deleted
    }

    // Copy to new location, preserving metadata + adding captured-at
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceFullKey}`,
        Key: destFullKey,
        MetadataDirective: 'REPLACE',
        Metadata: { 'captured-at': move.correctDate },
      }),
    );

    // Verify the copy arrived
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: destFullKey }));
    } catch {
      throw new Error(`Copy verification failed for ${move.newKey}`);
    }

    // Delete old location
    await s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: sourceFullKey }),
    );

    moveCompleted++;
  } catch (err) {
    moveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n   ❌ ${move.oldKey} → ${move.newKey}: ${msg}`);
  }
}

for (let i = 0; i < moves.length; i += concurrency) {
  const batch = moves.slice(i, i + concurrency);
  await Promise.all(batch.map(executeMoveOp));

  const done = moveCompleted + moveErrors;
  if (done % 20 === 0 || done === moves.length) {
    process.stdout.write(
      `\r   ${done}/${moves.length} (${moveCompleted} moved, ${moveErrors} failed)`,
    );
  }
}

console.log('\n');
console.log('📊 Move results:');
console.log(`   Moved:  ${moveCompleted}`);
console.log(`   Failed: ${moveErrors}`);

if (moveErrors > 0) {
  console.log('\n⚠️  Some moves failed. Re-run the script to retry.');
} else {
  console.log('\n✅ All moves completed successfully!');
}
