import type { PrismaClient } from '../generated/prisma/client.js';
import type { CloudCredential } from '../generated/prisma/client.js';
import { getPrismaClient } from './client.js';

export type CreateCredentialInput = {
  name: string;
  provider: string;
  config: string; // Already encrypted by the caller
};

export type UpdateCredentialInput = {
  name?: string;
  config?: string; // Already encrypted by the caller
};

/**
 * Store a new cloud credential.
 * The `config` field should already be encrypted before calling this.
 */
export async function createCredential(
  input: CreateCredentialInput,
  client?: PrismaClient,
): Promise<CloudCredential> {
  const prisma = client ?? getPrismaClient();
  return prisma.cloudCredential.create({
    data: {
      name: input.name,
      provider: input.provider,
      config: input.config,
    },
  });
}

/**
 * Find a credential by ID.
 */
export async function getCredentialById(
  id: string,
  client?: PrismaClient,
): Promise<CloudCredential | null> {
  const prisma = client ?? getPrismaClient();
  return prisma.cloudCredential.findUnique({ where: { id } });
}

/**
 * List all credentials, optionally filtered by provider.
 */
export async function listCredentials(
  provider?: string,
  client?: PrismaClient,
): Promise<CloudCredential[]> {
  const prisma = client ?? getPrismaClient();
  return prisma.cloudCredential.findMany({
    where: provider ? { provider } : undefined,
    orderBy: { createdAt: 'desc' },
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
  return prisma.cloudCredential.update({
    where: { id },
    data: input,
  });
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
