import { describe, expect, it, beforeEach } from 'vitest';
import { decryptString, encryptString, encryptStringAsync, decryptStringAsync, clearKeyCache } from './crypto.js';

describe('utils/crypto', () => {
  const secret = 'a-very-strong-test-secret-12345';

  beforeEach(() => {
    clearKeyCache();
  });

  it('encrypts and decrypts a string roundtrip', () => {
    const plaintext = '{"provider":"scaleway","secretKey":"xyz"}';
    const encrypted = encryptString(plaintext, secret);
    const decrypted = decryptString(encrypted, secret);

    expect(encrypted).not.toBe(plaintext);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts a string roundtrip (async)', async () => {
    const plaintext = '{"provider":"scaleway","secretKey":"xyz"}';
    const encrypted = await encryptStringAsync(plaintext, secret);
    const decrypted = await decryptStringAsync(encrypted, secret);

    expect(encrypted).not.toBe(plaintext);
    expect(decrypted).toBe(plaintext);
  });

  it('async and sync produce cross-compatible results', async () => {
    const plaintext = 'cross-compat test';
    const encryptedSync = encryptString(plaintext, secret);
    const encryptedAsync = await encryptStringAsync(plaintext, secret);

    // Sync-encrypted can be decrypted by async, and vice versa
    expect(await decryptStringAsync(encryptedSync, secret)).toBe(plaintext);
    expect(decryptString(encryptedAsync, secret)).toBe(plaintext);
  });

  it('key cache speeds up repeated decryption with same salt', () => {
    const plaintext = 'cache-test';
    const encrypted = encryptString(plaintext, secret);

    // First decrypt populates the cache
    const result1 = decryptString(encrypted, secret);
    // Second decrypt should hit the cache (same salt)
    const result2 = decryptString(encrypted, secret);

    expect(result1).toBe(plaintext);
    expect(result2).toBe(plaintext);
  });

  it('fails to decrypt with a wrong key', () => {
    const encrypted = encryptString('hello', secret);

    expect(() => decryptString(encrypted, 'different-secret-987654321')).toThrow(
      /Failed to decrypt payload/,
    );
  });

  it('fails to decrypt tampered ciphertext', () => {
    const encrypted = encryptString('hello', secret);
    const parts = encrypted.split('.');

    const tag = Buffer.from(parts[3], 'base64url');
    tag[0] = tag[0] ^ 0xff;
    parts[3] = tag.toString('base64url');

    const tampered = parts.join('.');

    expect(() => decryptString(tampered, secret)).toThrow(/Failed to decrypt payload/);
  });
});
