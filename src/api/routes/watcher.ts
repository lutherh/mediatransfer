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
/** Prevents concurrent /start requests from spawning multiple watchers. */
let watcherStarting = false;

// ─── Route registration ────────────────────────────────────────────────────

export async function registerWatcherRoutes(app: FastifyInstance, env: Env): Promise<void> {
  /** POST /takeout/api/watcher/start — start the download watcher if not already running */
  app.post('/takeout/api/watcher/start', async (_req, reply) => {
    if (watcherHandle !== null || watcherStarting) {
      return reply.code(200).send({ already_running: true });
    }

    watcherStarting = true;
    try {
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

      const handle = watchDownloadsFolder(
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
      watcherHandle = handle;

      // Clean up handle reference when watcher exits.
      // Only clear if the handle is still the current one (guards against
      // a stop + start race where a new watcher replaces this one before
      // the done promise resolves).
      handle.done.then(() => {
        if (watcherHandle === handle) {
          watcherHandle = null;
          watcherStartedAt = null;
          latestWatcherState = null;
        }
      }).catch(() => {
        if (watcherHandle === handle) {
          watcherHandle = null;
          watcherStartedAt = null;
          latestWatcherState = null;
        }
      });
    } finally {
      watcherStarting = false;
    }

    return reply.code(200).send({ started: true });
  });

  /** POST /takeout/api/watcher/stop — stop the watcher if running */
  app.post('/takeout/api/watcher/stop', async (_req, reply) => {
    if (watcherHandle === null) {
      return reply.code(200).send({ not_running: true });
    }

    // stop() is synchronous; setting null here happens before any Promise
    // callbacks in the done chain, so the identity check in those callbacks
    // correctly sees watcherHandle !== handle and does nothing.
    watcherHandle.stop();
    watcherHandle = null;
    watcherStartedAt = null;
    latestWatcherState = null;

    return reply.code(200).send({ stopped: true });
  });

  /** GET /takeout/api/watcher/status — return current watcher state */
  app.get('/takeout/api/watcher/status', async (_req, reply) => {
    const running = watcherHandle !== null;
    const paused = watcherHandle?.isPaused ?? false;

    return reply.code(200).send({
      running,
      paused,
      startedAt: watcherStartedAt,
      latestState: latestWatcherState,
    });
  });
}
