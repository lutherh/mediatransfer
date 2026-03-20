import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createOAuth2Client,
  exchangeCode,
  getAuthUrlForScopes,
  setTokens,
  isTokenExpired,
  GOOGLE_PHOTOS_PICKER_SCOPE,
  GOOGLE_PHOTOS_READONLY_SCOPE,
} from '../../providers/google-photos-auth.js';
import { GooglePhotosPickerClient } from '../../providers/google-photos-picker.js';
import {
  getStoredTokens,
  setStoredTokens,
  clearStoredTokens,
} from './google-token-store.js';
import type { Env } from '../../config/env.js';
import { apiError } from '../errors.js';

export { getStoredTokens, clearStoredTokens };

const pickerSessionParamsSchema = z.object({
  id: z.string().min(1),
});

const pickerItemsQuerySchema = z.object({
  pageToken: z.string().min(1).optional(),
  pageSize: z.string().optional(),
});

function getGoogleConfig(env: Env) {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const redirectUri = env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret, redirectUri };
}

export async function registerGoogleAuthRoutes(app: FastifyInstance, env: Env): Promise<void> {
  /**
   * GET /auth/google/status
   * Returns whether the user is connected to Google.
   */
  app.get('/auth/google/status', async () => {
    const config = getGoogleConfig(env);
    if (!config) {
      return { configured: false, connected: false, message: 'Google OAuth2 credentials not configured in environment' };
    }

    const tokens = await getStoredTokens();
    if (!tokens) {
      return { configured: true, connected: false };
    }

    return {
      configured: true,
      connected: true,
      expired: isTokenExpired(tokens),
      hasRefreshToken: Boolean(tokens.refreshToken),
    };
  });

  /**
   * GET /auth/google/url
   * Returns the OAuth2 authorization URL for the user to visit.
   */
  app.get('/auth/google/url', async (_req, reply) => {
    const config = getGoogleConfig(env);
    if (!config) {
      return reply.code(500).send(apiError('GOOGLE_CONFIG_MISSING', 'Google OAuth2 credentials not configured'));
    }

    const client = createOAuth2Client(config);
    const scopes = [GOOGLE_PHOTOS_READONLY_SCOPE, GOOGLE_PHOTOS_PICKER_SCOPE];
    const url = getAuthUrlForScopes(client, scopes);

    return { url };
  });

  /**
   * POST /auth/google/callback
   * Exchanges the authorization code for tokens.
   * Body: { code: string }
   */
  app.post('/auth/google/callback', async (req, reply) => {
    const config = getGoogleConfig(env);
    if (!config) {
      return reply.code(500).send(apiError('GOOGLE_CONFIG_MISSING', 'Google OAuth2 credentials not configured'));
    }

    const body = req.body as { code?: string } | undefined;
    const code = body?.code;
    if (!code) {
      return reply.code(400).send(apiError('MISSING_CODE', 'Missing authorization code'));
    }

    const client = createOAuth2Client(config);
    try {
      const tokens = await exchangeCode(client, code);
      await setStoredTokens(tokens);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err }, 'Google OAuth code exchange failed');
      return reply.code(502).send(apiError('GOOGLE_TOKEN_EXCHANGE_FAILED', `Google token exchange failed: ${message}`));
    }

    return { connected: true };
  });

  /**
   * POST /auth/google/disconnect
   * Clears stored tokens.
   */
  app.post('/auth/google/disconnect', async () => {
    await clearStoredTokens();
    return { connected: false };
  });

  // ── Picker session routes ──────────────────────────────────────

  /**
   * POST /picker/session
   * Creates a new Google Photos Picker session. Returns the picker URI.
   */
  app.post('/picker/session', async (_req, reply) => {
    const pickerClient = await createPickerClient(env);
    if (!pickerClient) {
      return reply.code(400).send(apiError('GOOGLE_NOT_CONNECTED', 'Not connected to Google. Please authenticate first.'));
    }

    try {
      const session = await pickerClient.createSession();
      return {
        sessionId: session.id,
        pickerUri: session.pickerUri,
      };
    } catch (err) {
      return handlePickerError(err, reply);
    }
  });

  /**
   * GET /picker/session/:id
   * Polls a Picker session to check if the user has finished selecting.
   */
  app.get('/picker/session/:id', async (req, reply) => {
    const { id: sessionId } = pickerSessionParamsSchema.parse(req.params);

    const pickerClient = await createPickerClient(env);
    if (!pickerClient) {
      return reply.code(400).send(apiError('GOOGLE_NOT_CONNECTED', 'Not connected to Google.'));
    }

    try {
      const session = await pickerClient.getSession(sessionId);
      return {
        sessionId: session.id,
        mediaItemsSet: session.mediaItemsSet,
      };
    } catch (err) {
      return handlePickerError(err, reply);
    }
  });

  /**
   * GET /picker/session/:id/items
   * Lists all media items from a completed Picker session.
   */
  app.get('/picker/session/:id/items', async (req, reply) => {
    const { id: sessionId } = pickerSessionParamsSchema.parse(req.params);
    const query = pickerItemsQuerySchema.parse(req.query);

    const pickerClient = await createPickerClient(env);
    if (!pickerClient) {
      return reply.code(400).send(apiError('GOOGLE_NOT_CONNECTED', 'Not connected to Google.'));
    }

    const pageSize = Math.min(Math.max(parseInt(query.pageSize ?? '', 10) || 100, 1), 100);
    try {
      const result = await pickerClient.listPickedMediaItems(sessionId, query.pageToken, pageSize);
      return {
        mediaItems: result.mediaItems,
        nextPageToken: result.nextPageToken,
      };
    } catch (err) {
      return handlePickerError(err, reply);
    }
  });

  /**
   * DELETE /picker/session/:id
   * Deletes a Picker session.
   */
  app.delete('/picker/session/:id', async (req, reply) => {
    const { id: sessionId } = pickerSessionParamsSchema.parse(req.params);

    const pickerClient = await createPickerClient(env);
    if (!pickerClient) {
      return reply.code(400).send(apiError('GOOGLE_NOT_CONNECTED', 'Not connected to Google.'));
    }

    try {
      await pickerClient.deleteSession(sessionId);
      return reply.code(204).send();
    } catch (err) {
      return handlePickerError(err, reply);
    }
  });
}

function isInvalidGrantError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message === 'invalid_grant' || err.message.includes('Token has been expired or revoked');
  }
  return false;
}

async function handlePickerError(err: unknown, reply: FastifyReply) {
  if (isInvalidGrantError(err)) {
    await clearStoredTokens();
    return reply.code(401).send(
      apiError('GOOGLE_TOKEN_EXPIRED', 'Google authentication has expired or been revoked. Please reconnect your Google account.'),
    );
  }
  throw err;
}

async function createPickerClient(env: Env): Promise<GooglePhotosPickerClient | null> {
  const config = getGoogleConfig(env);
  const tokens = await getStoredTokens();
  if (!config || !tokens) {
    return null;
  }

  const client = createOAuth2Client(config);
  setTokens(client, tokens);

  return new GooglePhotosPickerClient(client, tokens);
}
