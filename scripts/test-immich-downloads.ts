#!/usr/bin/env npx tsx
/**
 * E2E test: verify whether Immich can serve full-resolution originals.
 *
 * Tests a random sample of assets via Immich API:
 *   - /api/assets/:id/original   → full-res download
 *   - /api/assets/:id/thumbnail  → thumbnail (should still work)
 *
 * Usage (from inside app container or host with network access):
 *   npx tsx scripts/test-immich-downloads.ts
 *
 * Env vars:
 *   IMMICH_URL      (default: http://localhost:2283)
 *   IMMICH_API_KEY  (reads from .env if not set)
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Read API key from env or .env file
function getApiKey(): string {
	if (process.env.IMMICH_API_KEY) return process.env.IMMICH_API_KEY;
	try {
		const envContent = readFileSync(join(rootDir, '.env'), 'utf-8');
		const match = envContent.match(/^\s*IMMICH_API_KEY\s*=\s*(.+)/m);
		if (match) return match[1].trim().replace(/^["']|["']$/g, '');
	} catch { /* ignore */ }
	throw new Error('IMMICH_API_KEY not found in env or .env file');
}

const IMMICH_URL = process.env.IMMICH_URL || 'http://localhost:2283';
const API_KEY = getApiKey();

interface AssetSample {
	id: string;
	originalPath: string;
	originalFileName: string;
	type: string;
}

interface TestResult {
	asset: AssetSample;
	thumbnail: { status: number; size: number; ok: boolean };
	original: { status: number; size: number; ok: boolean; error?: string };
}

async function getRandomAssets(count: number): Promise<AssetSample[]> {
	// Use Immich search API to get random assets
	const res = await fetch(`${IMMICH_URL}/api/search/random`, {
		method: 'POST',
		headers: {
			'x-api-key': API_KEY,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ count }),
	});

	if (!res.ok) {
		throw new Error(`Failed to get random assets: ${res.status} ${res.statusText}`);
	}

	const assets = (await res.json()) as Array<{
		id: string;
		originalPath: string;
		originalFileName: string;
		type: string;
	}>;

	return assets.map((a) => ({
		id: a.id,
		originalPath: a.originalPath,
		originalFileName: a.originalFileName,
		type: a.type,
	}));
}

async function testAsset(asset: AssetSample): Promise<TestResult> {
	const headers = { 'x-api-key': API_KEY };

	// Test thumbnail
	let thumbResult: TestResult['thumbnail'];
	try {
		const thumbRes = await fetch(
			`${IMMICH_URL}/api/assets/${asset.id}/thumbnail?size=preview`,
			{ method: 'HEAD', headers },
		);
		thumbResult = {
			status: thumbRes.status,
			size: Number(thumbRes.headers.get('content-length') || 0),
			ok: thumbRes.ok,
		};
	} catch (e) {
		thumbResult = { status: 0, size: 0, ok: false };
	}

	// Test original download
	let origResult: TestResult['original'];
	try {
		const origRes = await fetch(`${IMMICH_URL}/api/assets/${asset.id}/original`, {
			method: 'HEAD',
			headers,
		});
		origResult = {
			status: origRes.status,
			size: Number(origRes.headers.get('content-length') || 0),
			ok: origRes.ok,
		};
		if (!origRes.ok) {
			// Try GET to get error body
			const errRes = await fetch(`${IMMICH_URL}/api/assets/${asset.id}/original`, {
				headers,
			});
			const body = await errRes.text();
			origResult.error = body.slice(0, 200);
		}
	} catch (e) {
		origResult = { status: 0, size: 0, ok: false, error: String(e) };
	}

	return { asset, thumbnail: thumbResult, original: origResult };
}

async function main() {
	console.log(`\n=== Immich E2E Download Test ===`);
	console.log(`Server: ${IMMICH_URL}`);
	console.log('');

	// Test server connectivity
	try {
		const ping = await fetch(`${IMMICH_URL}/api/server/ping`, {
			headers: { 'x-api-key': API_KEY },
		});
		if (!ping.ok) throw new Error(`${ping.status}`);
		console.log('Server: ONLINE');
	} catch (e) {
		console.error(`Server: UNREACHABLE (${e})`);
		process.exit(1);
	}

	// Get sample assets
	const SAMPLE_SIZE = 10;
	console.log(`\nTesting ${SAMPLE_SIZE} random assets...\n`);
	const assets = await getRandomAssets(SAMPLE_SIZE);

	const results: TestResult[] = [];
	for (const asset of assets) {
		const result = await testAsset(asset);
		results.push(result);

		const thumbIcon = result.thumbnail.ok ? 'PASS' : 'FAIL';
		const origIcon = result.original.ok ? 'PASS' : 'FAIL';
		const sizeStr = result.original.ok
			? `${(result.original.size / 1024).toFixed(0)} KB`
			: `HTTP ${result.original.status}`;

		console.log(
			`  [${origIcon}] ${asset.originalFileName.padEnd(35)} ` +
				`thumb=${thumbIcon}  original=${sizeStr}`,
		);
	}

	// Summary
	const thumbPass = results.filter((r) => r.thumbnail.ok).length;
	const origPass = results.filter((r) => r.original.ok).length;

	console.log(`\n=== Results ===`);
	console.log(`Thumbnails: ${thumbPass}/${results.length} passed`);
	console.log(`Originals:  ${origPass}/${results.length} passed`);

	if (origPass === 0) {
		console.log(
			'\nDIAGNOSIS: All original downloads failed. ' +
				'Local files were deleted but Immich is not configured to read from S3.',
		);
		if (results[0]?.original.error) {
			console.log(`Error sample: ${results[0].original.error}`);
		}
	} else if (origPass < results.length) {
		console.log(
			`\nDIAGNOSIS: Partial failures (${origPass}/${results.length}). ` +
				'Some files may still exist locally while others were deleted.',
		);
	} else {
		console.log('\nAll originals accessible!');
	}

	// Exit with appropriate code
	process.exit(origPass === results.length ? 0 : 1);
}

main().catch((e) => {
	console.error('Fatal error:', e);
	process.exit(2);
});
