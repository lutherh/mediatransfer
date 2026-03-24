import fs from 'fs/promises';
import path from 'path';

const dir = 'data/takeout/work/metadata';
const files = await fs.readdir(dir);

// Build multi-value lookup: filename → [sidecar entries]
const sidecarByFilename = new Map<string, Array<{ destinationKey: string; photoTakenTime?: string; creationTime?: string }>>();

for (const f of files) {
  const raw = await fs.readFile(path.join(dir, f), 'utf8');
  const meta = JSON.parse(raw);
  for (const item of meta.items) {
    if (item.sidecar && (item.sidecar.photoTakenTime || item.sidecar.creationTime)) {
      const basename = item.destinationKey.split('/').pop()!;
      if (!sidecarByFilename.has(basename)) sidecarByFilename.set(basename, []);
      sidecarByFilename.get(basename)!.push({
        destinationKey: item.destinationKey,
        photoTakenTime: item.sidecar.photoTakenTime,
        creationTime: item.sidecar.creationTime,
      });
    }
  }
}

// Check collision stats
let uniqueFilenames = 0;
let duplicateFilenames = 0;
for (const [, entries] of sidecarByFilename) {
  if (entries.length === 1) uniqueFilenames++;
  else duplicateFilenames++;
}
console.log(`Unique filenames with sidecar: ${uniqueFilenames}`);
console.log(`Filenames with multiple sidecars: ${duplicateFilenames}`);

// Also try album+filename matching
// 2026 keys look like: transfers/2026/03/15/AlbumName/filename.ext
// Sidecar destKeys:    transfers/2020/05/15/AlbumName/filename.ext
// Extract album by taking the 4th path segment
// Use canonical implementation that handles both dated and undated keys
import { extractAlbumFile } from '../src/utils/date-repair.js';

const sidecarByAlbumFile = new Map<string, { photoTakenTime?: string; creationTime?: string }>();
for (const [, entries] of sidecarByFilename) {
  for (const entry of entries) {
    const albumFile = extractAlbumFile(entry.destinationKey);
    sidecarByAlbumFile.set(albumFile, entry);
  }
}

const state = JSON.parse(await fs.readFile('data/takeout/state.json', 'utf8'));
const keys2026 = Object.keys(state.items).filter(k => k.startsWith('transfers/2026/'));
console.log(`\n2026 keys: ${keys2026.length}`);

let matchedByAlbumFile = 0;
let matchedByUniqueFilename = 0;
let matchedByAnyFilename = 0;
let unmatchedCount = 0;
const unmatchedSamples: string[] = [];

for (const key of keys2026) {
  const albumFile = extractAlbumFile(key);
  const basename = key.split('/').pop()!;

  if (sidecarByAlbumFile.has(albumFile)) {
    matchedByAlbumFile++;
  } else if (sidecarByFilename.has(basename)) {
    const entries = sidecarByFilename.get(basename)!;
    if (entries.length === 1) matchedByUniqueFilename++;
    else matchedByAnyFilename++;
  } else {
    unmatchedCount++;
    if (unmatchedSamples.length < 10) unmatchedSamples.push(key);
  }
}

console.log(`Matched by album+filename: ${matchedByAlbumFile}`);
console.log(`Matched by unique filename only: ${matchedByUniqueFilename}`);
console.log(`Matched by ambiguous filename: ${matchedByAnyFilename}`);
console.log(`Unmatched: ${unmatchedCount}`);
console.log(`\nTotal resolvable: ${matchedByAlbumFile + matchedByUniqueFilename}`);
console.log(`\nUnmatched samples:`);
for (const s of unmatchedSamples) console.log(`  ${s}`);
