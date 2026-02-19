import * as dotenv from 'dotenv';
import { loadTakeoutConfig } from '../src/takeout/config.js';
import { runTakeoutScan } from '../src/takeout/runner.js';

dotenv.config();

try {
	const config = loadTakeoutConfig();

	console.log('🔎 Scanning and unpacking Google Takeout archives...');
	const result = await runTakeoutScan(config);

	console.log('✅ Takeout scan completed');
	console.log(`   Archives: ${result.archives.length}`);
	console.log(`   Media root: ${result.mediaRoot}`);
	console.log(`   Manifest: ${result.manifestPath}`);
	console.log(`   Entries: ${result.entryCount}`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`❌ Takeout scan failed: ${message}`);
	process.exitCode = 1;
}
