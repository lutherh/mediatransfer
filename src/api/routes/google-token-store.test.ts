import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  appSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
};

vi.mock('../../db/client.js', () => ({
  getPrismaClient: () => prismaMock,
}));

vi.mock('../../utils/crypto.js', () => ({
  encryptStringAsync: vi.fn(async (value: string) => `enc:${value}`),
  decryptStringAsync: vi.fn(async (value: string) => value.replace(/^enc:/, '')),
}));

describe('google-token-store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    prismaMock.appSetting.findUnique.mockResolvedValue(null);
    prismaMock.appSetting.upsert.mockResolvedValue(undefined);
    prismaMock.appSetting.deleteMany.mockResolvedValue({ count: 1 });

    delete process.env.GOOGLE_ACCESS_TOKEN;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    delete process.env.GOOGLE_TOKEN_EXPIRY_DATE;
  });

  it('initializes from env tokens and persists once when db has no value', async () => {
    process.env.GOOGLE_ACCESS_TOKEN = 'access-1';
    process.env.GOOGLE_REFRESH_TOKEN = 'refresh-1';
    process.env.GOOGLE_TOKEN_EXPIRY_DATE = '1700000000000';

    const mod = await import('./google-token-store.js');
    const tokens = await mod.getStoredTokens();

    expect(tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiryDate: 1700000000000,
    });
    expect(prismaMock.appSetting.findUnique).toHaveBeenCalledWith({
      where: { key: 'google_oauth_tokens' },
    });
    expect(prismaMock.appSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it('loads and decrypts tokens from db when setting exists', async () => {
    prismaMock.appSetting.findUnique.mockResolvedValue({
      key: 'google_oauth_tokens',
      value: 'enc:{"accessToken":"db-access","refreshToken":"db-refresh"}',
    });

    const mod = await import('./google-token-store.js');
    const tokens = await mod.getStoredTokens();

    expect(tokens).toEqual({
      accessToken: 'db-access',
      refreshToken: 'db-refresh',
    });
    expect(prismaMock.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('preserves existing refresh token when setStoredTokens gets only access token', async () => {
    const mod = await import('./google-token-store.js');

    await mod.setStoredTokens({
      accessToken: 'first-access',
      refreshToken: 'first-refresh',
      expiryDate: 1,
    });
    await mod.setStoredTokens({
      accessToken: 'next-access',
      expiryDate: 2,
    });

    const tokens = await mod.getStoredTokens();
    expect(tokens).toEqual({
      accessToken: 'next-access',
      refreshToken: 'first-refresh',
      expiryDate: 2,
    });
    expect(prismaMock.appSetting.upsert).toHaveBeenCalledTimes(2);
  });

  it('clears persisted tokens', async () => {
    const mod = await import('./google-token-store.js');
    await mod.setStoredTokens({ accessToken: 'to-clear', refreshToken: 'refresh' });
    await mod.clearStoredTokens();

    const tokens = await mod.getStoredTokens();
    expect(prismaMock.appSetting.deleteMany).toHaveBeenCalledWith({
      where: { key: 'google_oauth_tokens' },
    });
    expect(tokens).toBeNull();
  });
});
