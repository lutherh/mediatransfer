import type { PrismaClient } from '../generated/prisma/client.js';
import type { TransferLog, LogLevel } from '../generated/prisma/client.js';
import type { InputJsonValue } from '@prisma/client/runtime/client';
import { getPrismaClient } from './client.js';

export type CreateTransferLogInput = {
  jobId: string;
  level?: LogLevel;
  message: string;
  meta?: InputJsonValue;
};

export type ListTransferLogsFilter = {
  level?: LogLevel;
  limit?: number;
};

/**
 * Create a transfer log entry.
 */
export async function createTransferLog(
  input: CreateTransferLogInput,
  client?: PrismaClient,
): Promise<TransferLog> {
  const prisma = client ?? getPrismaClient();
  return prisma.transferLog.create({
    data: {
      jobId: input.jobId,
      level: input.level,
      message: input.message,
      meta: input.meta,
    },
  });
}

/**
 * List logs for a transfer job.
 */
export async function listTransferLogs(
  jobId: string,
  filter?: ListTransferLogsFilter,
  client?: PrismaClient,
): Promise<TransferLog[]> {
  const prisma = client ?? getPrismaClient();
  return prisma.transferLog.findMany({
    where: {
      jobId,
      ...(filter?.level ? { level: filter.level } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: filter?.limit,
  });
}