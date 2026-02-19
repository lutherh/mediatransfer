import * as dotenv from 'dotenv';
import { loadTakeoutConfig } from '../src/takeout/config.js';
import { runTakeoutUpload } from '../src/takeout/runner.js';
import { validateScalewayConfig, ScalewayProvider } from '../src/providers/scaleway.js';

dotenv.config();

const config = loadTakeoutConfig();
const scalewayConfig = validateScalewayConfig({
  provider: 'scaleway',
  region: process.env.SCW_REGION,
  bucket: process.env.SCW_BUCKET,
  accessKey: process.env.SCW_ACCESS_KEY,
  secretKey: process.env.SCW_SECRET_KEY,
  prefix: process.env.SCW_PREFIX,
});

const provider = new ScalewayProvider(scalewayConfig);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const maxFailures = readNumberArg(args, '--max-failures');
const includeFilter = readStringArg(args, '--include');
const excludeFilter = readStringArg(args, '--exclude');

console.log('⬆️ Uploading Takeout manifest to Scaleway...');
const { summary, reportJsonPath, reportCsvPath } = await runTakeoutUpload(
  config,
  provider,
  undefined,
  {
    dryRun,
    maxFailures,
    includeFilter,
    excludeFilter,
  },
);
console.log('✅ Upload finished');
console.log(`   Total: ${summary.total}`);
console.log(`   Processed: ${summary.processed}`);
console.log(`   Uploaded: ${summary.uploaded}`);
console.log(`   Skipped: ${summary.skipped}`);
console.log(`   Failed: ${summary.failed}`);
console.log(`   Dry run: ${summary.dryRun}`);
console.log(`   Stopped early: ${summary.stoppedEarly}`);
console.log(`   Report JSON: ${reportJsonPath}`);
console.log(`   Report CSV: ${reportCsvPath}`);

if (summary.failureLimitReached) {
  process.exitCode = 2;
}

function readStringArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function readNumberArg(args: string[], name: string): number | undefined {
  const value = readStringArg(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
