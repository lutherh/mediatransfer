import type { FastifyInstance } from 'fastify';
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

export { getStoredTokens, clearStoredTokens };

function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:5173/auth/google/callback';

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret, redirectUri };
}

export async function registerGoogleAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /auth/google/status
   * Returns whether the user is connected to Google.
   */
  app.get('/auth/google/status', async () => {
    const config = getGoogleConfig();
    if (!config) {
      return { configured: false, connected: false, message: 'Google OAuth2 credentials not configured in environment' };
    }

    const tokens = getStoredTokens();
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
    const config = getGoogleConfig();
    if (!config) {
      return reply.code(500).send({ error: 'Google OAuth2 credentials not configured' });
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
    const config = getGoogleConfig();
    if (!config) {
      return reply.code(500).send({ error: 'Google OAuth2 credentials not configured' });
    }

    const body = req.body as { code?: string } | undefined;
    const code = body?.code;
    if (!code) {
      return reply.code(400).send({ error: 'Missing authorization code' });
    }

    const client = createOAuth2Client(config);
    try {
      const tokens = await exchangeCode(client, code);
      setStoredTokens(tokens);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err }, 'Google OAuth code exchange failed');
      return reply.code(502).send({ error: `Google token exchange failed: ${message}` });
    }

    return { connected: true };
  });

  /**
   * POST /auth/google/disconnect
   * Clears stored tokens.
   */
  app.post('/auth/google/disconnect', async () => {
    clearStoredTokens();
    return { connected: false };
  });

  // ── Picker session routes ──────────────────────────────────────

  /**
   * POST /picker/session
   * Creates a new Google Photos Picker session. Returns the picker URI.
   */
  app.post('/picker/session', async (_req, reply) => {
    const pickerClient = createPickerClient();
    if (!pickerClient) {
      return reply.code(400).send({ error: 'Not connected to Google. Please authenticate first.' });
    }

    const session = await pickerClient.createSession();
    return {
      sessionId: session.id,
      pickerUri: session.pickerUri,
    };
  });

  /**
   * GET /picker/session/:id
   * Polls a Picker session to check if the user has finished selecting.
   */
  app.get('/picker/session/:id', async (req, reply) => {
    const sessionId = (req.params as { id: string }).id;

    const pickerClient = createPickerClient();
    if (!pickerClient) {
      return reply.code(400).send({ error: 'Not connected to Google.' });
    }

    const session = await pickerClient.getSession(sessionId);
    return {
      sessionId: session.id,
      mediaItemsSet: session.mediaItemsSet,
    };
  });

  /**
   * GET /picker/session/:id/items
   * Lists all media items from a completed Picker session.
   */
  app.get('/picker/session/:id/items', async (req, reply) => {
    const sessionId = (req.params as { id: string }).id;
    const query = req.query as { pageToken?: string; pageSize?: string };

    const pickerClient = createPickerClient();
    if (!pickerClient) {
      return reply.code(400).send({ error: 'Not connected to Google.' });
    }

    const pageSize = query.pageSize ? parseInt(query.pageSize, 10) : 100;
    const result = await pickerClient.listPickedMediaItems(sessionId, query.pageToken, pageSize);

    return {
      mediaItems: result.mediaItems,
      nextPageToken: result.nextPageToken,
    };
  });

  /**
   * DELETE /picker/session/:id
   * Deletes a Picker session.
   */
  app.delete('/picker/session/:id', async (req, reply) => {
    const sessionId = (req.params as { id: string }).id;

    const pickerClient = createPickerClient();
    if (!pickerClient) {
      return reply.code(400).send({ error: 'Not connected to Google.' });
    }

    await pickerClient.deleteSession(sessionId);
    return reply.code(204).send();
  });
}

function createPickerClient(): GooglePhotosPickerClient | null {
  const config = getGoogleConfig();
  const tokens = getStoredTokens();
  if (!config || !tokens) {
    return null;
  }

  const client = createOAuth2Client(config);
  setTokens(client, tokens);

  return new GooglePhotosPickerClient(client, tokens);
}
