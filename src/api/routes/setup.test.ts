import Fastify from 'fastify';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { registerSetupRoutes } from './setup.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config/runtime-settings.js', () => ({
  getRuntimeSettings: vi.fn(async () => null),
}));

vi.mock('../../db/client.js', () => ({
  getPrismaClient: vi.fn(() => ({
    $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
  })),
}));

import * as runtimeSettings from '../../config/runtime-settings.js';
import * as dbClient from '../../db/client.js';

const mockGet = vi.mocked(runtimeSettings.getRuntimeSettings);
const mockGetPrisma = vi.mocked(dbClient.getPrismaClient);

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = Fastify();
  return { app, register: () => registerSetupRoutes(app) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /setup/bootstrap-status', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns 200 without any auth token (unauthenticated)', async () => {
    vi.stubEnv('API_AUTH_TOKEN', '');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/setup/bootstrap-status' });
    expect(res.statusCode).toBe(200);
  });

  it('returns needsSetup: true when auth token not set', async () => {
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('SCW_ACCESS_KEY', '');
    vi.stubEnv('SCW_SECRET_KEY', '');
    vi.stubEnv('SCW_BUCKET', '');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.stubEnv('IMMICH_URL', '');
    vi.stubEnv('IMMICH_API_KEY', '');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/setup/bootstrap-status' });
    const body = res.json();
    expect(body.needsSetup).toBe(true);
    expect(body.authTokenSet).toBe(false);
  });

  it('returns needsSetup: true when auth set but no integrations configured', async () => {
    vi.stubEnv('API_AUTH_TOKEN', 'supersecrettoken1234');
    vi.stubEnv('SCW_ACCESS_KEY', '');
    vi.stubEnv('SCW_SECRET_KEY', '');
    vi.stubEnv('SCW_BUCKET', '');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.stubEnv('IMMICH_URL', '');
    vi.stubEnv('IMMICH_API_KEY', '');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/setup/bootstrap-status' });
    const body = res.json();
    expect(body.needsSetup).toBe(true);
    expect(body.authTokenSet).toBe(true);
  });

  it('returns needsSetup: false when auth + at least one integration configured', async () => {
    vi.stubEnv('API_AUTH_TOKEN', 'supersecrettoken1234');
    vi.stubEnv('SCW_ACCESS_KEY', 'k');
    vi.stubEnv('SCW_SECRET_KEY', 's');
    vi.stubEnv('SCW_BUCKET', 'b');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.stubEnv('IMMICH_URL', '');
    vi.stubEnv('IMMICH_API_KEY', '');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/setup/bootstrap-status' });
    const body = res.json();
    expect(body.needsSetup).toBe(false);
    expect(body.configured.scaleway).toBe(true);
  });

  it('returns dbConnected: true when DB query succeeds', async () => {
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/setup/bootstrap-status' });
    expect(res.json().dbConnected).toBe(true);
  });

  it('returns dbConnected: false when DB query throws', async () => {
    mockGetPrisma.mockReturnValue({
      $queryRaw: vi.fn(async () => { throw new Error('connection refused'); }),
    } as never);
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/setup/bootstrap-status' });
    expect(res.json().dbConnected).toBe(false);
  });

  it('response body never contains secret values', async () => {
    vi.stubEnv('API_AUTH_TOKEN', 'my-super-token');
    vi.stubEnv('SCW_ACCESS_KEY', 'MY_ACCESS_KEY');
    vi.stubEnv('SCW_SECRET_KEY', 'MY_SECRET_KEY');
    vi.stubEnv('SCW_BUCKET', 'my-bucket');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/setup/bootstrap-status' });
    expect(res.body).not.toContain('my-super-token');
    expect(res.body).not.toContain('MY_ACCESS_KEY');
    expect(res.body).not.toContain('MY_SECRET_KEY');
  });
});
