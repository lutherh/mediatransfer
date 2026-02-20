import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTransferLog, listTransferLogs } from './logs.js';

const mockLog = {
  id: 'log-1',
  jobId: 'job-1',
  level: 'INFO',
  message: 'Transfer job started',
  meta: { totalItems: 2 },
  createdAt: new Date('2026-02-20T00:00:00.000Z'),
};

function createMockPrisma() {
  return {
    transferLog: {
      create: vi.fn().mockResolvedValue(mockLog),
      findMany: vi.fn().mockResolvedValue([mockLog]),
    },
  } as any;
}

describe('db/logs', () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it('creates a transfer log with default level support', async () => {
    const result = await createTransferLog(
      {
        jobId: 'job-1',
        message: 'Transfer job started',
        meta: { totalItems: 2 },
      },
      prisma,
    );

    expect(prisma.transferLog.create).toHaveBeenCalledWith({
      data: {
        jobId: 'job-1',
        level: undefined,
        message: 'Transfer job started',
        meta: { totalItems: 2 },
      },
    });
    expect(result).toEqual(mockLog);
  });

  it('lists transfer logs ordered by creation date ascending', async () => {
    const result = await listTransferLogs('job-1', undefined, prisma);

    expect(prisma.transferLog.findMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      orderBy: { createdAt: 'asc' },
      take: undefined,
    });
    expect(result).toEqual([mockLog]);
  });

  it('supports level filter and limit when listing logs', async () => {
    await listTransferLogs('job-1', { level: 'ERROR', limit: 10 }, prisma);

    expect(prisma.transferLog.findMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', level: 'ERROR' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
  });
});
