/**
 * Settings API routes — allow runtime configuration of Scaleway S3,
 * Google OAuth credentials and Immich connection without restarting the
 * server.  All secrets are encrypted at rest via AES-256-GCM.  GET
 * responses NEVER return secret values — they are masked as MASK.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { resolveScalewayEndpoint, resolveScalewaySigningRegion } from '../../providers/scaleway.js';
import { getRuntimeSettings, setRuntimeSettings } from '../../config/runtime-settings.js';

const execFileAsync = promisify(execFile);

// ── Constants ──────────────────────────────────────────────────

export const MASK = '••••••••';

// DB setting keys
export const KEY_SCALEWAY = 'scaleway_config';
export const KEY_GOOGLE = 'google_oauth_config';
export const KEY_IMMICH = 'immich_config';

// ── Stored config shapes ────────────────────────────────────────

export type ScalewayStoredConfig = {
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  prefix?: string;
  storageClass?: string;
  /** Explicit S3 endpoint URL override (omit to derive from region) */
  endpoint?: string;
  /** Use path-style requests. Defaults to true. Set false for AWS S3. */
  forcePathStyle?: boolean;
};

export type GoogleStoredConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type ImmichStoredConfig = {
  url: string;
  apiKey: string;
};

// ── Zod request schemas ─────────────────────────────────────────

const scalewayTestSchema = z.object({
  accessKey: z.string().optional(),
  secretKey: z.string().optional(),
  region: z.string().min(1),
  bucket: z.string().min(1),
  endpoint: z.string().url().optional(),
  forcePathStyle: z.boolean().optional(),
});

const scalewayPutSchema = z.object({
  accessKey: z.string().optional(),
  secretKey: z.string().optional(),
  region: z.string().min(1),
  bucket: z.string().min(1),
  prefix: z.string().optional(),
  storageClass: z.string().optional(),
  endpoint: z.string().url().optional(),
  forcePathStyle: z.boolean().optional(),
});

const googlePutSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
});

const immichTestSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().optional(),
});

const immichPutSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().optional(),
});

// ── Helpers ─────────────────────────────────────────────────────

/** Return the saved Scaleway config merged with env-var fallbacks. */
async function resolveScalewayConfig(): Promise<ScalewayStoredConfig | null> {
  const saved = await getRuntimeSettings<ScalewayStoredConfig>(KEY_SCALEWAY);
  if (saved) return saved;

  const accessKey = process.env.SCW_ACCESS_KEY?.trim();
  const secretKey = process.env.SCW_SECRET_KEY?.trim();
  const bucket = process.env.SCW_BUCKET?.trim();
  if (!accessKey || !secretKey || !bucket) return null;

  return {
    accessKey,
    secretKey,
    region: process.env.SCW_REGION?.trim() ?? 'fr-par',
    bucket,
    prefix: process.env.SCW_PREFIX?.trim() || undefined,
    storageClass: process.env.SCW_STORAGE_CLASS?.trim() || undefined,
    endpoint: process.env.SCW_ENDPOINT_URL?.trim() || undefined,
    forcePathStyle: process.env.SCW_FORCE_PATH_STYLE === 'false' ? false
      : process.env.SCW_FORCE_PATH_STYLE === 'true' ? true
      : undefined,
  };
}

/** Test an S3 connection by listing at most 1 object. */
async function testScalewayConnection(cfg: {
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const endpoint = cfg.endpoint ?? resolveScalewayEndpoint(cfg.region);
  const signingRegion = resolveScalewaySigningRegion(cfg.region);
  const client = new S3Client({
    ...(endpoint ? { endpoint } : {}),
    region: signingRegion,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    forcePathStyle: cfg.forcePathStyle ?? true,
  });
  try {
    await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.destroy();
  }
}

/** Test Immich connectivity via the server ping endpoint. */
async function testImmichConnection(cfg: {
  url: string;
  apiKey: string;
}): Promise<{ ok: boolean; serverVersion?: string; error?: string }> {
  try {
    const base = cfg.url.replace(/\/$/, '');
    const res = await fetch(`${base}/api/server/ping`, {
      headers: { 'x-api-key': cfg.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }
    const json = (await res.json().catch(() => ({}))) as { res?: string };
    return { ok: true, serverVersion: json.res };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Test Google OAuth client credentials by attempting a token exchange with a
 * deliberately invalid authorization code. Google's response distinguishes
 * "bad client" from "bad code", which lets us validate clientId/clientSecret
 * without a real OAuth round-trip:
 *  - HTTP 401 + `error: invalid_client` → clientId/clientSecret are wrong.
 *  - HTTP 400 + `error: invalid_grant`/`invalid_request` → client accepted, code rejected (= creds valid).
 *  - HTTP 400 + `error: redirect_uri_mismatch` → registered redirect URIs don't include this one.
 */
async function testGoogleConnection(cfg: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'mediatransfer-credential-validation-probe',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    // Unexpected success (Google should never accept this fake code) — treat as ok.
    if (res.ok) return { ok: true };

    const code = json.error ?? '';
    const desc = json.error_description ?? '';
    if (code === 'invalid_client') {
      return { ok: false, error: 'Invalid client ID or client secret' };
    }
    if (code === 'redirect_uri_mismatch') {
      return {
        ok: false,
        error: 'Redirect URI is not registered in Google Cloud Console for this client',
      };
    }
    if (code === 'invalid_grant' || code === 'invalid_request') {
      // Client credentials were accepted; only the bogus code/grant was rejected.
      return { ok: true };
    }
    return {
      ok: false,
      error: desc || code || `HTTP ${res.status} ${res.statusText}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Validation helpers ──────────────────────────────────────────

type ValidationIssue = { path: PropertyKey[]; message: string };

/** Build a uniform 400 response body containing both legacy `error` and an `issues` array. */
function validationError(issues: ValidationIssue[]): {
  error: string;
  issues: ValidationIssue[];
} {
  return {
    error: issues[0]?.message ?? 'Invalid request',
    issues,
  };
}

/** Convert a Zod error into our uniform issues array. */
function zodIssues(err: z.ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ path: [...i.path], message: i.message }));
}

// ── Route registration ──────────────────────────────────────────

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ── Status ───────────────────────────────────────────────────

  app.get('/settings/status', async () => {
    const [scaleway, google, immich] = await Promise.all([
      resolveScalewayConfig().catch(() => null),
      getRuntimeSettings<GoogleStoredConfig>(KEY_GOOGLE).catch(() => null),
      getRuntimeSettings<ImmichStoredConfig>(KEY_IMMICH).catch(() => null),
    ]);

    // Also check env-var fallbacks for google / immich
    const googleConfigured = !!(google
      ?? (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET));
    const immichConfigured = !!(immich
      ?? (process.env.IMMICH_URL && process.env.IMMICH_API_KEY));

    return {
      scaleway: !!scaleway,
      google: googleConfigured,
      immich: immichConfigured,
      authTokenSet: !!(process.env.API_AUTH_TOKEN?.trim()),
    };
  });

  // ── Scaleway ─────────────────────────────────────────────────

  app.get('/settings/scaleway', async () => {
    const cfg = await resolveScalewayConfig();
    if (!cfg) return { configured: false };
    return {
      configured: true,
      region: cfg.region,
      bucket: cfg.bucket,
      prefix: cfg.prefix ?? '',
      storageClass: cfg.storageClass ?? 'ONEZONE_IA',
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      accessKey: MASK,
      secretKey: MASK,
    };
  });

  app.post('/settings/scaleway/test', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = scalewayTestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        ...validationError(zodIssues(parsed.error)),
      });
    }
    const body = parsed.data;

    // Resolve credentials: use body values if provided, else fall back to saved
    const saved = await resolveScalewayConfig();
    const accessKey = body.accessKey?.trim() || saved?.accessKey;
    const secretKey = body.secretKey?.trim() || saved?.secretKey;

    const missing: ValidationIssue[] = [];
    if (!accessKey) missing.push({ path: ['accessKey'], message: 'Access key is required' });
    if (!secretKey) missing.push({ path: ['secretKey'], message: 'Secret key is required' });
    if (missing.length) {
      return reply.code(400).send({ ok: false, ...validationError(missing) });
    }

    const result = await testScalewayConnection({
      accessKey: accessKey!,
      secretKey: secretKey!,
      region: body.region,
      bucket: body.bucket,
      endpoint: body.endpoint,
      forcePathStyle: body.forcePathStyle,
    });

    if (!result.ok) {
      return reply.code(400).send(result);
    }
    return result;
  });

  app.put('/settings/scaleway', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = scalewayPutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(validationError(zodIssues(parsed.error)));
    }
    const body = parsed.data;

    // Resolve credentials — blank means keep existing
    const saved = await resolveScalewayConfig();
    const accessKey = body.accessKey?.trim() || saved?.accessKey;
    const secretKey = body.secretKey?.trim() || saved?.secretKey;

    const missing: ValidationIssue[] = [];
    if (!accessKey) missing.push({ path: ['accessKey'], message: 'Access key is required' });
    if (!secretKey) missing.push({ path: ['secretKey'], message: 'Secret key is required' });
    if (missing.length) {
      return reply.code(400).send(validationError(missing));
    }

    // Test before saving
    const test = await testScalewayConnection({
      accessKey: accessKey!,
      secretKey: secretKey!,
      region: body.region,
      bucket: body.bucket,
      endpoint: body.endpoint,
      forcePathStyle: body.forcePathStyle,
    });
    if (!test.ok) {
      return reply.code(400).send({ error: `Connection test failed: ${test.error}` });
    }

    await setRuntimeSettings<ScalewayStoredConfig>(KEY_SCALEWAY, {
      accessKey: accessKey!,
      secretKey: secretKey!,
      region: body.region,
      bucket: body.bucket,
      prefix: body.prefix,
      storageClass: body.storageClass,
      endpoint: body.endpoint,
      forcePathStyle: body.forcePathStyle,
    });

    return reply.code(204).send();
  });

  // ── Google OAuth ─────────────────────────────────────────────

  app.get('/settings/google', async () => {
    const cfg = await getRuntimeSettings<GoogleStoredConfig>(KEY_GOOGLE);
    const envClientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const envClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    const defaultRedirectUri = process.env.GOOGLE_REDIRECT_URI?.trim()
      ?? 'http://localhost:5173/auth/google/callback';

    if (cfg) {
      return {
        configured: true,
        clientId: MASK,
        clientSecret: MASK,
        redirectUri: cfg.redirectUri,
      };
    }

    if (envClientId && envClientSecret) {
      return {
        configured: true,
        clientId: MASK,
        clientSecret: MASK,
        redirectUri: defaultRedirectUri,
      };
    }

    return { configured: false, redirectUri: defaultRedirectUri };
  });

  app.post('/settings/google/test', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = googlePutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        ...validationError(zodIssues(parsed.error)),
      });
    }
    const result = await testGoogleConnection(parsed.data);
    if (!result.ok) {
      return reply.code(400).send(result);
    }
    return result;
  });

  app.put('/settings/google', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = googlePutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(validationError(zodIssues(parsed.error)));
    }
    const body = parsed.data;

    // Test before saving so invalid credentials don't get persisted (parity with Scaleway/Immich).
    const test = await testGoogleConnection(body);
    if (!test.ok) {
      return reply.code(400).send({ error: `Credential check failed: ${test.error}` });
    }

    await setRuntimeSettings<GoogleStoredConfig>(KEY_GOOGLE, {
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      redirectUri: body.redirectUri,
    });
    return reply.code(204).send();
  });

  // ── Immich ───────────────────────────────────────────────────

  app.get('/settings/immich', async () => {
    const cfg = await getRuntimeSettings<ImmichStoredConfig>(KEY_IMMICH);
    const envUrl = process.env.IMMICH_URL?.trim();
    const envKey = process.env.IMMICH_API_KEY?.trim();

    if (cfg) {
      return { configured: true, url: cfg.url, apiKey: MASK };
    }

    if (envUrl && envKey) {
      return { configured: true, url: envUrl, apiKey: MASK };
    }

    return { configured: false, url: '', apiKey: MASK };
  });

  app.post('/settings/immich/test', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = immichTestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        ...validationError(zodIssues(parsed.error)),
      });
    }
    const body = parsed.data;

    // Resolve apiKey — blank means fall back to saved config or env var
    const saved = await getRuntimeSettings<ImmichStoredConfig>(KEY_IMMICH).catch(() => null);
    const apiKey = body.apiKey?.trim() || saved?.apiKey
      || process.env.IMMICH_API_KEY?.trim();

    if (!apiKey) {
      return reply.code(400).send({
        ok: false,
        ...validationError([{ path: ['apiKey'], message: 'API key is required' }]),
      });
    }

    const result = await testImmichConnection({ url: body.url, apiKey });
    if (!result.ok) {
      return reply.code(400).send(result);
    }
    return result;
  });

  app.put('/settings/immich', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = immichPutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(validationError(zodIssues(parsed.error)));
    }
    const body = parsed.data;

    // Resolve apiKey — blank means keep existing
    const saved = await getRuntimeSettings<ImmichStoredConfig>(KEY_IMMICH);
    const apiKey = body.apiKey?.trim() || saved?.apiKey
      || process.env.IMMICH_API_KEY?.trim();

    if (!apiKey) {
      return reply.code(400).send(
        validationError([{ path: ['apiKey'], message: 'API key is required' }]),
      );
    }

    // Test before saving
    const test = await testImmichConnection({ url: body.url, apiKey });
    if (!test.ok) {
      return reply.code(400).send({ error: `Connection test failed: ${test.error}` });
    }

    await setRuntimeSettings<ImmichStoredConfig>(KEY_IMMICH, {
      url: body.url,
      apiKey,
    });

    return reply.code(204).send();
  });

  // ── Immich reachability check (no auth) ─────────────────────
  // Probes the Immich URL to see if the service is up. Distinguishes:
  //   - 2xx/3xx → server reachable                  → { ok: true, status }
  //   - 401/403 → server reachable but rejected auth → { ok: false, reason: 'unauthorized', status }
  //   - other status → server replied (still up)    → { ok: true, status }
  //   - network error → host unreachable            → { ok: false, error }
  // Useful in the setup UI to tell users whether Immich is running and (separately)
  // whether the URL is responding with an auth challenge.
  app.get('/settings/immich/reachable', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const querySchema = z.object({ url: z.string().url() });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'Invalid url query parameter' });
    }
    const base = parsed.data.url.replace(/\/$/, '');
    try {
      const res = await fetch(base, {
        method: 'GET',
        signal: AbortSignal.timeout(3_000),
        redirect: 'manual',
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: 'unauthorized' as const, status: res.status };
      }
      return { ok: true, status: res.status };
    } catch (err) {
      return reply.code(200).send({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Immich start helper (local-dev convenience) ─────────────
  // Runs `docker compose -f docker-compose.immich.yml up -d` from the repo
  // root. This is a local-dev convenience — the API server is bound to
  // localhost, so this only runs when invoked from the user's own machine.
  app.post('/settings/immich/start', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (_req, reply) => {
    const repoRoot = path.resolve(process.cwd());
    try {
      const { stdout, stderr } = await execFileAsync(
        'docker',
        ['compose', '-f', 'docker-compose.immich.yml', 'up', '-d'],
        { cwd: repoRoot, timeout: 120_000, maxBuffer: 1024 * 1024 },
      );
      return { ok: true, stdout, stderr };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ ok: false, error: message });
    }
  });
}
