import type { FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Known pipeline tasks and the scripts/commands they execute.
 * Each entry maps a task ID to the command that runs it.
 */
const TASK_COMMANDS: Record<string, { cmd: string; args: string[]; label: string }> = {
	's3-upload': {
		cmd: 'bash',
		args: ['scripts/sync-immich-to-s3.sh', '--execute'],
		label: 'S3 Upload (sync-immich-to-s3)',
	},
	'local-cleanup': {
		cmd: 'bash',
		args: ['scripts/sync-immich-to-s3.sh', '--cleanup'],
		label: 'Local Cleanup (verified delete)',
	},
};

type RunningJob = {
	id: string;
	taskId: string;
	label: string;
	status: 'running' | 'completed' | 'failed';
	startedAt: string;
	completedAt: string | null;
	output: string[];
	exitCode: number | null;
	process: ChildProcess | null;
};

/** In-memory store of recent job runs (kept small — last 20). */
const recentJobs: RunningJob[] = [];
const MAX_RECENT = 20;

/**
 * Parse a simple KEY=VALUE .env file into a Record. Handles quoting and \r.
 */
function parseEnvFile(content: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.replace(/\r$/, '').trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIdx = trimmed.indexOf('=');
		if (eqIdx < 1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		// Strip surrounding quotes
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[key] = val;
	}
	return env;
}

/**
 * Generate a manifest of all active Immich asset paths by querying the
 * Immich PostgreSQL database directly. The cleanup script reads this file
 * to know which local files are safe to delete.
 *
 * Reads Immich DB credentials from .env.immich (DB_PASSWORD, DB_USERNAME, etc.)
 * with sensible defaults matching Immich's own docker-compose.
 */
async function generateImmichManifest(rootDir: string): Promise<{ count: number }> {
	// Read credentials from .env.immich (same vars Immich's docker-compose uses)
	let immichEnv: Record<string, string> = {};
	try {
		const raw = await readFile(join(rootDir, '.env.immich'), 'utf-8');
		immichEnv = parseEnvFile(raw);
	} catch {
		// Fall back to defaults if .env.immich isn't readable
	}

	const client = new Client({
		host: immichEnv.DB_HOSTNAME || 'immich_postgres',
		port: Number(immichEnv.DB_PORT) || 5432,
		user: immichEnv.DB_USERNAME || 'immich',
		password: immichEnv.DB_PASSWORD || 'immich',
		database: immichEnv.DB_DATABASE_NAME || 'immich',
		connectionTimeoutMillis: 5000,
		statement_timeout: 30000, // 30s query timeout
	});

	try {
		await client.connect();
		const result = await client.query(
			`SELECT "originalPath" FROM asset WHERE "deletedAt" IS NULL AND status = 'active'`
		);
		const paths = result.rows
			.map((r: { originalPath: string }) => r.originalPath)
			.filter((p: string) => p && p.length > 0);

		if (paths.length < 100) {
			throw new Error(
				`Immich returned only ${paths.length} assets — expected thousands. Aborting to prevent accidental data loss.`
			);
		}

		const manifestPath = join(rootDir, 'data', 'immich-asset-paths.txt');
		await writeFile(manifestPath, paths.join('\n') + '\n', 'utf-8');
		return { count: paths.length };
	} finally {
		await client.end();
	}
}

function addJob(job: RunningJob): void {
	recentJobs.unshift(job);
	// Only evict completed/failed jobs — never discard a running process
	while (recentJobs.length > MAX_RECENT) {
		let evicted = false;
		for (let i = recentJobs.length - 1; i >= 0; i--) {
			if (recentJobs[i].status !== 'running') {
				recentJobs.splice(i, 1);
				evicted = true;
				break;
			}
		}
		if (!evicted) break; // all running — don't evict
	}
}

function findJob(id: string): RunningJob | undefined {
	return recentJobs.find((j) => j.id === id);
}

function sanitizeJob(job: RunningJob) {
	return {
		id: job.id,
		taskId: job.taskId,
		label: job.label,
		status: job.status,
		startedAt: job.startedAt,
		completedAt: job.completedAt,
		output: job.output,
		exitCode: job.exitCode,
	};
}

export async function registerPipelineRoutes(app: FastifyInstance): Promise<void> {
	const rootDir = process.cwd();

	/** POST /pipeline/run/:taskId — trigger a pipeline task */
	app.post<{ Params: { taskId: string } }>('/pipeline/run/:taskId', async (req, reply) => {
		const { taskId } = req.params;
		const taskDef = TASK_COMMANDS[taskId];
		if (!taskDef) {
			return reply.code(400).send({ error: `Unknown task: ${taskId}` });
		}

		// Prevent running the same task concurrently
		const alreadyRunning = recentJobs.find((j) => j.taskId === taskId && j.status === 'running');
		if (alreadyRunning) {
			return reply.code(409).send({
				error: `Task "${taskId}" is already running`,
				jobId: alreadyRunning.id,
			});
		}

		const jobId = `${taskId}-${Date.now()}`;
		const job: RunningJob = {
			id: jobId,
			taskId,
			label: taskDef.label,
			status: 'running',
			startedAt: new Date().toISOString(),
			completedAt: null,
			output: [],
			exitCode: null,
			process: null,
		};
		addJob(job);

		// For cleanup tasks, generate the Immich asset manifest first
		if (taskId === 'local-cleanup') {
			try {
				job.output.push('Generating Immich asset manifest from database...');
				const { count } = await generateImmichManifest(rootDir);
				job.output.push(`Manifest generated — ${count} active assets. Starting cleanup script.`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				job.output.push(`[error] Failed to generate Immich manifest: ${msg}`);
				job.status = 'failed';
				job.completedAt = new Date().toISOString();
				return reply.code(202).send({ jobId, taskId, status: 'failed' });
			}
		}

		// Spawn the process
		const child = spawn(taskDef.cmd, taskDef.args, {
			cwd: rootDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env },
		});
		job.process = child;

		child.stdout.on('data', (data: Buffer) => {
			const lines = data.toString().split('\n').filter(Boolean);
			for (const line of lines) {
				job.output.push(line);
				// Keep output bounded
				if (job.output.length > 500) job.output.shift();
			}
		});

		child.stderr.on('data', (data: Buffer) => {
			const lines = data.toString().split('\n').filter(Boolean);
			for (const line of lines) {
				job.output.push(`[stderr] ${line}`);
				if (job.output.length > 500) job.output.shift();
			}
		});

		child.on('close', (code) => {
			if (job.status !== 'running') return; // already handled by 'error'
			job.exitCode = code;
			job.status = code === 0 ? 'completed' : 'failed';
			// Translate common platform errors into user-friendly messages
			if (job.status === 'failed') {
				const combined = job.output.join('\n');
				if (combined.includes('execvpe') || combined.includes('No such file or directory')) {
					job.output.push('bash not found — these scripts require a Linux environment (run on your server, not Windows dev)');
				}
			}
			job.completedAt = new Date().toISOString();
			job.process = null;
		});

		child.on('error', (err) => {
			const friendly =
				err.message.includes('ENOENT') || err.message.includes('No such file')
					? 'bash not found — these scripts require a Linux environment (run on your server, not Windows dev)'
					: err.message;
			job.output.push(`[error] ${friendly}`);
			job.status = 'failed';
			job.completedAt = new Date().toISOString();
			job.process = null;
		});

		return reply.code(202).send({ jobId, taskId, status: 'running' });
	});

	/** GET /pipeline/jobs/:jobId — poll job status */
	app.get<{ Params: { jobId: string } }>('/pipeline/jobs/:jobId', async (req, reply) => {
		const job = findJob(req.params.jobId);
		if (!job) {
			return reply.code(404).send({ error: 'Job not found' });
		}
		return sanitizeJob(job);
	});

	/** GET /pipeline/jobs — list recent jobs */
	app.get('/pipeline/jobs', async () => {
		return recentJobs.map(sanitizeJob);
	});

	/** GET /pipeline/tasks — list available tasks */
	app.get('/pipeline/tasks', async () => {
		return Object.entries(TASK_COMMANDS).map(([id, def]) => ({
			id,
			label: def.label,
			running: recentJobs.some((j) => j.taskId === id && j.status === 'running'),
		}));
	});
}
