import { OAuth2Client, type Credentials } from 'google-auth-library';

// ── Scopes ──────────────────────────────────────────────────────

/** Read-only access to the user's Google Photos library. */
export const GOOGLE_PHOTOS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata';

/** Append-only access for creating new media/items via Library API. */
export const GOOGLE_PHOTOS_APPENDONLY_SCOPE =
  'https://www.googleapis.com/auth/photoslibrary.appendonly';

/** Scope required for Google Photos Picker API sessions and selected media listing. */
export const GOOGLE_PHOTOS_PICKER_SCOPE =
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

/** All scopes required by the Google Photos provider. */
export const GOOGLE_PHOTOS_SCOPES = [GOOGLE_PHOTOS_READONLY_SCOPE];

// ── Config ──────────────────────────────────────────────────────

export type GoogleAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

// ── Token types ─────────────────────────────────────────────────

export type GoogleTokens = {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
};

// ── Auth helpers ────────────────────────────────────────────────

/**
 * Create a configured OAuth2Client.
 */
export function createOAuth2Client(config: GoogleAuthConfig): OAuth2Client {
  return new OAuth2Client(
    config.clientId,
    config.clientSecret,
    config.redirectUri,
  );
}

/**
 * Generate the URL the user must visit to grant access.
 */
export function getAuthUrl(client: OAuth2Client): string {
  return getAuthUrlForScopes(client, GOOGLE_PHOTOS_SCOPES);
}

/**
 * Generate the URL the user must visit to grant access for specific scopes.
 */
export function getAuthUrlForScopes(
  client: OAuth2Client,
  scopes: string[],
): string {
  return client.generateAuthUrl({
    access_type: 'offline', // get a refresh token
    prompt: 'consent', // always show consent screen to get refresh token
    scope: scopes,
    include_granted_scopes: true,
  });
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param client  The OAuth2Client.
 * @param code    The authorization code from the redirect callback.
 * @returns The obtained tokens.
 */
export async function exchangeCode(
  client: OAuth2Client,
  code: string,
): Promise<GoogleTokens> {
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  return credentialsToTokens(tokens);
}

/**
 * Set existing tokens on the client (e.g. loaded from DB).
 */
export function setTokens(client: OAuth2Client, tokens: GoogleTokens): void {
  client.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiryDate,
  });
}

/**
 * Obtain a valid access token, refreshing if necessary.
 * Returns the current (or freshly refreshed) tokens.
 */
export async function getValidAccessToken(
  client: OAuth2Client,
): Promise<GoogleTokens> {
  const { credentials } = await client.refreshAccessToken();
  client.setCredentials(credentials);
  return credentialsToTokens(credentials);
}

/**
 * Check whether the current access token is expired or about to expire.
 * Considers the token expired if it expires within 5 minutes.
 */
export function isTokenExpired(tokens: GoogleTokens): boolean {
  if (!tokens.expiryDate) return true;
  const bufferMs = 5 * 60 * 1000; // 5 minutes
  return Date.now() >= tokens.expiryDate - bufferMs;
}

// ── Internal helpers ────────────────────────────────────────────

function credentialsToTokens(creds: Credentials): GoogleTokens {
  return {
    accessToken: creds.access_token ?? '',
    refreshToken: creds.refresh_token ?? undefined,
    expiryDate: creds.expiry_date ?? undefined,
  };
}
