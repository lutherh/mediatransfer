import type { GoogleTokens } from '../../providers/google-photos-auth.js';

let storedTokens: GoogleTokens | null = null;
let initialized = false;

function initializeFromEnv(): void {
  if (initialized) {
    return;
  }

  initialized = true;

  const accessToken = process.env.GOOGLE_ACCESS_TOKEN?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  const expiryDateRaw = process.env.GOOGLE_TOKEN_EXPIRY_DATE?.trim();
  const expiryDate = expiryDateRaw ? Number(expiryDateRaw) : undefined;

  if (!accessToken && !refreshToken) {
    return;
  }

  storedTokens = {
    accessToken: accessToken ?? '',
    refreshToken: refreshToken && refreshToken.length > 0 ? refreshToken : undefined,
    expiryDate: Number.isFinite(expiryDate) ? expiryDate : undefined,
  };
}

export function getStoredTokens(): GoogleTokens | null {
  initializeFromEnv();
  return storedTokens;
}

export function setStoredTokens(tokens: GoogleTokens): void {
  initializeFromEnv();

  const existingRefreshToken = storedTokens?.refreshToken;
  storedTokens = {
    ...tokens,
    refreshToken: tokens.refreshToken ?? existingRefreshToken,
  };
}

export function clearStoredTokens(): void {
  initializeFromEnv();
  storedTokens = null;
}
