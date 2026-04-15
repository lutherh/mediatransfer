#!/usr/bin/env npx tsx
/**
 * Build mapping from Immich DB asset paths → S3 transfers/ paths.
 * Then update Immich's PostgreSQL database so Immich reads from S3 mount.
 *
 * Strategy:
 *   1. Get all active Immich assets (originalPath, originalFileName, fileCreatedAt)
 *   2. List S3 transfers/ via rclone to build a filename→path index
 *   3. Match each asset by filename + date (YYYY/MM/DD)
 *   4. Update originalPath in asset table via docker exec psql
 *
 * The S3 volume is mounted at /usr/src/app/upload/s3transfers inside Immich.
 *
 * Usage:
 *   npx tsx scripts/remap-immich-to-s3.ts --dry-run      # preview changes
 *   npx tsx scripts/remap-immich-to-s3.ts --execute       # apply changes
 *   npx tsx scripts/remap-immich-to-s3.ts --execute --backup  # backup + apply
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const DRY_RUN = !process.argv.includes('--execute');
const BACKUP = process.argv.includes('--backup');
const FORCE_SINGLE = process.argv.includes('--force-single');

// S3 mount path inside Immich container
const S3_MOUNT = '/usr/src/app/upload/s3transfers';
// Old Immich prefix
const OLD_PREFIX = '/usr/src/app/upload/library/admin/';
const OLD_UPLOAD_PREFIX = '/usr/src/app/upload/upload/';

// DB container name
const DB_CONTAINER = 'immich_postgres';
const DB_USER = 'immich';
const DB_NAME = 'immich';

// --- Env file parser ---
function parseEnvFile(content: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.replace(/\r$/, '').trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIdx = trimmed.indexOf('=');
		if (eqIdx < 1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[key] = val;
	}
	return env;
}

// --- Run SQL via docker exec (piped via stdin to avoid quoting issues) ---
function runSQL(sql: string): string {
	const cmd = `docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A`;
	return execSync(cmd, {
		input: sql,
		maxBuffer: 100 * 1024 * 1024,
		timeout: 120_000,
		encoding: 'utf-8',
		cwd: rootDir,
	}).trim();
}

// Run larger SQL statements via stdin — throws on psql errors
function runSQLFile(sqlContent: string): string {
	const cmd = `docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -v ON_ERROR_STOP=1`;
	try {
		return execSync(cmd, {
			input: sqlContent,
			maxBuffer: 100 * 1024 * 1024,
			timeout: 300_000,
			encoding: 'utf-8',
			cwd: rootDir,
		}).trim();
	} catch (err: any) {
		const msg = err.stderr || err.stdout || err.message || 'Unknown error';
		throw new Error(`SQL batch failed: ${msg}`);
	}
}

interface Asset {
	id: string;
	originalPath: string;
	originalFileName: string;
	fileCreatedAt: string; // ISO string from DB
}

// --- Build S3 file index ---
// Uses rclone lsf via the app container (much faster than FUSE find)
function buildS3Index(): Map<string, string[]> {
	console.log('Building S3 file index via rclone (this may take a few minutes)...');

	// Read S3 creds from .env
	const mainEnv = parseEnvFile(readFileSync(join(rootDir, '.env'), 'utf-8'));
	const immichEnv = parseEnvFile(readFileSync(join(rootDir, '.env.immich'), 'utf-8'));
	const bucket = immichEnv.RCLONE_BUCKET || mainEnv.SCW_BUCKET || 'photosync';
	const region = mainEnv.SCW_REGION || 'nl-ams';
	const accessKey = mainEnv.SCW_ACCESS_KEY;
	const secretKey = mainEnv.SCW_SECRET_KEY;

	const rcloneCmd = [
		'docker', 'compose', 'exec', '-T', 'app', 'rclone', 'lsf',
		`:s3:${bucket}/transfers/`,
		'--s3-provider', 'Scaleway',
		'--s3-endpoint', `s3.${region}.scw.cloud`,
		'--s3-access-key-id', accessKey,
		'--s3-secret-access-key', secretKey,
		'--s3-region', region,
		'-R', '--files-only',
	].join(' ');

	const raw = execSync(rcloneCmd, {
		maxBuffer: 100 * 1024 * 1024,
		timeout: 600_000,
		encoding: 'utf-8',
		cwd: rootDir,
	});

	const lines = raw.split('\n').filter(l => l.length > 0);
	console.log(`  Found ${lines.length} files in S3 transfers/`);

	// Index: lowercase filename → array of relative paths
	// e.g. "img_2191.heic" → ["2024/10/15/Photos_from_2024/IMG_2191.HEIC"]
	const index = new Map<string, string[]>();
	for (const relPath of lines) {
		const lastSlash = relPath.lastIndexOf('/');
		const filename = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
		const key = filename.toLowerCase();
		const arr = index.get(key) || [];
		arr.push(relPath);
		index.set(key, arr);
	}

	return index;
}

// --- Match Immich asset to S3 path ---
function matchAssetToS3(asset: Asset, s3Index: Map<string, string[]>): string | null {
	const key = asset.originalFileName.toLowerCase();
	let candidates = s3Index.get(key);

	// If no match, try stripping _Original suffix (e.g. IMG_0501_Original.HEIC → IMG_0501.HEIC)
	if ((!candidates || candidates.length === 0) && key.includes('_original')) {
		const stripped = key.replace('_original', '');
		candidates = s3Index.get(stripped);
	}

	if (!candidates || candidates.length === 0) return null;

	// Extract date from fileCreatedAt (ISO string like "2024-10-15T12:00:00+00")
	const d = new Date(asset.fileCreatedAt);
	const year = d.getUTCFullYear().toString();
	const month = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');

	// Look for a path matching YYYY/MM/DD/*/filename
	const datePrefix = `${year}/${month}/${day}/`;
	const dateMatches = candidates.filter(c => c.startsWith(datePrefix));

	if (dateMatches.length === 1) return dateMatches[0];
	if (dateMatches.length > 1) {
		// Multiple albums on same date with same filename — pick by exact filename case match first
		const exactCase = dateMatches.find(c => c.endsWith('/' + asset.originalFileName));
		if (exactCase) return exactCase;
		return dateMatches[0]; // take first
	}

	// No date match — try year/month match (file might have date off by timezone)
	const monthPrefix = `${year}/${month}/`;
	const monthMatches = candidates.filter(c => c.startsWith(monthPrefix));
	if (monthMatches.length === 1) return monthMatches[0];

	// Try ±3 days (timezone offsets + Google Takeout date quirks)
	for (const offset of [-1, 1, -2, 2, -3, 3]) {
		const adjDate = new Date(d);
		adjDate.setUTCDate(adjDate.getUTCDate() + offset);
		const adjYear = adjDate.getUTCFullYear().toString();
		const adjMonth = String(adjDate.getUTCMonth() + 1).padStart(2, '0');
		const adjDay = String(adjDate.getUTCDate()).padStart(2, '0');
		const adjPrefix = `${adjYear}/${adjMonth}/${adjDay}/`;
		const adjMatches = candidates.filter(c => c.startsWith(adjPrefix));
		if (adjMatches.length === 1) return adjMatches[0];
	}

	// Try same year — only if single candidate in that year
	const yearPrefix = `${year}/`;
	const yearMatches = candidates.filter(c => c.startsWith(yearPrefix));
	if (yearMatches.length === 1) return yearMatches[0];

	// Only use cross-year single-candidate fallback if the filename is highly unique
	// (contains enough entropy that a collision is extremely unlikely).
	// Generic names like IMG_0512.HEIC appear across many years — never fall back for those.
	// Unless --force-single is set: then allow single-candidate match for generics too
	// (used to recover assets whose local files were deleted but exist in S3 under wrong dates).
	if (candidates.length === 1) {
		const fname = asset.originalFileName.toLowerCase();
		const isGeneric = /^(img_|vid_|movie|dsc_|dscn|screenshot_|20\d{6}_)\d/i.test(fname);
		if (!isGeneric || FORCE_SINGLE) return candidates[0];
	}

	return null; // ambiguous or no match
}

async function main() {
	console.log(`\n=== Remap Immich Assets to S3 ===`);
	console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
	console.log(`S3 mount point: ${S3_MOUNT}\n`);

	// Step 1: Build S3 index
	const s3Index = buildS3Index();

	// Step 2: Get all assets from Immich DB via docker exec psql
	console.log('Querying Immich database for assets...');
	const csvRaw = runSQL(`
		COPY (
			SELECT id, "originalPath", "originalFileName", "fileCreatedAt"
			FROM asset
			WHERE "deletedAt" IS NULL AND status = 'active'
			ORDER BY "fileCreatedAt"
		) TO STDOUT WITH (FORMAT csv, HEADER false)
	`);

	const assets: Asset[] = csvRaw.split('\n').filter(l => l.length > 0).map(line => {
		// Parse CSV: fields may be quoted if they contain commas/quotes
		const fields: string[] = [];
		let current = '';
		let inQuotes = false;
		for (let ci = 0; ci < line.length; ci++) {
			const ch = line[ci];
			if (inQuotes) {
				if (ch === '"' && line[ci + 1] === '"') {
					current += '"';
					ci++;
				} else if (ch === '"') {
					inQuotes = false;
				} else {
					current += ch;
				}
			} else if (ch === '"') {
				inQuotes = true;
			} else if (ch === ',') {
				fields.push(current);
				current = '';
			} else {
				current += ch;
			}
		}
		fields.push(current);
		if (fields.length !== 4) {
			console.warn(`Skipping malformed row (${fields.length} fields): ${line.slice(0, 120)}`);
			return null;
		}
		const [id, originalPath, originalFileName, fileCreatedAt] = fields;
		return { id, originalPath, originalFileName, fileCreatedAt };
	}).filter((a): a is Asset => a !== null);
	console.log(`Loaded ${assets.length} active assets from Immich DB\n`);

	// Step 3: Match each asset
	let matched = 0;
	let unmatched = 0;
	let alreadyMapped = 0;
	let uploadPaths = 0;
	const updates: { id: string; oldPath: string; newPath: string }[] = [];
	const unmatchedList: { id: string; path: string; filename: string; date: string }[] = [];

	for (const asset of assets) {
		// Skip if already pointing to S3 mount
		if (asset.originalPath.startsWith(S3_MOUNT)) {
			alreadyMapped++;
			continue;
		}

		// Skip upload/ paths (phone uploads — not in S3 transfers/)
		if (asset.originalPath.startsWith(OLD_UPLOAD_PREFIX)) {
			uploadPaths++;
			continue;
		}

		const s3Path = matchAssetToS3(asset, s3Index);
		if (s3Path) {
			const newPath = `${S3_MOUNT}/${s3Path}`;
			updates.push({ id: asset.id, oldPath: asset.originalPath, newPath });
			matched++;
		} else {
			unmatched++;
			if (unmatchedList.length < 20) {
				unmatchedList.push({
					id: asset.id,
					path: asset.originalPath,
					filename: asset.originalFileName,
					date: new Date(asset.fileCreatedAt).toISOString().slice(0, 10),
				});
			}
		}
	}

	console.log(`=== Matching Results ===`);
	console.log(`  Matched:        ${matched}`);
	console.log(`  Unmatched:      ${unmatched}`);
	console.log(`  Already mapped: ${alreadyMapped}`);
	console.log(`  Upload paths:   ${uploadPaths} (phone uploads, skipped)`);
	console.log(`  Total:          ${assets.length}\n`);

	if (unmatchedList.length > 0) {
		console.log('Sample unmatched assets:');
		for (const u of unmatchedList) {
			console.log(`  ${u.date} ${u.filename} — ${u.path}`);
		}
		console.log('');
	}

	// Detect collisions: multiple assets mapping to the same S3 path
	const pathCounts = new Map<string, string[]>();
	for (const u of updates) {
		const arr = pathCounts.get(u.newPath) || [];
		arr.push(u.id);
		pathCounts.set(u.newPath, arr);
	}
	const collisions = [...pathCounts.entries()].filter(([, ids]) => ids.length > 1);
	if (collisions.length > 0) {
		console.log(`\n⚠ ${collisions.length} S3 paths are targeted by multiple assets (cross-user duplicates):`);
		for (const [path, ids] of collisions.slice(0, 10)) {
			console.log(`  ${path} ← ${ids.length} assets`);
		}
		if (collisions.length > 10) console.log(`  ... and ${collisions.length - 10} more`);
		console.log('');
	}

	if (updates.length === 0) {
		console.log('Nothing to update.');
		process.exit(0);
	}

	// Show sample updates
	console.log('Sample path changes:');
	for (const u of updates.slice(0, 5)) {
		console.log(`  OLD: ${u.oldPath}`);
		console.log(`  NEW: ${u.newPath}\n`);
	}

	if (DRY_RUN) {
		console.log(`DRY RUN — no changes applied. Run with --execute to apply ${updates.length} updates.`);
		process.exit(0);
	}

	// Step 4: Backup
	if (BACKUP) {
		console.log('Creating backup of originalPath values...');
		runSQL(`CREATE TABLE IF NOT EXISTS asset_path_backup AS SELECT id, "originalPath" FROM asset WHERE 1=0`);
		runSQL(`DELETE FROM asset_path_backup`);
		runSQL(`INSERT INTO asset_path_backup (id, "originalPath") SELECT id, "originalPath" FROM asset WHERE "deletedAt" IS NULL AND status = 'active'`);
		console.log('Backup saved to asset_path_backup table');
	}

	// Step 5: Apply updates in batches via SQL piped to psql
	console.log(`\nApplying ${updates.length} path updates...`);
	const BATCH_SIZE = 500;
	let applied = 0;

	for (let i = 0; i < updates.length; i += BATCH_SIZE) {
		const batch = updates.slice(i, i + BATCH_SIZE);

		// Build SQL UPDATE statements
		const sqlLines = ['BEGIN;'];
		for (const u of batch) {
			const escapedPath = u.newPath.replace(/'/g, "''");
			const escapedId = u.id.replace(/'/g, "''");
			sqlLines.push(`UPDATE asset SET "originalPath" = '${escapedPath}' WHERE id = '${escapedId}';`);
		}
		sqlLines.push('COMMIT;');

		runSQLFile(sqlLines.join('\n'));
		applied += batch.length;
		if (applied % 5000 === 0 || applied === updates.length) {
			console.log(`  Progress: ${applied}/${updates.length}`);
		}
	}

	console.log(`\nDone! Updated ${applied} asset paths.`);

	// Step 6: Verify a sample of updated paths exist in the container
	console.log('\nVerifying sample of updated paths in Immich container...');
	const VERIFY_SAMPLE = Math.min(50, updates.length);
	const sampleIndices = new Set<number>();
	while (sampleIndices.size < VERIFY_SAMPLE) {
		sampleIndices.add(Math.floor(Math.random() * updates.length));
	}
	let verifyPass = 0;
	let verifyFail = 0;
	const failedPaths: string[] = [];
	for (const idx of sampleIndices) {
		const u = updates[idx];
		try {
			const result = execSync(
				`docker exec immich_server test -f "${u.newPath.replace(/"/g, '\\"')}" && echo OK || echo MISSING`,
				{ encoding: 'utf-8', timeout: 10_000 }
			).trim();
			if (result === 'OK') verifyPass++;
			else {
				verifyFail++;
				if (failedPaths.length < 10) failedPaths.push(u.newPath);
			}
		} catch {
			verifyFail++;
			if (failedPaths.length < 10) failedPaths.push(u.newPath);
		}
	}
	console.log(`  Verified: ${verifyPass}/${VERIFY_SAMPLE} files found in container`);
	if (verifyFail > 0) {
		console.warn(`  ⚠ ${verifyFail} files NOT found! Sample:`);
		for (const p of failedPaths) console.warn(`    ${p}`);
	}

	console.log(`\nRestart Immich to pick up changes: docker compose -f docker-compose.immich.yml restart immich-server`);
}

main().catch(e => {
	console.error('Fatal error:', e);
	process.exit(2);
});
