import type { GoogleTokens } from '../../providers/google-photos-auth.js';
import { getPrismaClient } from '../../db/client.js';
import { decryptStringAsync, encryptStringAsync } from '../../utils/crypto.js';

let storedTokens: GoogleTokens | null = null;
let initialized = false;
let initializationPromise: Promise<void> | null = null;

const TOKENS_SETTING_KEY = 'google_oauth_tokens';

function getEnvTokens(): GoogleTokens | null {
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  const expiryDateRaw = process.env.GOOGLE_TOKEN_EXPIRY_DATE?.trim();
  const expiryDate = expiryDateRaw ? Number(expiryDateRaw) : undefined;

  if (!accessToken && !refreshToken) {
    return null;
  }

  return {
    accessToken: accessToken ?? '',
    refreshToken: refreshToken && refreshToken.length > 0 ? refreshToken : undefined,
    expiryDate: Number.isFinite(expiryDate) ? expiryDate : undefined,
  };
}

async function persistTokensToDb(tokens: GoogleTokens): Promise<void> {
  const prisma = getPrismaClient();
  const encrypted = await encryptStringAsync(JSON.stringify(tokens));
  await prisma.appSetting.upsert({
    where: { key: TOKENS_SETTING_KEY },
    create: {
      key: TOKENS_SETTING_KEY,
      value: encrypted,
    },
    update: {
      value: encrypted,
    },
  });
}

async function initializeFromEnv(): Promise<void> {
  if (initialized) {
    return;
  }

  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  initializationPromise = (async () => {
    const prisma = getPrismaClient();
    const setting = await prisma.appSetting.findUnique({
      where: { key: TOKENS_SETTING_KEY },
    });

    if (setting) {
      const decrypted = await decryptStringAsync(setting.value);
      storedTokens = JSON.parse(decrypted) as GoogleTokens;
      initialized = true;
      return;
    }

    const envTokens = getEnvTokens();
    if (envTokens) {
      await persistTokensToDb(envTokens);
      storedTokens = envTokens;
    }

    initialized = true;
  })();

  try {
    await initializationPromise;
  } finally {
    initializationPromise = null;
  }
}

export async function getStoredTokens(): Promise<GoogleTokens | null> {
  await initializeFromEnv();
  return storedTokens;
}

export async function setStoredTokens(tokens: GoogleTokens): Promise<void> {
  await initializeFromEnv();

  const existingRefreshToken = storedTokens?.refreshToken;
  const nextTokens: GoogleTokens = {
    ...tokens,
    refreshToken: tokens.refreshToken ?? existingRefreshToken,
  };

  await persistTokensToDb(nextTokens);
  storedTokens = nextTokens;
}

export async function clearStoredTokens(): Promise<void> {
  await initializeFromEnv();
  const prisma = getPrismaClient();
  await prisma.appSetting.deleteMany({ where: { key: TOKENS_SETTING_KEY } });
  storedTokens = null;
}
