import type { BulkTransferResult } from '../jobs/bulk-transfer.js';
import type { TransferJob, TransferStatus, CloudCredential } from '../generated/prisma/client.js';

export type CredentialsService = {
  create(input: { name: string; provider: string; config: string }): Promise<CloudCredential>;
  list(provider?: string): Promise<CloudCredential[]>;
  delete(id: string): Promise<CloudCredential>;
};

export type JobsService = {
  create(input: {
    sourceProvider: string;
    destProvider: string;
    sourceConfig?: Record<string, unknown>;
    destConfig?: Record<string, unknown>;
    keys?: string[];
  }): Promise<TransferJob>;
  list(filter?: {
    status?: TransferStatus;
    sourceProvider?: string;
    destProvider?: string;
  }): Promise<TransferJob[]>;
  get(id: string): Promise<TransferJob | null>;
  update(
    id: string,
    input: { status?: TransferStatus; progress?: number; errorMessage?: string | null },
  ): Promise<TransferJob>;
  delete(id: string): Promise<TransferJob>;
};

export type ProvidersService = {
  listNames(): string[];
  testConnection(name: string, config: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  listObjects(name: string, config: Record<string, unknown>, opts?: { prefix?: string; maxResults?: number }): Promise<Array<{ key: string; size: number; lastModified: Date; contentType?: string }>>;
};

export type QueueService = {
  enqueueBulk(input: {
    transferJobId: string;
    sourceProvider: string;
    destProvider: string;
    keys?: string[];
    prefix?: string;
    sourceConfig?: Record<string, unknown>;
    destConfig?: Record<string, unknown>;
  }): Promise<BulkTransferResult>;
};

export type ApiServices = {
  credentials: CredentialsService;
  jobs: JobsService;
  providers: ProvidersService;
  queue: QueueService;
};
