import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 'v1';
const PBKDF2_ITERATIONS = 310000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

function getEncryptionSecret(override?: string): string {
  const secret = override ?? process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('ENCRYPTION_SECRET must be set and at least 16 characters long');
  }
  return secret;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  return pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
}

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