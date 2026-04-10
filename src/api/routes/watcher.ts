import type { FastifyInstance } from 'fastify';
import type { Env } from '../../config/env.js';
import { loadTakeoutConfig } from '../../takeout/config.js';
import {
  watchDownloadsFolder,
  type WatcherHandle,
  type WatcherState,
} from '../../takeout/watch-downloads.js';
import { validateScalewayConfig, ScalewayProvider } from '../../providers/scaleway.js';

// ─── Module-level watcher state ────────────────────────────────────────────

let watcherHandle: WatcherHandle | null = null;
let latestWatcherState: WatcherState | null = null;
let watcherStartedAt: string | null = null;

// ─── Route registration ────────────────────────────────────────────────────

export async function registerWatcherRoutes(app: FastifyInstance, env: Env): Promise<void> {
  /** POST /takeout/api/watcher/start — start the download watcher if not already running */
  app.post('/takeout/api/watcher/start', async (_req, reply) => {
    if (watcherHandle !== null) {
      return reply.code(200).send({ already_running: true });
    }

    const config = loadTakeoutConfig(env);
    const scalewayConfig = validateScalewayConfig({
      provider: 'scaleway',
      region: env.SCW_REGION,
      bucket: env.SCW_BUCKET,
      accessKey: env.SCW_ACCESS_KEY,
      secretKey: env.SCW_SECRET_KEY,
      prefix: env.SCW_PREFIX,
    });
    const provider = new ScalewayProvider(scalewayConfig);

    watcherStartedAt = new Date().toISOString();
    latestWatcherState = null;

    watcherHandle = watchDownloadsFolder(
      config,
      provider,
      {
        uploadConcurrency: config.uploadConcurrency,
      },
      {
        downloadsDir: config.inputDir,
        onPollCycle(state) {
          latestWatcherState = state;
        },
      },
    );

    // Clean up handle reference when watcher exits
    watcherHandle.done.then(() => {
      watcherHandle = null;
      watcherStartedAt = null;
    }).catch(() => {
      watcherHandle = null;
      watcherStartedAt = null;
    });

    return reply.code(200).send({ started: true });
  });

  /** POST /takeout/api/watcher/stop — stop the watcher if running */
  app.post('/takeout/api/watcher/stop', async (_req, reply) => {
    if (watcherHandle === null) {
      return reply.code(200).send({ not_running: true });
    }

    watcherHandle.stop();
    watcherHandle = null;
    watcherStartedAt = null;

    return reply.code(200).send({ stopped: true });
  });

  /** GET /takeout/api/watcher/status — return current watcher state */
  app.get('/takeout/api/watcher/status', async (_req, reply) => {
    const running = watcherHandle !== null;
    const paused = running ? watcherHandle!.isPaused : false;

    return reply.code(200).send({
      running,
      paused,
      startedAt: watcherStartedAt,
      latestState: latestWatcherState,
    });
  });
}
