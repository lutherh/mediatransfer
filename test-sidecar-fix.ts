import { buildManifest } from './src/takeout/manifest.js';
import path from 'node:path';

const root = path.join(process.env.TEMP!, 'test-extract-sarah', 'Takeout', 'Google Photos');
console.log('Building manifest from:', root);

const entries = await buildManifest(root);
console.log(`\nResults (${entries.length} files):`);
for (const e of entries) {
  const sc = e.sidecarPath ? 'SIDECAR' : 'NONE   ';
  console.log(`  ${e.datePath.padEnd(15)} ${sc}  ${e.relativePath}`);
}

const unknowns = entries.filter(e => e.datePath === 'unknown-date');
console.log(`\nUnknown dates: ${unknowns.length} / ${entries.length}`);
