import type { FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';

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
