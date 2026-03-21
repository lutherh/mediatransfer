import type { PrismaClient } from '../generated/prisma/index.js';
import type { CloudCredential } from '../generated/prisma/index.js';
import { getPrismaClient } from './client.js';
import { decryptStringAsync, encryptStringAsync } from '../utils/crypto.js';

export type CreateCredentialInput = {
  name: string;
  provider: string;
  config: string;
};

export type UpdateCredentialInput = {
  name?: string;
  config?: string;
};

export type CredentialSummary = Pick<
  CloudCredential,
  'id' | 'name' | 'provider' | 'createdAt' | 'updatedAt'
>;

async function decryptCredential(credential: CloudCredential): Promise<CloudCredential> {
  return {
    ...credential,
    config: await decryptStringAsync(credential.config),
  };
}

/**
 * Store a new cloud credential.
 */
export async function createCredential(
  input: CreateCredentialInput,
  client?: PrismaClient,
): Promise<CloudCredential> {
  const prisma = client ?? getPrismaClient();
  const encryptedConfig = await encryptStringAsync(input.config);

  const created = await prisma.cloudCredential.create({
    data: {
      name: input.name,
      provider: input.provider,
      config: encryptedConfig,
    },
  });
  return decryptCredential(created);
}

/**
 * Find a credential by ID.
 */
export async function getCredentialById(
  id: string,
  client?: PrismaClient,
): Promise<CloudCredential | null> {
  const prisma = client ?? getPrismaClient();
  const credential = await prisma.cloudCredential.findUnique({ where: { id } });
  return credential ? await decryptCredential(credential) : null;
}

/**
 * List all credentials, optionally filtered by provider.
 */
export async function listCredentials(
  provider?: string,
  client?: PrismaClient,
): Promise<CloudCredential[]> {
  const prisma = client ?? getPrismaClient();
  const credentials = await prisma.cloudCredential.findMany({
    where: provider ? { provider } : undefined,
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(credentials.map(decryptCredential));
}

/**
 * List credential metadata without decrypting sensitive config.
 */
export async function listCredentialSummaries(
  provider?: string,
  client?: PrismaClient,
): Promise<CredentialSummary[]> {
  const prisma = client ?? getPrismaClient();
  return prisma.cloudCredential.findMany({
    where: provider ? { provider } : undefined,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      provider: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Update a credential (name or re-encrypted config).
 */
export async function updateCredential(
  id: string,
  input: UpdateCredentialInput,
  client?: PrismaClient,
): Promise<CloudCredential> {
  const prisma = client ?? getPrismaClient();

  const updated = await prisma.cloudCredential.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.config !== undefined ? { config: await encryptStringAsync(input.config) } : {}),
    },
  });
  return decryptCredential(updated);
}

/**
 * Delete a credential by ID.
 */
export async function deleteCredential(
  id: string,
  client?: PrismaClient,
): Promise<CloudCredential> {
  const prisma = client ?? getPrismaClient();
  return prisma.cloudCredential.delete({ where: { id } });
}
