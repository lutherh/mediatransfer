import { createCipheriv, createDecipheriv, pbkdf2 as pbkdf2Cb, pbkdf2Sync, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2Cb);

const FORMAT_VERSION = 'v1';
const PBKDF2_ITERATIONS = 310000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/**
 * LRU cache for derived keys to avoid re-running PBKDF2 (310K iterations)
 * for the same secret+salt pair. Capped at 64 entries (~2 KB per entry).
 */
const KEY_CACHE_MAX = 64;
const keyCache = new Map<string, Buffer>();

function cacheKey(secret: string, salt: Buffer): string {
  return `${secret}:${salt.toString('base64url')}`;
}

function getCachedKey(secret: string, salt: Buffer): Buffer | undefined {
  return keyCache.get(cacheKey(secret, salt));
}

function setCachedKey(secret: string, salt: Buffer, key: Buffer): void {
  const ck = cacheKey(secret, salt);
  // Evict oldest entry if at capacity
  if (keyCache.size >= KEY_CACHE_MAX) {
    const firstKey = keyCache.keys().next().value;
    if (firstKey !== undefined) keyCache.delete(firstKey);
  }
  keyCache.set(ck, key);
}

function getEncryptionSecret(override?: string): string {
  const secret = override ?? process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('ENCRYPTION_SECRET must be set and at least 16 characters long');
  }
  return secret;
}

/**
 * Derive key synchronously (kept for backwards compatibility).
 * Prefer `deriveKeyAsync` for non-blocking operation.
 */
function deriveKey(secret: string, salt: Buffer): Buffer {
  const cached = getCachedKey(secret, salt);
  if (cached) return cached;
  const key = pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
  setCachedKey(secret, salt, key);
  return key;
}

/**
 * Derive key asynchronously — does NOT block the event loop.
 */
async function deriveKeyAsync(secret: string, salt: Buffer): Promise<Buffer> {
  const cached = getCachedKey(secret, salt);
  if (cached) return cached;
  const key = await pbkdf2Async(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
  setCachedKey(secret, salt, key);
  return key;
}

/**
 * Encrypt a string asynchronously (non-blocking PBKDF2).
 */
export async function encryptStringAsync(plaintext: string, secretOverride?: string): Promise<string> {
  const secret = getEncryptionSecret(secretOverride);
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await deriveKeyAsync(secret, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    salt.toString('base64url'),
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a string asynchronously (non-blocking PBKDF2).
 */
export async function decryptStringAsync(payload: string, secretOverride?: string): Promise<string> {
  const secret = getEncryptionSecret(secretOverride);
  const parts = payload.split('.');

  if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
    throw new Error('Invalid encrypted payload format');
  }

  const [, saltPart, ivPart, tagPart, dataPart] = parts;

  try {
    const salt = Buffer.from(saltPart, 'base64url');
    const iv = Buffer.from(ivPart, 'base64url');
    const authTag = Buffer.from(tagPart, 'base64url');
    const encrypted = Buffer.from(dataPart, 'base64url');

    const key = await deriveKeyAsync(secret, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Failed to decrypt payload');
  }
}

/**
 * Encrypt a string synchronously (blocks event loop — use `encryptStringAsync` when possible).
 */
export function encryptString(plaintext: string, secretOverride?: string): string {
  const secret = getEncryptionSecret(secretOverride);
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(secret, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    salt.toString('base64url'),
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a string synchronously (blocks event loop — use `decryptStringAsync` when possible).
 */
export function decryptString(payload: string, secretOverride?: string): string {
  const secret = getEncryptionSecret(secretOverride);
  const parts = payload.split('.');

  if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
    throw new Error('Invalid encrypted payload format');
  }

  const [, saltPart, ivPart, tagPart, dataPart] = parts;

  try {
    const salt = Buffer.from(saltPart, 'base64url');
    const iv = Buffer.from(ivPart, 'base64url');
    const authTag = Buffer.from(tagPart, 'base64url');
    const encrypted = Buffer.from(dataPart, 'base64url');

    const key = deriveKey(secret, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Failed to decrypt payload');
  }
}

/** Clear the derived-key cache (useful for tests). */
export function clearKeyCache(): void {
  keyCache.clear();
}