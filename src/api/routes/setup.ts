/**
 * Setup bootstrap-status endpoint — unauthenticated, returns whether the
 * application needs first-run configuration.  Always returns HTTP 200 so
 * the frontend can always read it even before auth is configured.
 */
import type { FastifyInstance } from 'fastify';
import { getPrismaClient } from '../../db/client.js';
import { getRuntimeSettings } from '../../config/runtime-settings.js';
import type { ScalewayStoredConfig, GoogleStoredConfig, ImmichStoredConfig } from './settings.js';
import { KEY_SCALEWAY, KEY_GOOGLE, KEY_IMMICH } from './settings.js';

async function isDbConnected(): Promise<boolean> {
  try {
    const prisma = getPrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /setup/bootstrap-status
   *
   * Returns whether the app needs first-run configuration.
   * No auth required — exempt from API_AUTH_TOKEN check.
   */
  app.get('/setup/bootstrap-status', async () => {
    const authTokenSet = !!(process.env.API_AUTH_TOKEN?.trim());

    const [scaleway, google, immich, dbConnected] = await Promise.all([
      getRuntimeSettings<ScalewayStoredConfig>(KEY_SCALEWAY).catch(() => null),
      getRuntimeSettings<GoogleStoredConfig>(KEY_GOOGLE).catch(() => null),
      getRuntimeSettings<ImmichStoredConfig>(KEY_IMMICH).catch(() => null),
      isDbConnected(),
    ]);

    const scalewayConfigured = !!(scaleway
      ?? (process.env.SCW_ACCESS_KEY && process.env.SCW_SECRET_KEY && process.env.SCW_BUCKET));
    const googleConfigured = !!(google
      ?? (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET));
    const immichConfigured = !!(immich
      ?? (process.env.IMMICH_URL && process.env.IMMICH_API_KEY));

    const anyIntegrationConfigured = scalewayConfigured || googleConfigured || immichConfigured;
    const needsSetup = !authTokenSet || !anyIntegrationConfigured;

    return {
      needsSetup,
      authTokenSet,
      dbConnected,
      configured: {
        scaleway: scalewayConfigured,
        google: googleConfigured,
        immich: immichConfigured,
      },
    };
  });
}
