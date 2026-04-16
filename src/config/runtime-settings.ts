/**
 * Runtime settings — reads/writes encrypted key-value pairs from the
 * `app_settings` DB table.  Used for integration configs that can be
 * updated from the Setup Wizard UI without restarting the server.
 */
import { getPrismaClient } from '../db/client.js';
import { decryptStringAsync, encryptStringAsync } from '../utils/crypto.js';

/**
 * Read and decrypt a setting by key.
 * Returns `null` if the key does not exist.
 */
export async function getRuntimeSettings<T>(key: string): Promise<T | null> {
  const prisma = getPrismaClient();
  const setting = await prisma.appSetting.findUnique({ where: { key } });
  if (!setting) return null;
  const json = await decryptStringAsync(setting.value);
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Failed to parse setting '${key}': stored value is not valid JSON`);
  }
}

/**
 * Encrypt and upsert a setting by key.
 */
export async function setRuntimeSettings<T>(key: string, value: T): Promise<void> {
  const prisma = getPrismaClient();
  const encrypted = await encryptStringAsync(JSON.stringify(value));
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: encrypted },
    update: { value: encrypted },
  });
}

/**
 * Delete a setting by key (no-op if not present).
 */
export async function deleteRuntimeSettings(key: string): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.appSetting.deleteMany({ where: { key } });
}
