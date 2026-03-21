import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createJob, getJobById, listJobs, updateJob, deleteJob } from './jobs.js';
import type { CreateJobInput, UpdateJobInput } from './jobs.js';
import { TransferStatus } from '../generated/prisma/index.js';

// ── Mock Prisma client ────────────────────────────────────────

const mockJob = {
  id: 'job-1',
  status: TransferStatus.PENDING,
  sourceProvider: 's3',
  destProvider: 'gcs',
  sourceConfig: { bucket: 'src-bucket' },
  destConfig: { bucket: 'dst-bucket' },
  keys: ['photo1.jpg'],
  progress: 0,
  errorMessage: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

function createMockPrisma() {
  return {
    transferJob: {
      create: vi.fn().mockResolvedValue(mockJob),
      findUnique: vi.fn().mockResolvedValue(mockJob),
      findMany: vi.fn().mockResolvedValue([mockJob]),
      update: vi.fn().mockResolvedValue({ ...mockJob, status: TransferStatus.IN_PROGRESS }),
      delete: vi.fn().mockResolvedValue(mockJob),
    },
  } as any;
}

describe('db/jobs', () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  // ── createJob ─────────────────────────────────────────────

  describe('createJob', () => {
    it('should call prisma.transferJob.create with correct data', async () => {
      const input: CreateJobInput = {
        sourceProvider: 's3',
        destProvider: 'gcs',
        sourceConfig: { bucket: 'src-bucket' },
        destConfig: { bucket: 'dst-bucket' },
        keys: ['photo1.jpg'],
      };

      const result = await createJob(input, prisma);

      expect(prisma.transferJob.create).toHaveBeenCalledWith({
        data: {
          sourceProvider: 's3',
          destProvider: 'gcs',
          sourceConfig: { bucket: 'src-bucket' },
          destConfig: { bucket: 'dst-bucket' },
          keys: ['photo1.jpg'],
        },
      });
      expect(result).toEqual(mockJob);
    });

    it('should default keys to empty array when not provided', async () => {
      const input: CreateJobInput = {
        sourceProvider: 's3',
        destProvider: 'gcs',
      };

      await createJob(input, prisma);

      expect(prisma.transferJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ keys: [] }),
      });
    });
  });

  // ── getJobById ────────────────────────────────────────────

  describe('getJobById', () => {
    it('should call findUnique with the given id', async () => {
      const result = await getJobById('job-1', prisma);

      expect(prisma.transferJob.findUnique).toHaveBeenCalledWith({
        where: { id: 'job-1' },
      });
      expect(result).toEqual(mockJob);
    });

    it('should return null when job is not found', async () => {
      prisma.transferJob.findUnique.mockResolvedValue(null);

      const result = await getJobById('nonexistent', prisma);

      expect(result).toBeNull();
    });
  });

  // ── listJobs ──────────────────────────────────────────────

  describe('listJobs', () => {
    it('should return all jobs when no filter is given', async () => {
      const result = await listJobs(undefined, prisma);

      expect(prisma.transferJob.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual([mockJob]);
    });

    it('should filter by status', async () => {
      await listJobs({ status: TransferStatus.PENDING }, prisma);

      expect(prisma.transferJob.findMany).toHaveBeenCalledWith({
        where: { status: TransferStatus.PENDING },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should filter by sourceProvider', async () => {
      await listJobs({ sourceProvider: 's3' }, prisma);

      expect(prisma.transferJob.findMany).toHaveBeenCalledWith({
        where: { sourceProvider: 's3' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  // ── updateJob ─────────────────────────────────────────────

  describe('updateJob', () => {
    it('should call update with correct params', async () => {
      const input: UpdateJobInput = {
        status: TransferStatus.IN_PROGRESS,
        progress: 0.5,
      };

      const result = await updateJob('job-1', input, prisma);

      expect(prisma.transferJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: input,
      });
      expect(result.status).toBe(TransferStatus.IN_PROGRESS);
    });
  });

  // ── deleteJob ─────────────────────────────────────────────

  describe('deleteJob', () => {
    it('should call delete with the given id', async () => {
      const result = await deleteJob('job-1', prisma);

      expect(prisma.transferJob.delete).toHaveBeenCalledWith({
        where: { id: 'job-1' },
      });
      expect(result).toEqual(mockJob);
    });
  });
});
