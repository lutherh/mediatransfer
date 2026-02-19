import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import {
	createCredential,
	createJob,
	deleteCredential,
	deleteJob,
	getJobById,
	listCredentials,
	listJobs,
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
};

export async function createApiServer(options?: CreateApiOptions): Promise<FastifyInstance> {
	const app = Fastify({ logger: true });

	await app.register(cors, {
		origin: true,
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
			list: (provider) => listCredentials(provider),
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
