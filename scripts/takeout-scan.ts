import * as dotenv from 'dotenv';
import { loadTakeoutConfig } from '../src/takeout/config.js';
import { runTakeoutScan, type ScanProgressEvent } from '../src/takeout/runner.js';

dotenv.config();

function emitProgress(event: ScanProgressEvent): void {
	console.log(`[SCAN_PROGRESS]${JSON.stringify(event)}`);
}

try {
	const config = loadTakeoutConfig();

	console.log('🔎 Scanning and unpacking Google Takeout archives...');
	const result = await runTakeoutScan(config, undefined, emitProgress);

	console.log('✅ Takeout scan completed');
	console.log(`   Archives: ${result.archives.length}`);
	console.log(`   Media root: ${result.mediaRoot}`);
	console.log(`   Manifest: ${result.manifestPath}`);
	console.log(`   Entries: ${result.entryCount}`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error('');
	console.error('❌ Takeout scan failed:');
	console.error('');
	for (const line of message.split('\n')) {
		console.error(`   ${line}`);
	}
	console.error('');
	process.exitCode = 1;
}
