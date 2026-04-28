import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSettingsRoutes, MASK, KEY_SCALEWAY, KEY_GOOGLE, KEY_IMMICH } from './settings.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config/runtime-settings.js', () => ({
  getRuntimeSettings: vi.fn(async () => null),
  setRuntimeSettings: vi.fn(async () => {}),
  deleteRuntimeSettings: vi.fn(async () => {}),
}));

const { mockS3Send } = vi.hoisted(() => ({
  mockS3Send: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ Contents: [] })),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args: unknown[]) { return mockS3Send(...args); }
    destroy() {}
  }
  class ListObjectsV2Command {
    constructor(public input: unknown) {}
  }
  return { S3Client, ListObjectsV2Command };
});

vi.mock('../../providers/scaleway.js', () => ({
  resolveScalewayEndpoint: vi.fn((r: string) => `https://s3.${r}.scw.cloud`),
  resolveScalewaySigningRegion: vi.fn((r: string) => r),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import * as runtimeSettings from '../../config/runtime-settings.js';

const mockGet = vi.mocked(runtimeSettings.getRuntimeSettings);
const mockSet = vi.mocked(runtimeSettings.setRuntimeSettings);

function buildApp() {
  const app = Fastify();
  return { app, register: () => registerSettingsRoutes(app) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /settings/status', () => {
  beforeEach(() => {
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('SCW_ACCESS_KEY', '');
    vi.stubEnv('SCW_SECRET_KEY', '');
    vi.stubEnv('SCW_BUCKET', '');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.stubEnv('IMMICH_URL', '');
    vi.stubEnv('IMMICH_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns all false when nothing configured', async () => {
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ scaleway: false, google: false, immich: false, authTokenSet: false });
  });

  it('returns scaleway: true when env vars set', async () => {
    vi.stubEnv('SCW_ACCESS_KEY', 'key');
    vi.stubEnv('SCW_SECRET_KEY', 'secret');
    vi.stubEnv('SCW_BUCKET', 'bucket');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/status' });
    expect(res.json().scaleway).toBe(true);
  });

  it('returns google: true when DB config present', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === KEY_GOOGLE) return { clientId: 'id', clientSecret: 'sec', redirectUri: 'http://localhost' };
      return null;
    });
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/status' });
    expect(res.json().google).toBe(true);
  });

  it('returns authTokenSet: true when env var set', async () => {
    vi.stubEnv('API_AUTH_TOKEN', 'supersecrettoken1234');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/status' });
    expect(res.json().authTokenSet).toBe(true);
  });

  it('returns 200 and treats service as unconfigured when getRuntimeSettings throws', async () => {
    mockGet.mockRejectedValue(new Error('Decryption failed'));
    vi.stubEnv('SCW_ACCESS_KEY', '');
    vi.stubEnv('SCW_SECRET_KEY', '');
    vi.stubEnv('SCW_BUCKET', '');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.stubEnv('IMMICH_URL', '');
    vi.stubEnv('IMMICH_API_KEY', '');
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scaleway: false, google: false, immich: false, authTokenSet: false });
  });
});

describe('GET /settings/scaleway', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns configured: false when nothing set', async () => {
    vi.stubEnv('SCW_ACCESS_KEY', '');
    vi.stubEnv('SCW_SECRET_KEY', '');
    vi.stubEnv('SCW_BUCKET', '');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/scaleway' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false });
  });

  it('masks secret fields when DB config present', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === KEY_SCALEWAY) {
        return { accessKey: 'real-key', secretKey: 'real-secret', region: 'fr-par', bucket: 'my-bucket' };
      }
      return null;
    });
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/scaleway' });
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.accessKey).toBe(MASK);
    expect(body.secretKey).toBe(MASK);
    expect(body.bucket).toBe('my-bucket');
    expect(body.region).toBe('fr-par');
  });

  it('does not expose raw credentials in response', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === KEY_SCALEWAY) {
        return { accessKey: 'ACTUAL_KEY', secretKey: 'ACTUAL_SECRET', region: 'fr-par', bucket: 'b' };
      }
      return null;
    });
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/scaleway' });
    const raw = res.body;
    expect(raw).not.toContain('ACTUAL_KEY');
    expect(raw).not.toContain('ACTUAL_SECRET');
  });
});

describe('POST /settings/scaleway/test', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns ok: true when S3 call succeeds', async () => {
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/scaleway/test',
      payload: { accessKey: 'k', secretKey: 's', region: 'fr-par', bucket: 'b' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('returns 400 when S3 call throws', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('AccessDenied'));

    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/scaleway/test',
      payload: { accessKey: 'k', secretKey: 's', region: 'fr-par', bucket: 'b' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain('AccessDenied');
  });

  it('returns 400 when no credentials provided or saved', async () => {
    mockGet.mockResolvedValue(null);
    vi.stubEnv('SCW_ACCESS_KEY', '');
    vi.stubEnv('SCW_SECRET_KEY', '');
    vi.stubEnv('SCW_BUCKET', '');
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/scaleway/test',
      payload: { region: 'fr-par', bucket: 'b' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('uses saved credentials when body omits secrets', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === KEY_SCALEWAY) {
        return { accessKey: 'saved-k', secretKey: 'saved-s', region: 'fr-par', bucket: 'b' };
      }
      return null;
    });
    // Re-mock S3 to succeed (default mock already succeeds)
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/scaleway/test',
      payload: { region: 'fr-par', bucket: 'b' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe('PUT /settings/scaleway', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('saves config and returns 204 when test passes', async () => {
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/scaleway',
      payload: {
        accessKey: 'k',
        secretKey: 's',
        region: 'fr-par',
        bucket: 'my-bucket',
        storageClass: 'ONEZONE_IA',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(mockSet).toHaveBeenCalledWith(KEY_SCALEWAY, expect.objectContaining({
      accessKey: 'k',
      secretKey: 's',
      bucket: 'my-bucket',
    }));
  });

  it('returns 400 and does not save when S3 test fails', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('Forbidden'));

    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/scaleway',
      payload: { accessKey: 'k', secretKey: 's', region: 'fr-par', bucket: 'b' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('returns 400 when no credentials available', async () => {
    mockGet.mockResolvedValue(null);
    vi.stubEnv('SCW_ACCESS_KEY', '');
    vi.stubEnv('SCW_SECRET_KEY', '');
    vi.stubEnv('SCW_BUCKET', '');
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/scaleway',
      payload: { region: 'fr-par', bucket: 'b' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('GET /settings/google', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns configured: false when nothing set', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/google' });
    expect(res.json().configured).toBe(false);
  });

  it('masks clientId and clientSecret when configured in DB', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === KEY_GOOGLE) {
        return { clientId: 'real-id', clientSecret: 'real-sec', redirectUri: 'http://localhost' };
      }
      return null;
    });
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/google' });
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.clientId).toBe(MASK);
    expect(body.clientSecret).toBe(MASK);
    expect(body.redirectUri).toBe('http://localhost');
    expect(res.body).not.toContain('real-id');
    expect(res.body).not.toContain('real-sec');
  });
});

describe('PUT /settings/google', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('saves config and returns 204 when credential test passes', async () => {
    // Google responds with `invalid_grant` for the bogus probe code → creds valid.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'invalid_grant' }),
    })));
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/google',
      payload: { clientId: 'id', clientSecret: 'sec', redirectUri: 'http://localhost:5173/auth/google/callback' },
    });
    expect(res.statusCode).toBe(204);
    expect(mockSet).toHaveBeenCalledWith(KEY_GOOGLE, {
      clientId: 'id',
      clientSecret: 'sec',
      redirectUri: 'http://localhost:5173/auth/google/callback',
    });
  });

  it('returns 400 and does not save when Google rejects the client (invalid_client)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'invalid_client' }),
    })));
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/google',
      payload: { clientId: 'bad', clientSecret: 'bad', redirectUri: 'http://localhost:5173/auth/google/callback' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
    expect(res.json().error).toMatch(/Invalid client ID or client secret/);
  });

  it('returns 400 for missing redirectUri', async () => {
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/google',
      payload: { clientId: 'id', clientSecret: 'sec' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
    // B4: Aggregated issues array
    const body = res.json();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0].path).toContain('redirectUri');
  });
});

describe('POST /settings/google/test', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('returns ok: true when Google rejects only the probe code (invalid_grant)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'invalid_grant' }),
    })));
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/google/test',
      payload: { clientId: 'id', clientSecret: 'sec', redirectUri: 'http://localhost:5173/auth/google/callback' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('returns 400 with helpful error when client credentials are bad (invalid_client)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'invalid_client' }),
    })));
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/google/test',
      payload: { clientId: 'bad', clientSecret: 'bad', redirectUri: 'http://localhost:5173/auth/google/callback' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toMatch(/Invalid client ID or client secret/);
  });

  it('returns 400 with helpful error when redirect URI is not registered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'redirect_uri_mismatch' }),
    })));
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/google/test',
      payload: { clientId: 'id', clientSecret: 'sec', redirectUri: 'http://localhost:9999/cb' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Redirect URI/);
  });

  it('returns 400 when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENETUNREACH'); }));
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/google/test',
      payload: { clientId: 'id', clientSecret: 'sec', redirectUri: 'http://localhost:5173/auth/google/callback' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('ENETUNREACH');
  });

  it('returns 400 with aggregated issues when body is invalid', async () => {
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/google/test',
      payload: { clientId: '', clientSecret: '', redirectUri: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /settings/immich', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns configured: false when nothing set', async () => {
    vi.stubEnv('IMMICH_URL', '');
    vi.stubEnv('IMMICH_API_KEY', '');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/immich' });
    expect(res.json().configured).toBe(false);
  });

  it('masks apiKey when DB config present', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === KEY_IMMICH) return { url: 'http://immich.local', apiKey: 'real-key' };
      return null;
    });
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({ method: 'GET', url: '/settings/immich' });
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.apiKey).toBe(MASK);
    expect(res.body).not.toContain('real-key');
  });
});

describe('POST /settings/immich/test', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('returns ok: true when ping succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ res: '1.120.0' }),
    })));

    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/immich/test',
      payload: { url: 'http://immich.local', apiKey: 'key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().serverVersion).toBe('1.120.0');
  });

  it('returns 400 when ping fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    })));

    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/immich/test',
      payload: { url: 'http://immich.local', apiKey: 'bad-key' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });

  it('returns 400 when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/immich/test',
      payload: { url: 'http://immich.local', apiKey: 'key' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('ECONNREFUSED');
  });

  it('uses saved apiKey when body omits apiKey', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ res: '1.120.0' }),
    })));
    mockGet.mockImplementation(async (key: string) => {
      if (key === KEY_IMMICH) return { url: 'http://immich.local', apiKey: 'saved-key' };
      return null;
    });
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/immich/test',
      payload: { url: 'http://immich.local' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('returns 400 when no apiKey in body or saved config', async () => {
    vi.stubEnv('IMMICH_API_KEY', '');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/settings/immich/test',
      payload: { url: 'http://immich.local' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });
});

describe('PUT /settings/immich', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('saves config and returns 204 when test passes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ res: '1.120.0' }),
    })));

    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/immich',
      payload: { url: 'http://immich.local', apiKey: 'valid-key' },
    });
    expect(res.statusCode).toBe(204);
    expect(mockSet).toHaveBeenCalledWith(KEY_IMMICH, { url: 'http://immich.local', apiKey: 'valid-key' });
  });

  it('returns 400 and does not save when test fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, statusText: 'Forbidden' })));

    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/immich',
      payload: { url: 'http://immich.local', apiKey: 'bad' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('returns 400 when no apiKey available', async () => {
    vi.stubEnv('IMMICH_API_KEY', '');
    mockGet.mockResolvedValue(null);
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/immich',
      payload: { url: 'http://immich.local' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('GET /settings/immich/reachable', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('returns ok: true with status when the server responds 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'GET',
      url: '/settings/immich/reachable?url=' + encodeURIComponent('http://immich.local'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 200 });
  });

  it('returns ok: false with reason: unauthorized when the server responds 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'GET',
      url: '/settings/immich/reachable?url=' + encodeURIComponent('http://immich.local'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
  });

  it('returns ok: false with reason: unauthorized when the server responds 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'GET',
      url: '/settings/immich/reachable?url=' + encodeURIComponent('http://immich.local'),
    });
    expect(res.json()).toEqual({ ok: false, reason: 'unauthorized', status: 403 });
  });

  it('returns ok: false with error message when fetch throws (host unreachable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'GET',
      url: '/settings/immich/reachable?url=' + encodeURIComponent('http://immich.local'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBeUndefined();
    expect(body.error).toContain('ECONNREFUSED');
  });

  it('still treats other non-2xx (e.g. 500) as reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'GET',
      url: '/settings/immich/reachable?url=' + encodeURIComponent('http://immich.local'),
    });
    expect(res.json()).toEqual({ ok: true, status: 500 });
  });
});

describe('PUT /settings/scaleway — field-level validation (B3/B4)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns issues identifying both missing keys when neither is provided on first save', async () => {
    mockGet.mockResolvedValue(null);
    vi.stubEnv('SCW_ACCESS_KEY', '');
    vi.stubEnv('SCW_SECRET_KEY', '');
    vi.stubEnv('SCW_BUCKET', '');
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/scaleway',
      payload: { region: 'fr-par', bucket: 'b' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(Array.isArray(body.issues)).toBe(true);
    const paths = body.issues.map((i: { path: string[] }) => i.path[0]);
    expect(paths).toContain('accessKey');
    expect(paths).toContain('secretKey');
  });

  it('identifies only the missing field when the other is provided', async () => {
    mockGet.mockResolvedValue(null);
    vi.stubEnv('SCW_ACCESS_KEY', '');
    vi.stubEnv('SCW_SECRET_KEY', '');
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/scaleway',
      payload: { accessKey: 'k', region: 'fr-par', bucket: 'b' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    const paths = body.issues.map((i: { path: string[] }) => i.path[0]);
    expect(paths).toEqual(['secretKey']);
  });

  it('returns aggregated issues array when zod schema validation fails', async () => {
    const { app, register } = buildApp();
    await register();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/scaleway',
      payload: { region: '', bucket: '', endpoint: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThanOrEqual(2);
  });
});
