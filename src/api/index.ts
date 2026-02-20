import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import {
	createCredential,
	createJob,
	deleteCredential,
	deleteJob,
	getJobById,
	listCredentialSummaries,
	listJobs,
	listTransferLogs,
	updateJob,
} from '../db/index.js';
import { createRedisConnection } from '../jobs/connection.js';
import { enqueueBulkTransfer } from '../jobs/bulk-transfer.js';
import { createTransferQueue, type TransferJobPayload } from '../jobs/queue.js';
import {
	createScalewayProvider,
	listProviderNames,
	validateScalewayConfig,
} from '../providers/index.js';
import { registerHealthRoutes } from './health.js';
import { registerCredentialsRoutes } from './routes/credentials.js';
import { registerTransferRoutes } from './routes/transfers.js';
import { registerProviderRoutes } from './routes/providers.js';
import type { ApiServices } from './types.js';

export type CreateApiOptions = {
	services?: ApiServices;
	enableSwagger?: boolean;
	apiAuthToken?: string;
	corsAllowedOrigins?: string[];
};

export async function createApiServer(options?: CreateApiOptions): Promise<FastifyInstance> {
	const app = Fastify({
		logger: {
			redact: {
				paths: [
					'req.headers.authorization',
					'req.headers.x-api-key',
					'req.body.config',
					'body.config',
					'config.secretKey',
					'config.accessKey',
					'config.password',
					'config.token',
					'config.refreshToken',
				],
				censor: '[REDACTED]',
			},
		},
	});

	const apiAuthToken = options?.apiAuthToken?.trim();

	if (apiAuthToken) {
		app.addHook('onRequest', async (request, reply) => {
			if (request.method === 'OPTIONS') {
				return;
			}

			if (request.url.startsWith('/health')) {
				return;
			}

			const headerToken = parseAuthToken(request.headers.authorization, request.headers['x-api-key']);
			if (!headerToken || !safeEqual(headerToken, apiAuthToken)) {
				return reply.status(401).send({
					error: {
						code: 'UNAUTHORIZED',
						message: 'Missing or invalid API token',
					},
					requestId: request.id,
				});
			}
		});
	}

	app.setErrorHandler((error, request, reply) => {
		if (error instanceof ZodError) {
			return reply.status(400).send({
				error: {
					code: 'VALIDATION_ERROR',
					message: 'Request validation failed',
					details: error.issues.map((issue) => ({
						path: issue.path.join('.'),
						message: issue.message,
					})),
				},
				requestId: request.id,
			});
		}

		const statusCode =
			typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
			(error as { statusCode: number }).statusCode >= 400 &&
			(error as { statusCode: number }).statusCode < 600
				? (error as { statusCode: number }).statusCode
				: 500;

		if (statusCode >= 500) {
			request.log.error({ err: error }, 'Unhandled API error');
		}

		const errorMessage = error instanceof Error ? error.message : String(error);

		return reply.status(statusCode).send({
			error: {
				code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
				message: statusCode >= 500 ? 'Internal server error' : errorMessage,
			},
			requestId: request.id,
		});
	});

	await app.register(cors, {
		origin: buildCorsOriginHandler(options?.corsAllowedOrigins ?? []),
	});

	if (options?.enableSwagger) {
		await app.register(swagger, {
			openapi: {
				info: {
					title: 'MediaTransfer API',
					version: '0.1.0',
				},
			},
		});
	}

	const runtime: { services: ApiServices; dispose?: () => Promise<void> } = options?.services
		? { services: options.services }
		: createDefaultServices();

	await registerHealthRoutes(app);
	await registerCredentialsRoutes(app, runtime.services.credentials);
	await registerTransferRoutes(app, runtime.services.jobs, runtime.services.queue);
	await registerProviderRoutes(app, runtime.services.providers);

	app.addHook('onClose', async () => {
		await runtime.dispose?.();
	});

	return app;
}

function createDefaultServices(): { services: ApiServices; dispose: () => Promise<void> } {
	const redis = createRedisConnection();
	const queue = createTransferQueue(redis);

	const services: ApiServices = {
		credentials: {
			create: (input) => createCredential(input),
			list: (provider) => listCredentialSummaries(provider),
			delete: (id) => deleteCredential(id),
		},
		jobs: {
			create: (input) =>
				createJob({
					sourceProvider: input.sourceProvider,
					destProvider: input.destProvider,
					sourceConfig: (input.sourceConfig ?? undefined) as any,
					destConfig: (input.destConfig ?? undefined) as any,
					keys: input.keys,
				}),
			list: (filter) => listJobs(filter),
			get: (id) => getJobById(id),
			update: (id, input) => updateJob(id, input),
			delete: (id) => deleteJob(id),
			listLogs: (id) => listTransferLogs(id),
		},
		providers: {
			listNames: () => {
				const names = new Set([...listProviderNames(), 'scaleway']);
				return Array.from(names).sort((a, b) => a.localeCompare(b));
			},
			testConnection: async (name, config) => {
				if (name !== 'scaleway') {
					return {
						ok: false,
						message: `Connection test not implemented for provider "${name}"`,
					};
				}

				const provider = createScalewayProvider(
					validateScalewayConfig({ provider: 'scaleway', ...config }),
				);
				await provider.list({ maxResults: 1 });
				return { ok: true, message: 'Connection successful' };
			},
			listObjects: async (name, config, opts) => {
				if (name !== 'scaleway') {
					throw new Error(`Listing objects not implemented for provider "${name}"`);
				}

				const provider = createScalewayProvider(
					validateScalewayConfig({ provider: 'scaleway', ...config }),
				);
				return provider.list({ prefix: opts?.prefix, maxResults: opts?.maxResults });
			},
		},
		queue: {
			enqueueBulk: (input) => enqueueBulkTransfer(queue as any, input),
		},
	};

	return {
		services,
		dispose: async () => {
			await queue.close();
			await redis.quit();
		},
	};
}

export type { TransferJobPayload };

function parseAuthToken(
	authorizationHeader: string | undefined,
	xApiKeyHeader: string | string[] | undefined,
): string | undefined {
	if (typeof xApiKeyHeader === 'string' && xApiKeyHeader.length > 0) {
		return xApiKeyHeader;
	}

	if (Array.isArray(xApiKeyHeader) && xApiKeyHeader.length > 0 && xApiKeyHeader[0]) {
		return xApiKeyHeader[0];
	}

	if (!authorizationHeader) {
		return undefined;
	}

	const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
	return match?.[1];
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.length !== rightBuffer.length) {
		return false;
	}

	return timingSafeEqual(leftBuffer, rightBuffer);
}

function buildCorsOriginHandler(allowedOrigins: string[]) {
	const normalized = allowedOrigins
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);

	if (normalized.length === 0) {
		return false;
	}

	const allowed = new Set(normalized);
	return (origin: string | undefined, callback: (err: Error | null, allow: boolean) => void): void => {
		if (!origin) {
			callback(null, false);
			return;
		}

		callback(null, allowed.has(origin));
	};
}
