import type { PrismaClient } from '../generated/prisma/client.js';
import type { TransferJob, TransferStatus } from '../generated/prisma/client.js';
import type { InputJsonValue } from '@prisma/client/runtime/client';
import { getPrismaClient } from './client.js';

export type CreateJobInput = {
  sourceProvider: string;
  destProvider: string;
  sourceConfig?: InputJsonValue;
  destConfig?: InputJsonValue;
  keys?: string[];
};

export type UpdateJobInput = {
  status?: TransferStatus;
  progress?: number;
  errorMessage?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
};

export type ListJobsFilter = {
  status?: TransferStatus;
  sourceProvider?: string;
  destProvider?: string;
};

/**
 * Create a new transfer job.
 */
export async function createJob(
  input: CreateJobInput,
  client?: PrismaClient,
): Promise<TransferJob> {
  const prisma = client ?? getPrismaClient();
  return prisma.transferJob.create({
    data: {
      sourceProvider: input.sourceProvider,
      destProvider: input.destProvider,
      sourceConfig: input.sourceConfig ?? undefined,
      destConfig: input.destConfig ?? undefined,
      keys: input.keys ?? [],
    },
  });
}

/**
 * Find a transfer job by ID.
 */
export async function getJobById(
  id: string,
  client?: PrismaClient,
): Promise<TransferJob | null> {
  const prisma = client ?? getPrismaClient();
  return prisma.transferJob.findUnique({ where: { id } });
}

/**
 * List transfer jobs, optionally filtered.
 */
export async function listJobs(
  filter?: ListJobsFilter,
  client?: PrismaClient,
): Promise<TransferJob[]> {
  const prisma = client ?? getPrismaClient();
  return prisma.transferJob.findMany({
    where: {
      ...(filter?.status && { status: filter.status }),
      ...(filter?.sourceProvider && { sourceProvider: filter.sourceProvider }),
      ...(filter?.destProvider && { destProvider: filter.destProvider }),
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Update a transfer job.
 */
export async function updateJob(
  id: string,
  input: UpdateJobInput,
  client?: PrismaClient,
): Promise<TransferJob> {
  const prisma = client ?? getPrismaClient();
  return prisma.transferJob.update({
    where: { id },
    data: input,
  });
}

/**
 * Delete a transfer job by ID (cascades to logs).
 */
export async function deleteJob(
  id: string,
  client?: PrismaClient,
): Promise<TransferJob> {
  const prisma = client ?? getPrismaClient();
  return prisma.transferJob.delete({ where: { id } });
}
