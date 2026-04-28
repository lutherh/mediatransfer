import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Client } from 'pg';
import type { CatalogService } from '../../catalog/scaleway-catalog.js';
import { apiError } from '../errors.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type MatchConfidence = 'exact-date' | 'fuzzy-date' | 'single-candidate' | 'ambiguous';

export type OrphanMatch = {
	assetId: string;
	/** Current path in Immich DB (library/admin/...) */
	immichPath: string;
	filename: string;
	fileCreatedAt: string;
	/** Best matching S3 path (relative, under s3transfers/) */
	s3Path: string | null;
	/** All candidate S3 paths for this filename */
	s3Candidates: string[];
	confidence: MatchConfidence;
	/** Whether the file exists locally */
	existsLocally: boolean;
};

export type OrphanScanResult = {
	orphans: OrphanMatch[];
	totalAssets: number;
	totalOrphans: number;
	matchedCount: number;
	unmatchedCount: number;
	localCount: number;
};

// ── Helpers ────────────────────────────────────────────────────────────────

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

async function getImmichDbClient(rootDir: string): Promise<Client> {
	let immichEnv: Record<string, string> = {};
	try {
		const raw = await readFile(join(rootDir, '.env.immich'), 'utf-8');
		immichEnv = parseEnvFile(raw);
	} catch { /* defaults */ }

	return new Client({
		host: immichEnv.DB_HOSTNAME || 'immich_postgres',
		port: Number(immichEnv.DB_PORT) || 5432,
		user: immichEnv.DB_USERNAME || 'immich',
		password: immichEnv.DB_PASSWORD || 'immich',
		database: immichEnv.DB_DATABASE_NAME || 'immich',
		connectionTimeoutMillis: 5000,
		statement_timeout: 30000,
	});
}

const S3_MOUNT = '/usr/src/app/upload/s3transfers';

// ── Matching logic (ported from remap-immich-to-s3.ts) ─────────────────

function matchAssetToS3(
	filename: string,
	fileCreatedAt: string,
	s3Index: Map<string, string[]>,
): { path: string | null; candidates: string[]; confidence: MatchConfidence } {
	const key = filename.toLowerCase();
	let candidates = s3Index.get(key);

	if ((!candidates || candidates.length === 0) && key.includes('_original')) {
		const stripped = key.replace('_original', '');
		candidates = s3Index.get(stripped);
	}

	if (!candidates || candidates.length === 0) {
		return { path: null, candidates: [], confidence: 'ambiguous' };
	}

	const d = new Date(fileCreatedAt);
	const year = d.getUTCFullYear().toString();
	const month = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');

	// Exact date
	const datePrefix = `${year}/${month}/${day}/`;
	const dateMatches = candidates.filter(c => c.startsWith(datePrefix));
	if (dateMatches.length === 1) return { path: dateMatches[0], candidates, confidence: 'exact-date' };
	if (dateMatches.length > 1) {
		const exactCase = dateMatches.find(c => c.endsWith('/' + filename));
		return { path: exactCase ?? dateMatches[0], candidates, confidence: 'exact-date' };
	}

	// Year/month
	const monthPrefix = `${year}/${month}/`;
	const monthMatches = candidates.filter(c => c.startsWith(monthPrefix));
	if (monthMatches.length === 1) return { path: monthMatches[0], candidates, confidence: 'fuzzy-date' };

	// ±3 days
	for (const offset of [-1, 1, -2, 2, -3, 3]) {
		const adj = new Date(d);
		adj.setUTCDate(adj.getUTCDate() + offset);
		const adjPrefix = `${adj.getUTCFullYear()}/${String(adj.getUTCMonth() + 1).padStart(2, '0')}/${String(adj.getUTCDate()).padStart(2, '0')}/`;
		const adjMatches = candidates.filter(c => c.startsWith(adjPrefix));
		if (adjMatches.length === 1) return { path: adjMatches[0], candidates, confidence: 'fuzzy-date' };
	}

	// Same year single
	const yearPrefix = `${year}/`;
	const yearMatches = candidates.filter(c => c.startsWith(yearPrefix));
	if (yearMatches.length === 1) return { path: yearMatches[0], candidates, confidence: 'fuzzy-date' };

	// Cross-year single candidate
	if (candidates.length === 1) {
		return { path: candidates[0], candidates, confidence: 'single-candidate' };
	}

	return { path: null, candidates, confidence: 'ambiguous' };
}

// ── Build S3 index from catalog service ────────────────────────────────

async function buildS3Index(catalog: CatalogService): Promise<Map<string, string[]>> {
	const items = await catalog.listAll();
	const index = new Map<string, string[]>();
	for (const item of items) {
		const lastSlash = item.key.lastIndexOf('/');
		const filename = lastSlash >= 0 ? item.key.slice(lastSlash + 1) : item.key;
		const key = filename.toLowerCase();
		const arr = index.get(key) ?? [];
		arr.push(item.key);
		index.set(key, arr);
	}
	return index;
}

// ── Route registration ─────────────────────────────────────────────────

const remapBodySchema = z.object({
	remaps: z.array(z.object({
		assetId: z.string().uuid(),
		newPath: z.string().min(1).max(1024),
	})).min(1).max(500),
	backup: z.boolean().default(true),
});

const resolveBodySchema = z.object({
	assetId: z.string().uuid(),
	s3Path: z.string().min(1).max(1024),
});

export async function registerImmichCompareRoutes(
	app: FastifyInstance,
	catalog: CatalogService | undefined,
): Promise<void> {
	const rootDir = process.cwd();

	// ── Scan for orphan Immich assets and find S3 matches ──────────────
	app.get('/catalog/api/immich/orphans', async (_req, reply) => {
		if (!catalog) {
			return reply.status(503).send(apiError('CATALOG_UNAVAILABLE', 'Catalog not configured'));
		}

		let client: Client | undefined;
		try {
			// Build S3 index
			const s3Index = await buildS3Index(catalog);

			// Query Immich DB
			client = await getImmichDbClient(rootDir);
			await client.connect();
			const result = await client.query(`
				SELECT id, "originalPath", "originalFileName", "fileCreatedAt"
				FROM asset
				WHERE "deletedAt" IS NULL AND status = 'active'
				ORDER BY "fileCreatedAt" DESC
			`);

			const totalAssets = result.rows.length;
			const orphans: OrphanMatch[] = [];
			let localCount = 0;

			for (const row of result.rows) {
				const { id, originalPath, originalFileName, fileCreatedAt } = row as {
					id: string;
					originalPath: string;
					originalFileName: string;
					fileCreatedAt: Date;
				};

				// Skip assets already pointing to S3
				if (originalPath.startsWith(S3_MOUNT)) continue;
				// Skip phone uploads
				if (originalPath.startsWith('/usr/src/app/upload/upload/')) continue;

				const { path: s3Path, candidates, confidence } = matchAssetToS3(
					originalFileName,
					fileCreatedAt.toISOString(),
					s3Index,
				);

				orphans.push({
					assetId: id,
					immichPath: originalPath,
					filename: originalFileName,
					fileCreatedAt: fileCreatedAt.toISOString(),
					s3Path,
					s3Candidates: candidates,
					confidence,
					existsLocally: false, // We don't check local filesystem from the backend container
				});
			}

			const matchedCount = orphans.filter(o => o.s3Path !== null).length;
			const unmatchedCount = orphans.length - matchedCount;

			const scanResult: OrphanScanResult = {
				orphans,
				totalAssets,
				totalOrphans: orphans.length,
				matchedCount,
				unmatchedCount,
				localCount,
			};

			return scanResult;
		} catch (err) {
			console.error('[immich-compare] orphan scan error:', err);
			const message = err instanceof Error ? err.message : 'Failed to scan orphans';
			return reply.status(500).send(apiError('SCAN_FAILED', message));
		} finally {
			if (client) await client.end().catch(() => {});
		}
	});

	// ── Apply remaps: update Immich DB paths ───────────────────────────
	app.post('/catalog/api/immich/remap', async (req, reply) => {
		const { remaps, backup } = remapBodySchema.parse(req.body);

		let client: Client | undefined;
		try {
			client = await getImmichDbClient(rootDir);
			await client.connect();

			// Backup current paths
			if (backup) {
				await client.query(`
					CREATE TABLE IF NOT EXISTS asset_path_backup (
						id TEXT PRIMARY KEY,
						"originalPath" TEXT NOT NULL
					)
				`);
				// Insert or update backup for the assets being remapped
				for (const remap of remaps) {
					await client.query(`
						INSERT INTO asset_path_backup (id, "originalPath")
						SELECT id, "originalPath" FROM asset WHERE id = $1
						ON CONFLICT (id) DO UPDATE SET "originalPath" = EXCLUDED."originalPath"
					`, [remap.assetId]);
				}
			}

			// Apply remaps in a transaction
			await client.query('BEGIN');
			let applied = 0;
			for (const remap of remaps) {
				const result = await client.query(
					`UPDATE asset SET "originalPath" = $1 WHERE id = $2`,
					[remap.newPath, remap.assetId],
				);
				if (result.rowCount && result.rowCount > 0) applied++;
			}
			await client.query('COMMIT');

			return { applied, total: remaps.length, backedUp: backup };
		} catch (err) {
			if (client) await client.query('ROLLBACK').catch(() => {});
			console.error('[immich-compare] remap error:', err);
			const message = err instanceof Error ? err.message : 'Failed to apply remaps';
			return reply.status(500).send(apiError('REMAP_FAILED', message));
		} finally {
			if (client) await client.end().catch(() => {});
		}
	});

	// ── Manually resolve: pick a specific S3 path for an asset ─────────
	app.post('/catalog/api/immich/resolve', async (req, reply) => {
		const { assetId, s3Path } = resolveBodySchema.parse(req.body);
		const newPath = `${S3_MOUNT}/${s3Path}`;

		let client: Client | undefined;
		try {
			client = await getImmichDbClient(rootDir);
			await client.connect();

			// Backup
			await client.query(`
				CREATE TABLE IF NOT EXISTS asset_path_backup (
					id TEXT PRIMARY KEY,
					"originalPath" TEXT NOT NULL
				)
			`);
			await client.query(`
				INSERT INTO asset_path_backup (id, "originalPath")
				SELECT id, "originalPath" FROM asset WHERE id = $1
				ON CONFLICT (id) DO UPDATE SET "originalPath" = EXCLUDED."originalPath"
			`, [assetId]);

			const result = await client.query(
				`UPDATE asset SET "originalPath" = $1 WHERE id = $2`,
				[newPath, assetId],
			);

			return {
				updated: (result.rowCount ?? 0) > 0,
				assetId,
				newPath,
			};
		} catch (err) {
			console.error('[immich-compare] resolve error:', err);
			const message = err instanceof Error ? err.message : 'Failed to resolve asset';
			return reply.status(500).send(apiError('RESOLVE_FAILED', message));
		} finally {
			if (client) await client.end().catch(() => {});
		}
	});
}
