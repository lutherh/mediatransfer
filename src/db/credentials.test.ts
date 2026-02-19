import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCredential,
  getCredentialById,
  listCredentials,
  updateCredential,
  deleteCredential,
} from './credentials.js';
import type { CreateCredentialInput, UpdateCredentialInput } from './credentials.js';

// ── Mock Prisma client ────────────────────────────────────────

const mockCredential = {
  id: 'cred-1',
  name: 'My AWS Prod',
  provider: 's3',
  config: 'encrypted-blob-here',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

function createMockPrisma() {
  return {
    cloudCredential: {
      create: vi.fn().mockResolvedValue(mockCredential),
      findUnique: vi.fn().mockResolvedValue(mockCredential),
      findMany: vi.fn().mockResolvedValue([mockCredential]),
      update: vi.fn().mockResolvedValue({ ...mockCredential, name: 'Renamed' }),
      delete: vi.fn().mockResolvedValue(mockCredential),
    },
  } as any;
}

describe('db/credentials', () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  // ── createCredential ──────────────────────────────────────

  describe('createCredential', () => {
    it('should call create with correct data', async () => {
      const input: CreateCredentialInput = {
        name: 'My AWS Prod',
        provider: 's3',
        config: 'encrypted-blob-here',
      };

      const result = await createCredential(input, prisma);

      expect(prisma.cloudCredential.create).toHaveBeenCalledWith({
        data: {
          name: 'My AWS Prod',
          provider: 's3',
          config: 'encrypted-blob-here',
        },
      });
      expect(result).toEqual(mockCredential);
    });
  });

  // ── getCredentialById ─────────────────────────────────────

  describe('getCredentialById', () => {
    it('should call findUnique with the given id', async () => {
      const result = await getCredentialById('cred-1', prisma);

      expect(prisma.cloudCredential.findUnique).toHaveBeenCalledWith({
        where: { id: 'cred-1' },
      });
      expect(result).toEqual(mockCredential);
    });

    it('should return null when credential is not found', async () => {
      prisma.cloudCredential.findUnique.mockResolvedValue(null);

      const result = await getCredentialById('nonexistent', prisma);

      expect(result).toBeNull();
    });
  });

  // ── listCredentials ───────────────────────────────────────

  describe('listCredentials', () => {
    it('should return all credentials when no provider filter is given', async () => {
      const result = await listCredentials(undefined, prisma);

      expect(prisma.cloudCredential.findMany).toHaveBeenCalledWith({
        where: undefined,
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual([mockCredential]);
    });

    it('should filter by provider', async () => {
      await listCredentials('s3', prisma);

      expect(prisma.cloudCredential.findMany).toHaveBeenCalledWith({
        where: { provider: 's3' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  // ── updateCredential ──────────────────────────────────────

  describe('updateCredential', () => {
    it('should call update with correct params', async () => {
      const input: UpdateCredentialInput = { name: 'Renamed' };

      const result = await updateCredential('cred-1', input, prisma);

      expect(prisma.cloudCredential.update).toHaveBeenCalledWith({
        where: { id: 'cred-1' },
        data: { name: 'Renamed' },
      });
      expect(result.name).toBe('Renamed');
    });

    it('should allow updating config', async () => {
      const input: UpdateCredentialInput = { config: 'new-encrypted-blob' };

      await updateCredential('cred-1', input, prisma);

      expect(prisma.cloudCredential.update).toHaveBeenCalledWith({
        where: { id: 'cred-1' },
        data: { config: 'new-encrypted-blob' },
      });
    });
  });

  // ── deleteCredential ──────────────────────────────────────

  describe('deleteCredential', () => {
    it('should call delete with the given id', async () => {
      const result = await deleteCredential('cred-1', prisma);

      expect(prisma.cloudCredential.delete).toHaveBeenCalledWith({
        where: { id: 'cred-1' },
      });
      expect(result).toEqual(mockCredential);
    });
  });
});
