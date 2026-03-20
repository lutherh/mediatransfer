/** Wrapper to run the repair script and capture output cleanly. */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const outputFile = 'c:\\dev\\PhotosBackup\\mediatransfer\\repair-output.txt';
const prefix = process.argv[2] || '2026/03/03';

try {
  const result = execSync(
    `npx tsx scripts/repair-s3-dates-standalone.ts --prefix "${prefix}" --metadata-dir data/takeout/work/metadata --video --concurrency 6`,
    {
      cwd: 'c:\\dev\\PhotosBackup\\mediatransfer',
      timeout: 15 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    },
  );
  // Clean \r carriage returns - keep only the final version of each line
  const cleaned = result
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      return parts[parts.length - 1];
    })
    .filter((l) => l.trim().length > 0)
    .join('\n');
  writeFileSync(outputFile, cleaned, 'utf8');
  console.log(`✅ Done. Output: ${outputFile}`);
} catch (err: any) {
  const output = ((err.stdout || '') + '\n' + (err.stderr || '')).trim();
  writeFileSync(outputFile, output, 'utf8');
  console.log(`❌ Error (exit code ${err.status}). Output: ${outputFile}`);
}
