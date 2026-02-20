import { describe, expect, it } from 'vitest';
import { decryptString, encryptString } from './crypto.js';

describe('utils/crypto', () => {
  const secret = 'a-very-strong-test-secret-12345';

  it('encrypts and decrypts a string roundtrip', () => {
    const plaintext = '{"provider":"scaleway","secretKey":"xyz"}';
    const encrypted = encryptString(plaintext, secret);
    const decrypted = decryptString(encrypted, secret);

    expect(encrypted).not.toBe(plaintext);
    expect(decrypted).toBe(plaintext);
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
