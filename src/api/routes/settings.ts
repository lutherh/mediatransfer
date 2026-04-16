/**
 * Settings API routes — allow runtime configuration of Scaleway S3,
 * Google OAuth credentials and Immich connection without restarting the
 * server.  All secrets are encrypted at rest via AES-256-GCM.  GET
 * responses NEVER return secret values — they are masked as MASK.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { resolveScalewayEndpoint, resolveScalewaySigningRegion } from '../../providers/scaleway.js';
import { getRuntimeSettings, setRuntimeSettings } from '../../config/runtime-settings.js';

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

  app.post('/settings/scaleway/test', async (req, reply) => {
    const parsed = scalewayTestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const body = parsed.data;

    // Resolve credentials: use body values if provided, else fall back to saved
    const saved = await resolveScalewayConfig();
    const accessKey = body.accessKey?.trim() || saved?.accessKey;
    const secretKey = body.secretKey?.trim() || saved?.secretKey;

    if (!accessKey || !secretKey) {
      return reply.code(400).send({ ok: false, error: 'Access key and secret key are required' });
    }

    const result = await testScalewayConnection({
      accessKey,
      secretKey,
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

  app.put('/settings/scaleway', async (req, reply) => {
    const parsed = scalewayPutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const body = parsed.data;

    // Resolve credentials — blank means keep existing
    const saved = await resolveScalewayConfig();
    const accessKey = body.accessKey?.trim() || saved?.accessKey;
    const secretKey = body.secretKey?.trim() || saved?.secretKey;

    if (!accessKey || !secretKey) {
      return reply.code(400).send({ error: 'Access key and secret key are required' });
    }

    // Test before saving
    const test = await testScalewayConnection({
      accessKey,
      secretKey,
      region: body.region,
      bucket: body.bucket,
      endpoint: body.endpoint,
      forcePathStyle: body.forcePathStyle,
    });
    if (!test.ok) {
      return reply.code(400).send({ error: `Connection test failed: ${test.error}` });
    }

    await setRuntimeSettings<ScalewayStoredConfig>(KEY_SCALEWAY, {
      accessKey,
      secretKey,
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

  app.put('/settings/google', async (req, reply) => {
    const parsed = googlePutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const body = parsed.data;
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

  app.post('/settings/immich/test', async (req, reply) => {
    const parsed = immichTestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const body = parsed.data;

    // Resolve apiKey — blank means fall back to saved config or env var
    const saved = await getRuntimeSettings<ImmichStoredConfig>(KEY_IMMICH).catch(() => null);
    const apiKey = body.apiKey?.trim() || saved?.apiKey
      || process.env.IMMICH_API_KEY?.trim();

    if (!apiKey) {
      return reply.code(400).send({ ok: false, error: 'API key is required' });
    }

    const result = await testImmichConnection({ url: body.url, apiKey });
    if (!result.ok) {
      return reply.code(400).send(result);
    }
    return result;
  });

  app.put('/settings/immich', async (req, reply) => {
    const parsed = immichPutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const body = parsed.data;

    // Resolve apiKey — blank means keep existing
    const saved = await getRuntimeSettings<ImmichStoredConfig>(KEY_IMMICH);
    const apiKey = body.apiKey?.trim() || saved?.apiKey
      || process.env.IMMICH_API_KEY?.trim();

    if (!apiKey) {
      return reply.code(400).send({ error: 'API key is required' });
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
}
