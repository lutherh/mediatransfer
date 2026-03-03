import * as dotenv from 'dotenv';
import { ScalewayCatalogService } from '../src/catalog/scaleway-catalog.js';

dotenv.config();

const dryRun = !process.argv.includes('--apply');

const region = process.env.SCW_REGION;
const bucket = process.env.SCW_BUCKET;
const accessKey = process.env.SCW_ACCESS_KEY;
const secretKey = process.env.SCW_SECRET_KEY;
const prefix = process.env.SCW_PREFIX;

if (!region || !bucket || !accessKey || !secretKey) {
	console.error('❌ Missing required env vars: SCW_REGION, SCW_BUCKET, SCW_ACCESS_KEY, SCW_SECRET_KEY');
	process.exitCode = 1;
} else {
	try {
		const catalog = new ScalewayCatalogService({ region, bucket, accessKey, secretKey, prefix });

		console.log(dryRun ? '🔍 DRY RUN — scanning for duplicates...' : '🗑️  Scanning and removing duplicates...');
		console.log('');

		const result = await catalog.deduplicateObjects({ dryRun });

		if (result.groups.length === 0) {
			console.log('✅ No duplicates found — bucket is clean.');
		} else {
			console.log(`Found ${result.groups.length} duplicate group(s):`);
			console.log('');

			for (const group of result.groups) {
				const wastedMB = ((group.duplicateKeys.length * group.size) / (1024 * 1024)).toFixed(2);
				console.log(`  📦 ${group.keepKey}  (keep)`);
				for (const dup of group.duplicateKeys) {
					console.log(`     ❌ ${dup}`);
				}
				console.log(`     → ${group.duplicateKeys.length} duplicate(s), ${wastedMB} MB wasted`);
				console.log('');
			}

			const totalMB = (result.bytesFreed / (1024 * 1024)).toFixed(2);
			console.log(`Total: ${result.totalDuplicates} duplicate(s), ${totalMB} MB ${dryRun ? 'reclaimable' : 'freed'}`);

			if (dryRun) {
				console.log('');
				console.log('ℹ️  Run with --apply to actually delete duplicates.');
			} else if (result.deleteResult) {
				console.log('');
				console.log(`✅ Deleted: ${result.deleteResult.deleted.length}`);
				if (result.deleteResult.failed.length > 0) {
					console.log(`⚠️  Failed: ${result.deleteResult.failed.length}`);
					for (const f of result.deleteResult.failed) {
						console.log(`   ${f.key}: ${f.error}`);
					}
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('');
		console.error('❌ Deduplication failed:');
		console.error('');
		for (const line of message.split('\n')) {
			console.error(`   ${line}`);
		}
		console.error('');
		process.exitCode = 1;
	}
}
