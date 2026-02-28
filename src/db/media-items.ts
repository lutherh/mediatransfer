import type { PrismaClient, MediaItem } from '../generated/prisma/client.js';
import { getPrismaClient } from './client.js';

export type CreateMediaItemInput = {
  filename: string;
  s3Key: string;
  sha256: string;
  size: number;
  contentType: string;
  width?: number;
  height?: number;
  capturedAt?: Date;
  source?: string;
};

export type ListMediaItemsFilter = {
  source?: string;
  capturedAfter?: Date;
  capturedBefore?: Date;
};

/**
 * Create a new media item record.
 */
export async function createMediaItem(
  input: CreateMediaItemInput,
  client?: PrismaClient,
): Promise<MediaItem> {
  const prisma = client ?? getPrismaClient();
  return prisma.mediaItem.create({
    data: {
      filename: input.filename,
      s3Key: input.s3Key,
      sha256: input.sha256,
      size: input.size,
      contentType: input.contentType,
      width: input.width ?? null,
      height: input.height ?? null,
      capturedAt: input.capturedAt ?? null,
      source: input.source ?? 'upload',
    },
  });
}

/**
 * Find a media item by its SHA-256 hash (for deduplication).
 */
export async function findMediaItemByHash(
  sha256: string,
  client?: PrismaClient,
): Promise<MediaItem | null> {
  const prisma = client ?? getPrismaClient();
  return prisma.mediaItem.findFirst({ where: { sha256 } });
}

/**
 * Find a media item by its S3 key.
 */
export async function findMediaItemByKey(
  s3Key: string,
  client?: PrismaClient,
): Promise<MediaItem | null> {
  const prisma = client ?? getPrismaClient();
  return prisma.mediaItem.findUnique({ where: { s3Key } });
}

/**
 * List media items, optionally filtered.
 */
export async function listMediaItems(
  filter?: ListMediaItemsFilter,
  limit = 100,
  offset = 0,
  client?: PrismaClient,
): Promise<MediaItem[]> {
  const prisma = client ?? getPrismaClient();
  return prisma.mediaItem.findMany({
    where: {
      ...(filter?.source && { source: filter.source }),
      ...(filter?.capturedAfter && { capturedAt: { gte: filter.capturedAfter } }),
      ...(filter?.capturedBefore && {
        capturedAt: {
          ...(filter?.capturedAfter ? { gte: filter.capturedAfter } : {}),
          lte: filter.capturedBefore,
        },
      }),
    },
    orderBy: { uploadedAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

/**
 * Count total media items.
 */
export async function countMediaItems(
  client?: PrismaClient,
): Promise<number> {
  const prisma = client ?? getPrismaClient();
  return prisma.mediaItem.count();
}

/**
 * Delete a media item by ID.
 */
export async function deleteMediaItem(
  id: string,
  client?: PrismaClient,
): Promise<MediaItem> {
  const prisma = client ?? getPrismaClient();
  return prisma.mediaItem.delete({ where: { id } });
}
