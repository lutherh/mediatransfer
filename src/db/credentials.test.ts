import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCredential,
  getCredentialById,
  listCredentials,
  listCredentialSummaries,
  updateCredential,
  deleteCredential,
} from './credentials.js';
import type { CreateCredentialInput, UpdateCredentialInput } from './credentials.js';
import { encryptString } from '../utils/crypto.js';

const TEST_SECRET = 'unit-test-encryption-secret-123';

// ── Mock Prisma client ────────────────────────────────────────

const mockCredential = {
  id: 'cred-1',
  name: 'My AWS Prod',
  provider: 's3',
  config: encryptString('{"accessKey":"abc"}', TEST_SECRET),
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
    process.env.ENCRYPTION_SECRET = TEST_SECRET;
    prisma = createMockPrisma();
  });

  // ── createCredential ──────────────────────────────────────

  describe('createCredential', () => {
    it('should call create with correct data', async () => {
      const input: CreateCredentialInput = {
        name: 'My AWS Prod',
        provider: 's3',
        config: '{"accessKey":"abc"}',
      };

      const result = await createCredential(input, prisma);

      const createCall = prisma.cloudCredential.create.mock.calls[0][0];
      expect(createCall.data.name).toBe('My AWS Prod');
      expect(createCall.data.provider).toBe('s3');
      expect(createCall.data.config).toBeTypeOf('string');
      expect(createCall.data.config).not.toBe('{"accessKey":"abc"}');
      expect(result.config).toBe('{"accessKey":"abc"}');
    });
  });

  // ── getCredentialById ─────────────────────────────────────

  describe('getCredentialById', () => {
    it('should call findUnique with the given id', async () => {
      const result = await getCredentialById('cred-1', prisma);

      expect(prisma.cloudCredential.findUnique).toHaveBeenCalledWith({
        where: { id: 'cred-1' },
      });
      expect(result?.config).toBe('{"accessKey":"abc"}');
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
      expect(result).toHaveLength(1);
      expect(result[0].config).toBe('{"accessKey":"abc"}');
    });

    it('should filter by provider', async () => {
      await listCredentials('s3', prisma);

      expect(prisma.cloudCredential.findMany).toHaveBeenCalledWith({
        where: { provider: 's3' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should list credential summaries without selecting config', async () => {
      await listCredentialSummaries(undefined, prisma);

      expect(prisma.cloudCredential.findMany).toHaveBeenCalledWith({
        where: undefined,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          provider: true,
          createdAt: true,
          updatedAt: true,
        },
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
      expect(result.config).toBe('{"accessKey":"abc"}');
    });

    it('should allow updating config', async () => {
      const input: UpdateCredentialInput = { config: '{"accessKey":"def"}' };

      prisma.cloudCredential.update.mockImplementation(async (args: any) => ({
        ...mockCredential,
        config: args.data.config,
      }));

      await updateCredential('cred-1', input, prisma);

      const updateCall = prisma.cloudCredential.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'cred-1' });
      expect(updateCall.data.config).toBeTypeOf('string');
      expect(updateCall.data.config).not.toBe('{"accessKey":"def"}');
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
