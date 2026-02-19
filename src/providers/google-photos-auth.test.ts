import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuth2Client, Credentials } from 'google-auth-library';
import {
  createOAuth2Client,
  getAuthUrl,
  getAuthUrlForScopes,
  exchangeCode,
  setTokens,
  getValidAccessToken,
  isTokenExpired,
  GOOGLE_PHOTOS_SCOPES,
  GOOGLE_PHOTOS_READONLY_SCOPE,
  GOOGLE_PHOTOS_APPENDONLY_SCOPE,
  GOOGLE_PHOTOS_PICKER_SCOPE,
  type GoogleAuthConfig,
  type GoogleTokens,
} from './google-photos-auth.js';

// ── Helpers ────────────────────────────────────────────────────

const testConfig: GoogleAuthConfig = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:3000/auth/google/callback',
};

function createMockOAuth2Client() {
  return {
    generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?mock'),
    getToken: vi.fn().mockResolvedValue({
      tokens: {
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expiry_date: Date.now() + 3600_000,
      } satisfies Credentials,
    }),
    setCredentials: vi.fn(),
    refreshAccessToken: vi.fn().mockResolvedValue({
      credentials: {
        access_token: 'refreshed-access-token',
        refresh_token: 'mock-refresh-token',
        expiry_date: Date.now() + 3600_000,
      } satisfies Credentials,
    }),
  } as unknown as OAuth2Client;
}

// ── Tests ──────────────────────────────────────────────────────

describe('google-photos-auth', () => {
  // ── Scopes ────────────────────────────────────────────

  describe('scopes', () => {
    it('should export the readonly scope', () => {
      expect(GOOGLE_PHOTOS_READONLY_SCOPE).toBe(
        'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
      );
    });

    it('should include readonly scope in GOOGLE_PHOTOS_SCOPES', () => {
      expect(GOOGLE_PHOTOS_SCOPES).toContain(GOOGLE_PHOTOS_READONLY_SCOPE);
    });

    it('should export appendonly scope', () => {
      expect(GOOGLE_PHOTOS_APPENDONLY_SCOPE).toBe(
        'https://www.googleapis.com/auth/photoslibrary.appendonly',
      );
    });

    it('should export picker scope', () => {
      expect(GOOGLE_PHOTOS_PICKER_SCOPE).toBe(
        'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
      );
    });
  });

  // ── createOAuth2Client ────────────────────────────────

  describe('createOAuth2Client', () => {
    it('should create an OAuth2Client instance', () => {
      const client = createOAuth2Client(testConfig);
      expect(client).toBeDefined();
      // OAuth2Client is a class from google-auth-library
      expect(typeof client.generateAuthUrl).toBe('function');
      expect(typeof client.getToken).toBe('function');
    });
  });

  // ── getAuthUrl ────────────────────────────────────────

  describe('getAuthUrl', () => {
    it('should call generateAuthUrl with correct options', () => {
      const mockClient = createMockOAuth2Client();
      const url = getAuthUrl(mockClient);

      expect(mockClient.generateAuthUrl).toHaveBeenCalledWith({
        access_type: 'offline',
        prompt: 'consent',
        scope: GOOGLE_PHOTOS_SCOPES,
        include_granted_scopes: true,
      });
      expect(url).toContain('https://accounts.google.com');
    });

    it('should support custom scopes via getAuthUrlForScopes', () => {
      const mockClient = createMockOAuth2Client();
      const customScope = ['https://www.googleapis.com/auth/photospicker.mediaitems.readonly'];
      const url = getAuthUrlForScopes(mockClient, customScope);

      expect(mockClient.generateAuthUrl).toHaveBeenCalledWith({
        access_type: 'offline',
        prompt: 'consent',
        scope: customScope,
        include_granted_scopes: true,
      });
      expect(url).toContain('https://accounts.google.com');
    });
  });

  // ── exchangeCode ──────────────────────────────────────

  describe('exchangeCode', () => {
    it('should exchange auth code for tokens', async () => {
      const mockClient = createMockOAuth2Client();
      const tokens = await exchangeCode(mockClient, 'test-auth-code');

      expect(mockClient.getToken).toHaveBeenCalledWith('test-auth-code');
      expect(mockClient.setCredentials).toHaveBeenCalled();
      expect(tokens.accessToken).toBe('mock-access-token');
      expect(tokens.refreshToken).toBe('mock-refresh-token');
      expect(tokens.expiryDate).toBeDefined();
    });

    it('should handle missing refresh token', async () => {
      const mockClient = createMockOAuth2Client();
      (mockClient.getToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        tokens: {
          access_token: 'access-only',
          refresh_token: null,
          expiry_date: Date.now() + 3600_000,
        },
      });

      const tokens = await exchangeCode(mockClient, 'code');
      expect(tokens.accessToken).toBe('access-only');
      expect(tokens.refreshToken).toBeUndefined();
    });

    it('should propagate errors from getToken', async () => {
      const mockClient = createMockOAuth2Client();
      (mockClient.getToken as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('invalid_grant'),
      );

      await expect(exchangeCode(mockClient, 'bad-code')).rejects.toThrow(
        'invalid_grant',
      );
    });
  });

  // ── setTokens ─────────────────────────────────────────

  describe('setTokens', () => {
    it('should set credentials on the client', () => {
      const mockClient = createMockOAuth2Client();
      const tokens: GoogleTokens = {
        accessToken: 'my-access',
        refreshToken: 'my-refresh',
        expiryDate: 1700000000000,
      };

      setTokens(mockClient, tokens);

      expect(mockClient.setCredentials).toHaveBeenCalledWith({
        access_token: 'my-access',
        refresh_token: 'my-refresh',
        expiry_date: 1700000000000,
      });
    });

    it('should handle tokens without refresh token', () => {
      const mockClient = createMockOAuth2Client();
      const tokens: GoogleTokens = {
        accessToken: 'access-only',
      };

      setTokens(mockClient, tokens);

      expect(mockClient.setCredentials).toHaveBeenCalledWith({
        access_token: 'access-only',
        refresh_token: undefined,
        expiry_date: undefined,
      });
    });
  });

  // ── getValidAccessToken ───────────────────────────────

  describe('getValidAccessToken', () => {
    it('should refresh and return new tokens', async () => {
      const mockClient = createMockOAuth2Client();
      const tokens = await getValidAccessToken(mockClient);

      expect(mockClient.refreshAccessToken).toHaveBeenCalled();
      expect(mockClient.setCredentials).toHaveBeenCalled();
      expect(tokens.accessToken).toBe('refreshed-access-token');
    });

    it('should propagate refresh errors', async () => {
      const mockClient = createMockOAuth2Client();
      (mockClient.refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Token has been revoked'),
      );

      await expect(getValidAccessToken(mockClient)).rejects.toThrow(
        'Token has been revoked',
      );
    });
  });

  // ── isTokenExpired ────────────────────────────────────

  describe('isTokenExpired', () => {
    it('should return true when no expiryDate is set', () => {
      expect(isTokenExpired({ accessToken: 'tok' })).toBe(true);
    });

    it('should return true when token is already expired', () => {
      expect(
        isTokenExpired({
          accessToken: 'tok',
          expiryDate: Date.now() - 1000,
        }),
      ).toBe(true);
    });

    it('should return true when token expires within 5 minutes', () => {
      expect(
        isTokenExpired({
          accessToken: 'tok',
          expiryDate: Date.now() + 2 * 60 * 1000, // 2 min from now
        }),
      ).toBe(true);
    });

    it('should return false when token has plenty of time left', () => {
      expect(
        isTokenExpired({
          accessToken: 'tok',
          expiryDate: Date.now() + 30 * 60 * 1000, // 30 min from now
        }),
      ).toBe(false);
    });
  });
});
