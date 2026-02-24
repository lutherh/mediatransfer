import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { ZodError } from 'zod';
import {
	createCredential,
	createJob,
	createTransferLog,
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
import {
	createTransferDeadLetterQueue,
	createTransferQueue,
	createTransferWorker,
	type TransferJobPayload,
} from '../jobs/queue.js';
import {
	createOAuth2Client,
	createScalewayProvider,
	getValidAccessToken,
	GooglePhotosPickerClient,
	isTokenExpired,
	setTokens,
	listProviderNames,
	validateScalewayConfig,
} from '../providers/index.js';
import { TransferStatus } from '../generated/prisma/client.js';
import { ScalewayCatalogService } from '../catalog/scaleway-catalog.js';
import { registerHealthRoutes } from './health.js';
import { registerCredentialsRoutes } from './routes/credentials.js';
import { registerTransferRoutes } from './routes/transfers.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerTakeoutRoutes } from './routes/takeout.js';
import { registerGoogleAuthRoutes } from './routes/google-auth.js';
import { registerCloudUsageRoutes } from './routes/cloud-usage.js';
import { getStoredTokens, setStoredTokens } from './routes/google-token-store.js';
import type { ApiServices } from './types.js';

export type CreateApiOptions = {
	services?: ApiServices;
	enableSwagger?: boolean;
	apiAuthToken?: string;
	corsAllowedOrigins?: string[];
};

export async function createApiServer(options?: CreateApiOptions): Promise<FastifyInstance> {
	const app = Fastify({
		routerOptions: {
			maxParamLength: 1000,
		},
		logger: {
			redact: {
				paths: [
					'req.headers.authorization',
					'req.headers.x-api-key',
					'req.query.apiToken',
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

			const queryToken = request.url.startsWith('/catalog')
				? extractApiTokenFromUrl(request.url)
				: undefined;
			const headerToken = parseAuthToken(request.headers.authorization, request.headers['x-api-key'], queryToken);
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
	await registerCatalogRoutes(app, runtime.services.catalog);
	await registerCloudUsageRoutes(app, runtime.services.cloudUsage);
	await registerTakeoutRoutes(app);
	await registerGoogleAuthRoutes(app);

	app.addHook('onClose', async () => {
		await runtime.dispose?.();
	});

	return app;
}

function createDefaultServices(): { services: ApiServices; dispose: () => Promise<void> } {
	const redis = createRedisConnection();
	const queue = createTransferQueue(redis);
	const deadLetterQueue = createTransferDeadLetterQueue(redis);
	const worker = createTransferWorker(
		redis,
		async (payload) => processQueuedTransfer(payload),
		{ connection: redis as any, deadLetterQueue },
	);

	worker.on('error', (err) => {
		console.error('[transfer-worker] Worker error', err);
	});

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
		catalog: createCatalogServiceFromEnv(),
		cloudUsage: createCloudUsageServiceFromEnv(),
	};

	return {
		services,
		dispose: async () => {
			await worker.close();
			await deadLetterQueue.close();
			await queue.close();
			await redis.quit();
		},
	};
}

async function processQueuedTransfer(payload: TransferJobPayload): Promise<void> {
	const total = payload.totalKeys ?? payload.keys.length;
	const startIndex = Math.max(0, Math.min(payload.startIndex ?? 0, total));
	const initialProgress = total === 0 ? 1 : startIndex / total;

	const shouldStop = async (): Promise<boolean> => {
		const latest = await getJobById(payload.transferJobId);
		return latest?.status === TransferStatus.CANCELLED;
	};

	await updateJob(payload.transferJobId, {
		status: TransferStatus.IN_PROGRESS,
		progress: initialProgress,
		errorMessage: null,
		startedAt: new Date(),
		completedAt: null,
	});

	await createTransferLog({
		jobId: payload.transferJobId,
		message: `Transfer worker started (${total} item${total === 1 ? '' : 's'})`,
		meta: {
			totalItems: total,
			startIndex,
		},
	});

	try {
		if (payload.sourceProvider !== 'google-photos' || payload.destProvider !== 'scaleway') {
			throw new Error(`Unsupported transfer route: ${payload.sourceProvider} -> ${payload.destProvider}`);
		}

		if (total === 0) {
			await updateJob(payload.transferJobId, {
				status: TransferStatus.COMPLETED,
				progress: 1,
				completedAt: new Date(),
				errorMessage: null,
			});
			await createTransferLog({
				jobId: payload.transferJobId,
				message: 'Transfer completed (no items)',
			});
			return;
		}

		for (let index = 0; index < payload.keys.length; index += 1) {
			if (await shouldStop()) {
				await createTransferLog({
					jobId: payload.transferJobId,
					message: 'Transfer paused by user',
				});
				return;
			}

			const mediaItemId = payload.keys[index];
			let result: { destinationKey: string; filename?: string; skipped: boolean } | null = null;
			let successfulAttempt = 0;

			for (let attempt = 1; attempt <= ITEM_RETRY_MAX_ATTEMPTS; attempt += 1) {
				await createTransferLog({
					jobId: payload.transferJobId,
					message: `Processing item ${mediaItemId} (${attempt}/${ITEM_RETRY_MAX_ATTEMPTS})`,
					meta: {
						mediaItemId,
						attempt,
						maxAttempts: ITEM_RETRY_MAX_ATTEMPTS,
						status: 'IN_PROGRESS',
					},
				});

				try {
					result = await transferPickedMediaItemToScaleway(payload, mediaItemId);
					successfulAttempt = attempt;
					break;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const canRetry =
						attempt < ITEM_RETRY_MAX_ATTEMPTS &&
						isRetryableTransferItemError(error);

					if (!canRetry) {
						await createTransferLog({
							jobId: payload.transferJobId,
							level: 'ERROR',
							message: `Item failed ${mediaItemId}: ${message}`,
							meta: {
								mediaItemId,
								attempt,
								maxAttempts: ITEM_RETRY_MAX_ATTEMPTS,
								status: 'FAILED',
								error: message,
							},
						});
						throw error;
					}

					const delayMs = computeItemRetryDelay(attempt);
					await createTransferLog({
						jobId: payload.transferJobId,
						level: 'WARN',
						message: `Retrying item ${mediaItemId} (attempt ${attempt + 1}/${ITEM_RETRY_MAX_ATTEMPTS})`,
						meta: {
							mediaItemId,
							attempt,
							maxAttempts: ITEM_RETRY_MAX_ATTEMPTS,
							delayMs,
							error: message,
							status: 'RETRYING',
						},
					});

					await delay(delayMs);
				}
			}

			if (!result) {
				throw new Error(`Transfer item ${mediaItemId} did not produce a result`);
			}

			if (await shouldStop()) {
				await createTransferLog({
					jobId: payload.transferJobId,
					message: 'Transfer paused by user',
				});
				return;
			}

			const progress = total === 0 ? 1 : (startIndex + index + 1) / total;

			await updateJob(payload.transferJobId, {
				progress,
				status: progress >= 1 ? TransferStatus.COMPLETED : TransferStatus.IN_PROGRESS,
				completedAt: progress >= 1 ? new Date() : null,
				errorMessage: null,
			});

			await createTransferLog({
				jobId: payload.transferJobId,
				message: result.skipped
					? `Skipped existing ${result.filename ?? mediaItemId}`
					: `Uploaded ${result.filename ?? mediaItemId}`,
				meta: {
					mediaItemId,
					destinationKey: result.destinationKey,
					skipped: result.skipped,
					progress,
					itemProgressPercent: 100,
					completed: startIndex + index + 1,
					total,
					attempts: successfulAttempt,
					status: result.skipped ? 'SKIPPED' : 'COMPLETED',
				},
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await updateJob(payload.transferJobId, {
			status: TransferStatus.FAILED,
			errorMessage: message,
			completedAt: new Date(),
		});
		await createTransferLog({
			jobId: payload.transferJobId,
			level: 'ERROR',
			message: `Transfer failed: ${message}`,
			meta: {
				status: 'FAILED',
				error: message,
			},
		});
		throw error;
	}
}

const ITEM_RETRY_MAX_ATTEMPTS = 3;

function isRetryableTransferItemError(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return (
		message.includes('timeout') ||
		message.includes('network') ||
		message.includes('econnreset') ||
		message.includes('rate limit') ||
		message.includes('temporar') ||
		message.includes('throttle') ||
		message.includes('fetch failed') ||
		message.includes('503')
	);
}

function computeItemRetryDelay(attempt: number): number {
	const baseDelayMs = 500;
	const maxDelayMs = 5000;
	const exponential = Math.min(baseDelayMs * (2 ** (attempt - 1)), maxDelayMs);
	const jitter = Math.floor(Math.random() * 120);
	return Math.min(exponential + jitter, maxDelayMs);
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function transferPickedMediaItemToScaleway(
	payload: TransferJobPayload,
	mediaItemId: string,
): Promise<{ destinationKey: string; filename?: string; skipped: boolean }> {
	const tokens = getStoredTokens();
	if (!tokens) {
		throw new Error('Google session expired: not connected. Please reconnect and retry.');
	}

	const googleConfig = getGoogleOAuthConfigFromEnv();
	const sourceConfig = payload.sourceConfig as Record<string, unknown> | undefined;
	const sessionId = sourceConfig?.sessionId;
	if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
		throw new Error('Missing sourceConfig.sessionId for Google Picker transfer.');
	}

	const oauthClient = createOAuth2Client(googleConfig);
	setTokens(oauthClient, tokens);

	let activeTokens = tokens;
	if (isTokenExpired(activeTokens)) {
		activeTokens = await getValidAccessToken(oauthClient);
		setStoredTokens(activeTokens);
	}

	const pickerClient = new GooglePhotosPickerClient(oauthClient, activeTokens);
	const media = await withTimeout(
		findPickedMediaItemInSession(pickerClient, sessionId, mediaItemId),
		30_000,
		`find picked media item ${mediaItemId}`,
	);

	if (!media.baseUrl) {
		throw new Error(`Picked media item ${mediaItemId} is missing baseUrl.`);
	}

	const scaleway = createScalewayProvider(getScalewayConfigFromEnv());
	const destinationKey = buildDestinationKey(
		media.filename ?? `${mediaItemId}.bin`,
		mediaItemId,
		media.createTime,
	);
	const existing = await withTimeout(
		scaleway.list({ prefix: destinationKey, maxResults: 1 }),
		20_000,
		`check existing object ${destinationKey}`,
	);
	if (existing.some((item) => item.key === destinationKey)) {
		return { destinationKey, filename: media.filename, skipped: true };
	}

	const downloadUrl = media.mimeType?.startsWith('video/')
		? `${media.baseUrl}=dv`
		: `${media.baseUrl}=d`;

	let response = await fetchWithTimeout(downloadUrl, {
		headers: { Authorization: `Bearer ${activeTokens.accessToken}` },
	}, 60_000, `download media ${mediaItemId}`);

	if (response.status === 401 || response.status === 403) {
		activeTokens = await getValidAccessToken(oauthClient);
		setStoredTokens(activeTokens);
		response = await fetchWithTimeout(downloadUrl, {
			headers: { Authorization: `Bearer ${activeTokens.accessToken}` },
		}, 60_000, `download media ${mediaItemId} (token refresh)`);
	}

	if (!response.ok || !response.body) {
		const body = await response.text();
		throw new Error(`Failed to download picked media ${mediaItemId}: ${response.status} ${body}`);
	}

	await withTimeout(
		scaleway.upload(
			destinationKey,
			Readable.fromWeb(response.body as any),
			media.mimeType,
		),
		10 * 60_000,
		`upload ${destinationKey}`,
	);

	return { destinationKey, filename: media.filename, skipped: false };
}

async function findPickedMediaItemInSession(
	pickerClient: GooglePhotosPickerClient,
	sessionId: string,
	mediaItemId: string,
): Promise<{ id: string; mimeType?: string; filename?: string; createTime?: string; baseUrl?: string }> {
	let pageToken: string | undefined;

	do {
		const page = await withTimeout(
			pickerClient.listPickedMediaItems(sessionId, pageToken, 100),
			30_000,
			`list picker items for ${sessionId}`,
		);
		const found = page.mediaItems.find((item) => item.id === mediaItemId);
		if (found) {
			return found;
		}
		pageToken = page.nextPageToken;
	} while (pageToken);

	throw new Error(`Picked media item ${mediaItemId} not found in picker session ${sessionId}.`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeoutId: NodeJS.Timeout | undefined;

	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error(`${label} timed out after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

function getGoogleOAuthConfigFromEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
	const clientId = process.env.GOOGLE_CLIENT_ID;
	const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
	const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:5173/auth/google/callback';

	if (!clientId || !clientSecret) {
		throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in environment.');
	}

	return { clientId, clientSecret, redirectUri };
}

function getScalewayConfigFromEnv() {
	return validateScalewayConfig({
		provider: 'scaleway',
		region: process.env.SCW_REGION,
		bucket: process.env.SCW_BUCKET,
		accessKey: process.env.SCW_ACCESS_KEY,
		secretKey: process.env.SCW_SECRET_KEY,
		prefix: process.env.SCW_PREFIX,
	});
}

function buildDestinationKey(filename: string, itemId: string, createTime?: string): string {
	const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
	const date = createDatePath(createTime);
	return `${date}/${itemId}-${sanitized}`;
}

function createDatePath(createTime?: string): string {
	const date = createTime ? new Date(createTime) : new Date();
	if (Number.isNaN(date.getTime())) {
		const now = new Date();
		return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}`;
	}

	return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
}

export type { TransferJobPayload };

function parseAuthToken(
	authorizationHeader: string | undefined,
	xApiKeyHeader: string | string[] | undefined,
	queryApiToken?: string,
): string | undefined {
	if (queryApiToken && queryApiToken.length > 0) {
		return queryApiToken;
	}

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

function extractApiTokenFromUrl(url: string): string | undefined {
	const queryStart = url.indexOf('?');
	if (queryStart < 0) {
		return undefined;
	}

	const params = new URLSearchParams(url.slice(queryStart + 1));
	const value = params.get('apiToken');
	return value && value.length > 0 ? value : undefined;
}

function createCatalogServiceFromEnv(): ScalewayCatalogService | undefined {
	const region = process.env.SCW_REGION;
	const bucket = process.env.SCW_BUCKET;
	const accessKey = process.env.SCW_ACCESS_KEY;
	const secretKey = process.env.SCW_SECRET_KEY;
	const prefix = process.env.SCW_PREFIX;

	if (!region || !bucket || !accessKey || !secretKey) {
		return undefined;
	}

	return new ScalewayCatalogService({
		region,
		bucket,
		accessKey,
		secretKey,
		prefix,
	});
}

function createCloudUsageServiceFromEnv() {
	const region = process.env.SCW_REGION;
	const bucket = process.env.SCW_BUCKET;
	const accessKey = process.env.SCW_ACCESS_KEY;
	const secretKey = process.env.SCW_SECRET_KEY;
	const prefix = process.env.SCW_PREFIX;

	if (!region || !bucket || !accessKey || !secretKey) {
		return undefined;
	}

	const provider = createScalewayProvider(
		validateScalewayConfig({
			provider: 'scaleway',
			region,
			bucket,
			accessKey,
			secretKey,
			prefix,
		}),
	);

	type UsageCache = {
		measuredAtMs: number;
		totalObjects: number;
		totalBytes: number;
	};

	let cache: UsageCache | null = null;
	const cacheTtlMs = 30_000;

	return {
		async getSummary() {
			const now = Date.now();
			if (cache && now - cache.measuredAtMs < cacheTtlMs) {
				return {
					provider: 'scaleway' as const,
					bucket,
					region,
					prefix,
					totalObjects: cache.totalObjects,
					totalBytes: cache.totalBytes,
					measuredAt: new Date(cache.measuredAtMs).toISOString(),
				};
			}

			const items = await provider.list();
			const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
			const measuredAtMs = Date.now();

			cache = {
				measuredAtMs,
				totalObjects: items.length,
				totalBytes,
			};

			return {
				provider: 'scaleway' as const,
				bucket,
				region,
				prefix,
				totalObjects: items.length,
				totalBytes,
				measuredAt: new Date(measuredAtMs).toISOString(),
			};
		},
	};
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);

	// Pad both to the same length to avoid leaking the expected token
	// length through timing differences.
	const maxLen = Math.max(leftBuffer.length, rightBuffer.length);
	const paddedLeft = Buffer.alloc(maxLen);
	const paddedRight = Buffer.alloc(maxLen);
	paddedLeft.set(leftBuffer);
	paddedRight.set(rightBuffer);

	const match = timingSafeEqual(paddedLeft, paddedRight);
	return match && leftBuffer.length === rightBuffer.length;
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
