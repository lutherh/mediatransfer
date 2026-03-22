import type { BulkTransferResult } from '../jobs/bulk-transfer.js';
import type { TransferJob, TransferStatus, CloudCredential, TransferLog, MediaItem } from '../generated/prisma/index.js';
import type { CatalogItem, CatalogObject, CatalogStats, DeleteResult, AlbumsManifest, DuplicateGroup, DeduplicateResult, ThumbnailSize, ThumbnailResult } from '../catalog/scaleway-catalog.js';
import type { Readable } from 'node:stream';
import type { CreateMediaItemInput, ListMediaItemsFilter } from '../db/media-items.js';

export type CredentialSummary = {
  id: string;
  name: string;
  provider: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CredentialsService = {
  create(input: { name: string; provider: string; config: string }): Promise<CloudCredential>;
  list(provider?: string): Promise<CredentialSummary[]>;
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
  listLogs(id: string): Promise<TransferLog[]>;
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
    startIndex?: number;
    totalKeys?: number;
  }): Promise<BulkTransferResult>;
};

export type CatalogService = {
  listPage(input?: { max?: number; token?: string; prefix?: string }): Promise<{ items: CatalogItem[]; nextToken?: string }>;
  listAll(prefix?: string): Promise<CatalogItem[]>;
  listUndated(): Promise<CatalogItem[]>;
  getObject(encodedKey: string, range?: string): Promise<CatalogObject>;
  getObjectBuffer(encodedKey: string, maxBytes?: number): Promise<{ buffer: Buffer; contentType?: string; contentLength?: number }>;
  getStats(): Promise<CatalogStats>;
  getThumbnail(encodedKey: string, size: ThumbnailSize): Promise<ThumbnailResult>;
  findDuplicates(): Promise<DuplicateGroup[]>;
  deduplicateObjects(input?: { dryRun?: boolean }): Promise<DeduplicateResult>;
  deleteObjects(encodedKeys: string[]): Promise<DeleteResult>;
  moveObject(encodedKey: string, newDatePrefix: string): Promise<{ from: string; to: string }>;
  getAlbums(): Promise<AlbumsManifest>;
  saveAlbums(manifest: AlbumsManifest): Promise<void>;
};

export type CloudUsageService = {
  getSummary(): Promise<{
    provider: 'scaleway';
    bucket: string;
    region: string;
    prefix?: string;
    totalObjects: number;
    totalBytes: number;
    measuredAt: string;
  }>;
};

export type UploadService = {
  findByHash(sha256: string): Promise<MediaItem | null>;
  createMediaItem(input: CreateMediaItemInput): Promise<MediaItem>;
  listMediaItems(filter?: ListMediaItemsFilter, limit?: number, offset?: number): Promise<MediaItem[]>;
  countMediaItems(): Promise<number>;
  uploadToStorage(key: string, stream: Readable, contentType?: string): Promise<void>;
};

export type ApiServices = {
  credentials: CredentialsService;
  jobs: JobsService;
  providers: ProvidersService;
  queue: QueueService;
  catalog?: CatalogService;
  cloudUsage?: CloudUsageService;
  uploads?: UploadService;
};
