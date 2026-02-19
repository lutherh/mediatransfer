import * as dotenv from 'dotenv';
import { loadTakeoutConfig } from '../src/takeout/config.js';
import { runTakeoutVerify } from '../src/takeout/runner.js';
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

console.log('🔍 Verifying manifest objects in Scaleway...');
const summary = await runTakeoutVerify(config, provider);

console.log('✅ Verify complete');
console.log(`   Total: ${summary.total}`);
console.log(`   Present: ${summary.present}`);
console.log(`   Missing: ${summary.missing}`);

if (summary.missingKeys.length > 0) {
  console.log('   Missing keys:');
  for (const key of summary.missingKeys) {
    console.log(`   - ${key}`);
  }
  process.exitCode = 1;
}
